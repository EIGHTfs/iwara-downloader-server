#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 重启脚本
# 用法: ./restart.sh [端口]
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT/stop.sh"
sleep 1
"$ROOT/start.sh" "${1:-}"