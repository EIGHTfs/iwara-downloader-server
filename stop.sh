#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 停止脚本
# 用法: ./stop.sh
# 特性: PID 文件优雅停止 → 兜底 pkill（字符类防自杀）
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
PID_FILE="$SERVER_DIR/app.pid"

STOPPED=0

# ---- 1) PID 文件优雅停止 ----
if [ -f "$PID_FILE" ] && [ -s "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "发送 SIGTERM 给 PID=$PID ..."
    kill "$PID" 2>/dev/null || true
    for i in 1 2 3 4 5; do
      sleep 1
      kill -0 "$PID" 2>/dev/null || { STOPPED=1; break; }
    done
    if [ "$STOPPED" != 1 ]; then
      echo "未优雅退出，强制 SIGKILL PID=$PID"
      kill -9 "$PID" 2>/dev/null || true
      STOPPED=1
    fi
  fi
  rm -f "$PID_FILE"
fi

# ---- 2) 兜底：按命令行匹配（字符类 `[.]`/`[t]` 防止杀掉本脚本自身） ----
if pgrep -f 'server/app[.]js --por[t]' > /dev/null 2>&1; then
  echo "兜底清理残留进程..."
  pkill -f 'server/app[.]js --por[t]' 2>/dev/null || true
  STOPPED=1
fi

if [ "$STOPPED" = 1 ]; then
  echo "✅ 服务已停止"
else
  echo "ℹ️  未发现运行中的服务"
fi