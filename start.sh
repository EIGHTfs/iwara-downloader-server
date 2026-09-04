#!/usr/bin/env bash
# ============================================================
# POSIX 启停脚本（Linux / 群晖 / macOS 共用）
# 用法：
#   ./start.sh start [--port PORT]
#   ./start.sh restart [--port PORT]   # 默认命令
#   ./start.sh stop
#   ./start.sh status
#   ./start.sh --port PORT             # 兼容旧用法（等价 restart）
#   ./start.sh --set-password "新密码"
# PID：项目根 / 项目全称.pid（见 pid-file-at-project-root）
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="$(basename "$ROOT")"
SERVER_DIR="$ROOT/server"
PID_FILE="$ROOT/${PROJECT_NAME}.pid"
LOG_FILE="$SERVER_DIR/server.log"
DEFAULT_PORT="${DEFAULT_PORT:-8643}"

# 旧 PID 位置：stop 仍读，避免升级后漏杀；新进程只写 PID_FILE
legacy_pid_files() {
  printf '%s\n' \
    "$SERVER_DIR/app.pid" \
    "$SERVER_DIR/${PROJECT_NAME}.pid" \
    "$SERVER_DIR/gbmd.pid" \
    "/tmp/gbmd.pid" \
    "/tmp/gbmd-macos.pid" \
    "/tmp/${PROJECT_NAME}.pid"
}

export PATH="$ROOT/tool/node/bin:/usr/local/bin:/opt/homebrew/bin:/opt/node/bin:/var/packages/Node.js_v24/target/usr/local/bin:/var/packages/Node.js_v22/target/usr/local/bin:/var/packages/Node.js_v20/target/usr/local/bin:$PATH"
export FFMPEG="${FFMPEG:-$ROOT/tool/ffmpeg}"

find_node() {
  local c
  for c in \
    "$ROOT/tool/node/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /opt/node/bin/node \
    /var/packages/Node.js_v24/target/usr/local/bin/node \
    /var/packages/Node.js_v22/target/usr/local/bin/node \
    /var/packages/Node.js_v20/target/usr/local/bin/node \
    node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; return 0; fi
    if command -v "$c" >/dev/null 2>&1; then NODE_BIN="$(command -v "$c")"; return 0; fi
  done
  local nvm
  for nvm in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nvm" ]; then NODE_BIN="$nvm"; return 0; fi
  done
  return 1
}

if ! find_node; then
  echo "❌ 找不到 node。请安装 Node.js，或把官方二进制解压到 tool/node/"
  exit 1
fi
echo "使用 Node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"

config_port() {
  "$NODE_BIN" -e "try{const c=require(process.argv[1]);console.log(c.port||$DEFAULT_PORT)}catch(e){console.log($DEFAULT_PORT)}" "$SERVER_DIR/config.json" 2>/dev/null || echo "$DEFAULT_PORT"
}

pid_alive() {
  local p="$1"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

read_pid_file() {
  local f="$1"
  [ -f "$f" ] && [ -s "$f" ] || return 1
  tr -d ' \t\r\n' < "$f"
}

collect_live_pids() {
  local f p seen=" "
  for f in "$PID_FILE" $(legacy_pid_files); do
    p="$(read_pid_file "$f" 2>/dev/null || true)"
    if pid_alive "$p"; then
      case "$seen" in
        *" $p "*) ;;
        *) seen="$seen$p "; printf '%s\n' "$p" ;;
      esac
    fi
  done
}

