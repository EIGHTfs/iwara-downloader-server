#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 状态脚本
# 用法: ./status.sh
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
PID_FILE="$SERVER_DIR/app.pid"
export PATH="$ROOT/tool/node/bin:/usr/local/bin:/var/packages/Node.js_v24/target/usr/local/bin:/var/packages/Node.js_v22/target/usr/local/bin:/var/packages/Node.js_v20/target/usr/local/bin:$PATH"
PORT="$(node -e "try{const c=require(process.argv[1]);console.log(c.port||8643)}catch(e){console.log(8643)}" "$SERVER_DIR/config.json" 2>/dev/null || echo 8643)"

echo "=== iwara-downloader-server 状态 ==="
echo "端口配置: $PORT"

# ---- PID 文件检查 ----
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

# ---- 命令行兜底匹配 ----
if pgrep -f 'server/app[.]js --por[t]' > /dev/null 2>&1; then
  echo "进程:   ⚠️  发现未记录在 PID 文件的进程: $(pgrep -f 'server/app[.]js --por[t]' | tr '\n' ' ')"
fi

# ---- HTTP 健康检查 ----
if curl -sf -m 5 "http://127.0.0.1:$PORT/api/status" > /dev/null 2>&1; then
  echo "HTTP:   ✅ http://127.0.0.1:$PORT/api/status 正常"
  curl -s -m 5 "http://127.0.0.1:$PORT/api/status" 2>/dev/null | head -c 200
  echo
else
  echo "HTTP:   ❌ http://127.0.0.1:$PORT/api/status 无响应"
fi

echo "日志:   $SERVER_DIR/server.log (tail -f 查看)"