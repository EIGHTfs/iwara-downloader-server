#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 启动脚本
# 用法: ./start.sh [端口]   （不传端口则读 server/config.json 的 port）
# 特性: PID 文件管理 / 端口读取 / 健康检查 / 重复启动保护
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
PID_FILE="$SERVER_DIR/app.pid"
LOG_FILE="$SERVER_DIR/server.log"

# Node 选择：项目自带 Node 24（CF 对 Node 22 OpenSSL 1.1 指纹会挑战；
# 实测 Node 24 + IP 直连 + 精简 UA 不需要 cf_clearance）> PATH > 群晖套件
export PATH="$ROOT/tool/node/bin:/usr/local/bin:/var/packages/Node.js_v24/target/usr/local/bin:/var/packages/Node.js_v22/target/usr/local/bin:/var/packages/Node.js_v20/target/usr/local/bin:$PATH"
NODE_BIN=""
for c in \
  "$ROOT/tool/node/bin/node" \
  /usr/local/bin/node \
  /var/packages/Node.js_v24/target/usr/local/bin/node \
  /var/packages/Node.js_v22/target/usr/local/bin/node \
  /var/packages/Node.js_v20/target/usr/local/bin/node \
  "$(command -v node 2>/dev/null || true)"
do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  echo "❌ 找不到 node。请把官方 linux-x64 解压到 tool/node/，或安装 Node.js 套件"
  exit 1
fi
echo "使用 Node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"

# ---- 端口：命令行参数 > config.json > 默认 8643 ----
PORT="${1:-}"
if [ -z "$PORT" ]; then
  PORT="$("$NODE_BIN" -e "try{const c=require(process.argv[1]);console.log(c.port||8643)}catch(e){console.log(8643)}" "$SERVER_DIR/config.json" 2>/dev/null || echo 8643)"
fi

# ---- 已在运行？ ----
if [ -f "$PID_FILE" ] && [ -s "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "⚠️  已在运行 (PID $OLD_PID, 端口 $PORT)。如需重启: ./restart.sh"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$SERVER_DIR" || exit 1
if command -v setsid >/dev/null 2>&1; then
  setsid nohup "$NODE_BIN" app.js --port "$PORT" > "$LOG_FILE" 2>&1 < /dev/null &
else
  nohup "$NODE_BIN" app.js --port "$PORT" > "$LOG_FILE" 2>&1 < /dev/null &
fi
echo $! > "$PID_FILE"
NEW_PID="$(cat "$PID_FILE")"

# ---- 健康检查（最多 8 秒） ----
OK=0
for i in $(seq 1 8); do
  sleep 1
  if curl -sf -m 3 "http://127.0.0.1:$PORT/api/status" > /dev/null 2>&1; then
    OK=1
    break
  fi
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    break   # 进程已退出 = 启动失败
  fi
done

if [ "$OK" = 1 ]; then
  echo "✅ 启动成功  PID=$NEW_PID  端口=$PORT"
  echo "   页面: http://<本机IP>:$PORT   日志: $LOG_FILE"
else
  echo "❌ 启动失败（8 秒内未通过健康检查），最近日志："
  tail -15 "$LOG_FILE" 2>/dev/null
  exit 1
fi