start_server() {
  local port_opt=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port_opt="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  local port="${port_opt:-$(config_port)}"
  local live
  live="$(collect_live_pids | head -n 1 || true)"
  if [ -n "$live" ]; then
    echo "⚠️  已在运行 (PID $live, 端口 $port)。如需重启: ./start.sh restart"
    return 1
  fi
  rm -f "$PID_FILE"
  mkdir -p "$SERVER_DIR"
  cd "$SERVER_DIR" || exit 1
  local cmd=("$NODE_BIN" boot.cjs)
  if [ -n "$port_opt" ]; then
    export PORT="$port_opt"
    cmd+=("--port" "$port_opt")
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"
  local new_pid
  new_pid="$(cat "$PID_FILE")"

  local ok=0 i
  for i in $(seq 1 8); do
    sleep 1
    if curl -sf -m 3 "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
      ok=1
      break
    fi
    pid_alive "$new_pid" || break
  done
  if [ "$ok" = 1 ]; then
    echo "✅ 启动成功  PID=$new_pid  端口=$port"
    echo "   页面: http://<本机IP>:$port   日志: $LOG_FILE"
    echo "   PID 文件: $PID_FILE"
  else
    echo "❌ 启动失败（8 秒内未通过健康检查），最近日志："
    tail -15 "$LOG_FILE" 2>/dev/null
    return 1
  fi
}

stop_one() {
  local pid="$1"
  echo "发送 SIGTERM 给 PID=$pid ..."
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 10); do
    pid_alive "$pid" || return 0
    sleep 1
  done
  if pid_alive "$pid"; then
    echo "进程未退出，发送 SIGKILL 给 PID=$pid ..."
    kill -9 "$pid" 2>/dev/null || true
  fi
}

stop_server() {
  local pids stopped=0
  pids="$(collect_live_pids || true)"
  if [ -z "$pids" ]; then
    echo "未运行（无有效 PID）"
    rm -f "$PID_FILE"
    local f
    for f in $(legacy_pid_files); do rm -f "$f"; done
    return 0
  fi
  for p in $pids; do
    stop_one "$p"
    stopped=1
  done
  rm -f "$PID_FILE"
  local f
  for f in $(legacy_pid_files); do rm -f "$f"; done
  if [ "$stopped" = 1 ]; then
    echo "✅ 已停止"
  fi
}

status_server() {
  local port
  port="$(config_port)"
  echo "项目:   $PROJECT_NAME"
  echo "PID文件: $PID_FILE"
  local p
  p="$(read_pid_file "$PID_FILE" 2>/dev/null || true)"
  if pid_alive "$p"; then
    echo "进程:   ✅ PID $p"
  elif [ -n "$p" ]; then
    echo "进程:   ❌ PID 文件存在但进程已退出"
  else
    echo "进程:   ❌ 未运行（无 PID 文件）"
  fi
  local extra extra_other=""
  extra="$(ps -eo pid,args 2>/dev/null | awk -v root="$ROOT" '
    $0 ~ /boot\.cjs/ && $0 ~ /node/ && index($0, root) { print $1 }
  ' || true)"
  for p2 in $extra; do
    if [ "$p2" != "${p:-}" ]; then extra_other="$extra_other $p2"; fi
  done
  extra_other="$(echo "$extra_other" | xargs)"
  if [ -n "$extra_other" ]; then
    echo "进程:   ⚠️  发现未记录在 PID 文件的进程: $extra_other"
  fi
  if curl -sf -m 5 "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
    echo "HTTP:   ✅ http://127.0.0.1:$port/api/status 正常"
    curl -s -m 5 "http://127.0.0.1:$port/api/status" 2>/dev/null | head -c 200
    echo
  else
    echo "HTTP:   ❌ http://127.0.0.1:$port/api/status 无响应"
  fi
  echo "日志:   $LOG_FILE"
}

if [ "${1:-}" = "--set-password" ]; then
  if [ -z "${2:-}" ]; then
    echo "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" "$SERVER_DIR/boot.cjs" --set-password "$2"
  echo "✓ 密码已设置"
  exit 0
fi

CMD="${1:-restart}"
if [ "$CMD" = "--port" ]; then
  CMD="restart"
elif [ "$CMD" = "start" ] || [ "$CMD" = "stop" ] || [ "$CMD" = "restart" ] || [ "$CMD" = "status" ]; then
  shift
else
  CMD="restart"
fi

case "$CMD" in
  start)   start_server "$@" ;;
  stop)    stop_server ;;
  restart) stop_server; sleep 1; start_server "$@" ;;
  status)  status_server ;;
  *)
    echo "❌ 未知命令: $CMD"
    echo "可用命令: start, stop, restart, status"
    exit 1
    ;;
esac
