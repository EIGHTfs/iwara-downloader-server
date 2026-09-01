#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 重启脚本（薄壳 → start.sh restart）
# 用法: ./restart.sh [--port PORT]
# ============================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$ROOT/start.sh" restart "$@"