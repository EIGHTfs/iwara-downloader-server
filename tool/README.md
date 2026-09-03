# 项目自备工具（tool/）

本目录放本项目用到的外部二进制。目录名单数 `tool`（不是 tools）。

| 文件 | 入库 | 说明 |
|---|---|---|
| `node/` | 否 | 官方 Node 24，启停脚本优先用 |
| `ffmpeg` / `ffprobe` | 是 | 包装脚本：`LD_LIBRARY_PATH=tool/ffmpeg-lib` |
| `ffmpeg-bin` / `ffprobe-bin` | 否 | 真实二进制（本机从 `/usr/trim/lib/mediasrv/` 拷） |
| `ffmpeg-lib/` | 否 | mediasrv 依赖 so（含 Debian 侧 so，群晖约 146MB） |

封面抽帧：`server/lib/thumb-cache.cjs` 查找顺序 = `FFMPEG` 环境变量 → 本目录 `ffmpeg` → 系统路径。
包装脚本：项目 `ffmpeg-bin` 能跑就用；缺 so 才退回系统 `ffmpeg`。群晖自带 4.1 **没有 h264 解码**，必须把 `ffmpeg-lib` 整份拷过去，不能退回 `/usr/bin/ffmpeg`。

换机补齐：

```bash
cp /usr/trim/lib/mediasrv/ffmpeg tool/ffmpeg-bin
cp /usr/trim/lib/mediasrv/ffprobe tool/ffprobe-bin
# 再把 ldd 里 /usr/trim/lib/mediasrv/lib/*.so 拷进 tool/ffmpeg-lib/
./tool/ffmpeg -version
```
