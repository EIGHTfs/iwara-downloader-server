#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server macOS 启动脚本（与 start.sh 同构，对照 gbmd start-macos.sh）
# 用法：
#   ./start-macos.sh start [--port PORT]        启动
#   ./start-macos.sh restart [--port PORT]      重启（默认命令）
#   ./start-macos.sh stop                       停止
#   ./start-macos.sh status                     状态
#   ./start-macos.sh --port PORT                兼容旧用法（等价 restart）
#   ./start-macos.sh --set-password "新密码"    设置访问密码（不启动服务）
# 说明：自动寻找 node（PATH → /usr/local/bin → /opt/homebrew/bin → 常见 nvm 路径）。
#       macOS 不用项目 tool/node（那是 linux-x64 二进制）。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
PID_FILE="/tmp/iwara-macos.pid"
LOG_FILE="$SERVER_DIR/server.log"
DEFAULT_PORT=8643

# ---------- 查找 node（含 Homebrew / nvm）----------
find_node() {
  local c
  for c in node /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
      if command -v "$c" >/dev/null 2>&1; then NODE_BIN="$(command -v "$c")"; else NODE_BIN="$c"; fi
      return 0
    fi
  done
  return 1
}
if ! find_node; then
  echo "❌ 找不到 node。请先安装："
  echo "   brew install node"
  echo "   或从 https://nodejs.org 下载 macOS LTS 版"
  exit 1
fi
echo "使用 Node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"

config_port() {
  "$NODE_BIN" -e "try{const c=require(process.argv[1]);console.log(c.port||$DEFAULT_PORT)}catch(e){console.log($DEFAULT_PORT)}" "$SERVER_DIR/config.json" 2>/dev/null || echo "$DEFAULT_PORT"
}

# ---------- 启动 ----------
start_server() {
  local port_opt=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) port_opt="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  local port="${port_opt:-$(config_port)}"

  if [ -f "$PID_FILE" ] && [ -s "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE")"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "⚠️  已在运行 (PID $OLD_PID, 端口 $port)。如需重启: ./start-macos.sh restart"
      return 1
    fi
    rm -f "$PID_FILE"
  fi

  cd "$SERVER_DIR" || exit 1
  local cmd=("$NODE_BIN" app.js)
  if [ -n "$port_opt" ]; then cmd+=("--port" "$port_opt"); fi
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "${cmd[@]}" > "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "${cmd[@]}" > "$LOG_FILE" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"
  NEW_PID="$(cat "$PID_FILE")"

  # 健康检查（最多 8 秒）
  OK=0
  for i in $(seq 1 8); do
    sleep 1
    if curl -sf -m 3 "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
      OK=1
      break
    fi
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
      break
    fi
  done

  if [ "$OK" = 1 ]; then
    echo "✅ 启动成功  PID=$NEW_PID  端口=$port"
    echo "   页面: http://127.0.0.1:$port   日志: $LOG_FILE"
  else
    echo "❌ 启动失败（8 秒内未通过健康检查），最近日志："
    tail -15 "$LOG_FILE" 2>/dev/null
    return 1
  fi
}

# ---------- 停止 ----------
stop_server() {
  local stopped=0
  if [ -f "$PID_FILE" ] && [ -s "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "发送 SIGTERM 给 PID=$PID ..."
      kill "$PID" 2>/dev/null || true
      for i in 1 2 3 4 5; do
        sleep 1
        kill -0 "$PID" 2>/dev/null || { stopped=1; break; }
      done
      if [ "$stopped" != 1 ]; then
        echo "未优雅退出，强制 SIGKILL PID=$PID"
        kill -9 "$PID" 2>/dev/null || true
        stopped=1
      fi
    fi
    rm -f "$PID_FILE"
  fi
  if pgrep -f 'server/app[.]js --por[t]' > /dev/null 2>&1; then
    echo "兜底清理残留进程..."
    pkill -f 'server/app[.]js --por[t]' 2>/dev/null || true
    stopped=1
  fi
  if [ "$stopped" = 1 ]; then
    echo "✅ 服务已停止"
  else
    echo "ℹ️  未发现运行中的服务"
  fi
}

# ---------- 状态 ----------
status_server() {
  local port
  port="$(config_port)"
  echo "=== iwara-downloader-server 状态 (macOS) ==="
  echo "端口配置: $port"

  if [ -f "$PID_FILE" ] && [ -s "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "进程:   ✅ 运行中 (PID=$PID)"
      echo "启动时间: $(ps -o lstart= -p "$PID" 2>/dev/null | sed 's/^ *//')"
    else
      echo "进程:   ❌ PID 文件存在但进程已退出"
    fi
  else
    echo "进程:   ❌ 未运行（无 PID 文件）"
  fi

  if curl -sf -m 5 "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
    echo "HTTP:   ✅ http://127.0.0.1:$port/api/status 正常"
    curl -s -m 5 "http://127.0.0.1:$port/api/status" 2>/dev/null | head -c 200
    echo
  else
    echo "HTTP:   ❌ http://127.0.0.1:$port/api/status 无响应"
  fi

  echo "日志:   $LOG_FILE (tail -f 查看)"
}

# ---------- 参数解析 ----------
if [ "${1:-}" = "--set-password" ]; then
  if [ -z "${2:-}" ]; then
    echo "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" "$SERVER_DIR/app.js" --set-password "$2"
  echo "✓ 密码已设置"
  exit 0
fi

CMD="${1:-restart}"
if [ "$CMD" = "--port" ]; then
  CMD="restart"
  shift
elif [ "$CMD" = "start" ] || [ "$CMD" = "stop" ] || [ "$CMD" = "restart" ] || [ "$CMD" = "status" ]; then
  shift
else
  # 未知参数，当做 restart 并保留所有参数（可能是旧用法，对齐 start-macos.sh 模板）
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
    echo "旧用法: --port PORT 或 --set-password PASSWORD"
    exit 1
    ;;
esac