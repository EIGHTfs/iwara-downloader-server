#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 启动脚本（单脚本，对照 gbmd start-linux.sh）
# 用法：
#   ./start.sh start [--port PORT]        启动（缺省端口读 config.json，再缺省 8643）
#   ./start.sh restart [--port PORT]      重启（默认命令）
#   ./start.sh stop                       停止（PID 优雅停止 → 兜底 pkill）
#   ./start.sh status                     状态（进程 / 端口 / HTTP 健康检查）
#   ./start.sh --port PORT                兼容旧用法（等价 restart）
#   ./start.sh --set-password "新密码"    设置访问密码（不启动服务）
# 兼容旧脚本：./stop.sh / ./restart.sh / ./status.sh 均为薄壳转发到本脚本。
# 特性：PID 文件管理 / 端口优先级（--port > config.json > 8643）/
#       健康检查（启动后最多等 8 秒）/ 重复启动保护 / 无 setsid 退回 nohup
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
PID_FILE="$SERVER_DIR/app.pid"
LOG_FILE="$SERVER_DIR/server.log"
DEFAULT_PORT=8643

# ---------- Node 查找（tool/node Node24 > PATH 群晖套件 > PATH） ----------
# 群晖 DSM 默认 PATH 没有 node；项目 tool/node 放官方 Node 24（CF 只放行 Node24 指纹）
export PATH="$ROOT/tool/node/bin:/usr/local/bin:/var/packages/Node.js_v24/target/usr/local/bin:/var/packages/Node.js_v22/target/usr/local/bin:/var/packages/Node.js_v20/target/usr/local/bin:$PATH"
find_node() {
  for c in \
    "$ROOT/tool/node/bin/node" \
    /usr/local/bin/node \
    /var/packages/Node.js_v24/target/usr/local/bin/node \
    /var/packages/Node.js_v22/target/usr/local/bin/node \
    /var/packages/Node.js_v20/target/usr/local/bin/node \
    node; do
    if [ -n "$c" ] && command -v "$c" >/dev/null 2>&1; then
      NODE_BIN="$(command -v "$c")"
      return 0
    fi
  done
  return 1
}
if ! find_node; then
  echo "❌ 找不到 node。请把官方 linux-x64 解压到 tool/node/，或安装 Node.js 套件"
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

  # 已在运行？
  if [ -f "$PID_FILE" ] && [ -s "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE")"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "⚠️  已在运行 (PID $OLD_PID, 端口 $port)。如需重启: ./start.sh restart"
      return 1
    fi
    rm -f "$PID_FILE"
  fi

  cd "$SERVER_DIR" || exit 1
  # 用户原话：「这个项目不需要packagejson文件」——用 boot.cjs 强制 CJS，不写 package.json
  local cmd=("$NODE_BIN" boot.cjs)
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
      break   # 进程已退出 = 启动失败
    fi
  done

  if [ "$OK" = 1 ]; then
    echo "✅ 启动成功  PID=$NEW_PID  端口=$port"
    echo "   页面: http://<本机IP>:$port   日志: $LOG_FILE"
  else
    echo "❌ 启动失败（8 秒内未通过健康检查），最近日志："
    tail -15 "$LOG_FILE" 2>/dev/null
    return 1
  fi
}

# ---------- 停止 ----------
stop_server() {
  local stopped=0
  # 1) PID 文件优雅停止
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
  # 2) 兜底：只匹配 node boot.cjs（字符类防杀掉本脚本；排除 grep 自身）
  extra="$(pgrep -f '[n]ode .*boot[.]cjs' 2>/dev/null || true)"
  if [ -n "$extra" ]; then
    echo "兜底清理残留进程..."
    echo "$extra" | xargs -r kill 2>/dev/null || true
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
  echo "=== iwara-downloader-server 状态 ==="
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

  extra="$(pgrep -f '[n]ode .*boot[.]cjs' 2>/dev/null || true)"
  if [ -n "$extra" ]; then
    extra_other=""
    for p in $extra; do
      if [ "$p" != "${PID:-}" ]; then extra_other="$extra_other $p"; fi
    done
    extra_other="$(echo "$extra_other" | xargs)"
    if [ -n "$extra_other" ]; then
      echo "进程:   ⚠️  发现未记录在 PID 文件的进程: $extra_other"
    fi
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
# --set-password 作为独立操作
if [ "${1:-}" = "--set-password" ]; then
  if [ -z "${2:-}" ]; then
    echo "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" "$SERVER_DIR/boot.cjs" --set-password "$2"
  echo "✓ 密码已设置"
  exit 0
fi

# 判断命令（第一个参数），空参数默认 restart
CMD="${1:-restart}"
if [ "$CMD" = "--port" ]; then
  # 兼容旧用法：直接以 --port 开头，视为 restart
  CMD="restart"
  shift
elif [ "$CMD" = "start" ] || [ "$CMD" = "stop" ] || [ "$CMD" = "restart" ] || [ "$CMD" = "status" ]; then
  shift   # 去掉命令，剩余参数留给 start
else
  # 未知参数，当做 start 并保留所有参数（可能是旧用法）
  CMD="start"
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