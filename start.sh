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
CONFIG_FILE="$SERVER_DIR/config.json"
DEFAULT_PORT="${DEFAULT_PORT:-8643}"
LOG_ROTATE_BYTES=$((10 * 1024 * 1024))
STOP_WAIT_SEC=10

# ---------- 颜色（stdout 是终端才开；NO_COLOR / TERM=dumb 关闭）----------
C_GREEN="" C_YELLOW="" C_RED="" C_DIM="" C_RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
fi
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
err()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

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
  err "❌ 找不到 node。请安装 Node.js，或把官方二进制解压到 tool/node/"
  exit 1
fi
ok "✓ Node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"

file_size() {
  local f="$1"
  [ -f "$f" ] || { echo 0; return; }
  stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || wc -c < "$f"
}

human_size() {
  local n="$1"
  if [ "$n" -ge 1048576 ]; then awk -v n="$n" 'BEGIN{printf "%.1fMB", n/1048576}'; else awk -v n="$n" 'BEGIN{printf "%.1fKB", n/1024}'; fi
}

# ---------- 配置验证（不打印 Cookie / Token / 密码哈希）----------
validate_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    warn "⚠️  无 $CONFIG_FILE ，启动后会按默认值生成"
    return 0
  fi
  local out rc=0
  out="$("$NODE_BIN" -e '
const fs = require("fs");
const p = process.argv[1];
const def = Number(process.argv[2]);
let raw;
try { raw = fs.readFileSync(p, "utf8"); }
catch (e) {
  const code = e && e.code ? e.code : "";
  console.log((code === "EACCES" || code === "EPERM" ? "NO_PERM " : "READ_FAIL ") + (e.message || code));
  process.exit(2);
}
let c;
try { c = JSON.parse(raw); }
catch (e) { console.log("JSON_FAIL " + e.message); process.exit(3); }
if (!c || typeof c !== "object" || Array.isArray(c)) {
  console.log("NOT_OBJECT");
  process.exit(4);
}
if (c.port != null && c.port !== "") {
  const n = Number(c.port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.log("BAD_PORT " + String(c.port));
    process.exit(5);
  }
}
const port = (c.port == null || c.port === "") ? def : Number(c.port);
console.log("OK " + port);
' "$CONFIG_FILE" "$DEFAULT_PORT" 2>&1)" || rc=$?
  case "$out" in
    OK\ *) ok "✓ config.json 格式正常  port=${out#OK }"; return 0 ;;
    NO_PERM\ *) warn "⚠️  无权限读 config.json，跳过格式校验"; return 0 ;;
  esac
  err "❌ config.json 校验失败：$out"
  return 1
}

config_port() {
  "$NODE_BIN" -e '
try {
  const c = require(process.argv[1]);
  const d = Number(process.argv[2]);
  const n = Number(c.port);
  console.log(Number.isInteger(n) && n >= 1 && n <= 65535 ? n : d);
} catch (e) { console.log(process.argv[2]); }
' "$CONFIG_FILE" "$DEFAULT_PORT" 2>/dev/null || echo "$DEFAULT_PORT"
}

rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  local sz
  sz="$(file_size "$LOG_FILE")"
  [ "$sz" -gt "$LOG_ROTATE_BYTES" ] || return 0
  local ts dest
  ts="$(date +%Y%m%d-%H%M%S)"
  dest="${LOG_FILE}.${ts}"
  mv "$LOG_FILE" "$dest" || return 0
  if command -v gzip >/dev/null 2>&1; then
    gzip -f "$dest" && dest="${dest}.gz"
  fi
  warn "⚠️  日志超过 10MB，已轮转: $dest ($(human_size "$sz"))"
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

listen_line() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | awk -v p=":$port" '$0 ~ p {print; exit}'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk -v p=":$port" '$0 ~ p {print; exit}'
  fi
}

start_server() {
  local port_opt=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port_opt="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  validate_config || return 1
  local port="${port_opt:-$(config_port)}"
  local live
  live="$(collect_live_pids | head -n 1 || true)"
  if [ -n "$live" ]; then
    warn "⚠️  已在运行 (PID $live, 端口 $port)。如需重启: ./start.sh restart"
    return 1
  fi
  rm -f "$PID_FILE"
  mkdir -p "$SERVER_DIR"
  rotate_log
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

  local okflag=0 i
  for i in $(seq 1 8); do
    sleep 1
    if curl -sf -m 3 "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
      okflag=1
      break
    fi
    pid_alive "$new_pid" || break
  done
  if [ "$okflag" = 1 ]; then
    ok "✅ 启动成功  PID=$new_pid  端口=$port"
    echo "   页面: http://<本机IP>:$port"
    echo "   日志: $LOG_FILE"
    echo "   PID:  $PID_FILE"
  else
    err "❌ 启动失败（8 秒内未通过健康检查），最近日志："
    tail -15 "$LOG_FILE" 2>/dev/null
    return 1
  fi
}

