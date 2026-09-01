#!/usr/bin/env bash
# ============================================================
# iwara-downloader-server 停止脚本（薄壳 → start.sh stop）
# 保留独立命令名，便于旧习惯 / 文档引用。
# ============================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$ROOT/start.sh" stop "$@"