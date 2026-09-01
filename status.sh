#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 状态脚本（薄壳 → start.sh status）
# 用法: ./status.sh
# ============================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$ROOT/start.sh" status "$@"