stop_one() {
  local pid="$1"
  warn "⏹  SIGTERM  PID=$pid （最多等 ${STOP_WAIT_SEC}s）"
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 "$STOP_WAIT_SEC"); do
    if ! pid_alive "$pid"; then
      ok "✓ PID $pid 已在 ${i}s 内退出"
      return 0
    fi
    sleep 1
  done
  if pid_alive "$pid"; then
    warn "⚠️  ${STOP_WAIT_SEC}s 未退出，SIGKILL PID=$pid"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
  if pid_alive "$pid"; then
    err "❌ PID $pid 仍在，请检查"
    return 1
  fi
  ok "✓ PID $pid 已强制结束"
}

stop_server() {
  local pids
  pids="$(collect_live_pids || true)"
  if [ -z "$pids" ]; then
    warn "⚠️  未运行（无有效 PID）"
    rm -f "$PID_FILE"
    local f
    for f in $(legacy_pid_files); do rm -f "$f"; done
    return 0
  fi
  local rc=0
  for p in $pids; do
    stop_one "$p" || rc=1
  done
  rm -f "$PID_FILE"
  local f
  for f in $(legacy_pid_files); do rm -f "$f"; done
  if [ "$rc" = 0 ]; then
    ok "✅ 已停止"
  else
    err "❌ 停止未完成"
  fi
  return "$rc"
}

status_server() {
  local port
  port="$(config_port)"
  echo "======== $PROJECT_NAME ========"
  echo "根目录: $ROOT"
  echo "PID文件: $PID_FILE$([ -f "$PID_FILE" ] && echo " (存在)" || echo " (无)")"
  echo "配置:   $CONFIG_FILE"
  validate_config || true

  local p
  p="$(read_pid_file "$PID_FILE" 2>/dev/null || true)"
  if pid_alive "$p"; then
    ok "进程:   ✓ PID $p"
    ps -o pid=,ppid=,etime=,rss=,stat=,args= -p "$p" 2>/dev/null | while IFS= read -r line; do
      dim "        $line"
    done
  elif [ -n "$p" ]; then
    err "进程:   ✗ PID 文件有 $p 但进程已退出"
  else
    err "进程:   ✗ 未运行"
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
    warn "进程:   ⚠️  未记入 PID 文件: $extra_other"
  fi

  local lis
  lis="$(listen_line "$port")"
  if [ -n "$lis" ]; then
    ok "监听:   ✓ 端口 $port"
    dim "        $lis"
  else
    warn "监听:   未发现 :$port"
  fi

  local curlout code time
  curlout="$(curl -sS -m 5 -o /tmp/${PROJECT_NAME}-status.body -w '%{http_code} %{time_total}' "http://127.0.0.1:$port/api/status" 2>/dev/null || echo "000 0")"
  code="${curlout%% *}"
  time="${curlout#* }"
  if [ "$code" = "200" ]; then
    ok "HTTP:   ✓ GET /api/status  $code  ${time}s"
    head -c 240 "/tmp/${PROJECT_NAME}-status.body" 2>/dev/null; echo
  else
    err "HTTP:   ✗ GET /api/status  HTTP $code"
  fi
  rm -f "/tmp/${PROJECT_NAME}-status.body"

  if [ -f "$LOG_FILE" ]; then
    local sz mtime
    sz="$(file_size "$LOG_FILE")"
    mtime="$(date -r "$LOG_FILE" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || stat -c %y "$LOG_FILE" 2>/dev/null | cut -d. -f1)"
    echo "日志:   $LOG_FILE  $(human_size "$sz")  更新 $mtime"
    if [ "$sz" -gt "$LOG_ROTATE_BYTES" ]; then
      warn "日志:   已超过 10MB，下次 start/restart 会轮转压缩"
    fi
    echo "-------- 最近 8 行 --------"
    tail -8 "$LOG_FILE" 2>/dev/null
  else
    warn "日志:   尚无 $LOG_FILE"
  fi
}

if [ "${1:-}" = "--set-password" ]; then
  if [ -z "${2:-}" ]; then
    err "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" "$SERVER_DIR/boot.cjs" --set-password "$2"
  ok "✓ 密码已设置"
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
    err "❌ 未知命令: $CMD"
    echo "可用命令: start, stop, restart, status"
    exit 1
    ;;
esac
