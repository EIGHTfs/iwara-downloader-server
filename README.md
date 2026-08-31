# iwara-downloader-server

Iwara.tv 视频下载服务器 —— 零依赖纯 Node.js 实现，提供网页搜索、视频解析与批量下载。

## 特性

- 🖥️ **纯网页前端**：浏览器打开即用，无需安装客户端
- 🔑 **凭证双模式**：Cookie / Token 配置切换（油猴脚本一键采集）
- 🌐 **CF 挑战绕过**：IP 直连（104.26.12.12 + SNI）+ 精简 UA，绕过 DNS 污染与 Cloudflare 拦截
- 🔄 **CDN 子域自动轮换**：下载链接过期/子域被挑战时，自动替换为可用子域并重试
- 📁 **可自定义文件命名模板**（学油猴脚本变量替换）：`Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4`
- 🚀 **双下载后端**：`direct`（Node 直连，支持断点续传）/ `aria2`（JSON-RPC 推送）
- 📦 **启停脚本**：`start.sh` / `stop.sh` / `restart.sh` / `status.sh`

## 快速开始

```bash
# 1. 配置（复制模板后编辑）
cp server/config.example.json server/config.json
vim server/config.json   # 填入 iwaraToken 或 iwaraCookie、downloadPath

# 2. 启动
./start.sh

# 3. 访问
#   浏览器打开 http://<本机IP>:8643
```

## 配置项

| 字段 | 说明 |
|------|------|
| `iwaraToken` | Iwara refresh_token（从油猴脚本复制） |
| `iwaraCookie` | 完整 Cookie（含 cf_clearance，HttpOnly 需油猴脚本读取） |
| `downloadBackend` | `direct`（默认）或 `aria2` |
| `downloadPath` | 下载根目录 |
| `fileNameTemplate` | 文件名模板，支持 `{TITLE} {ALIAS} {ID} {AUTHOR} {QUALITY} {UPLOADTIME} {NOWTIME}` |
| `useAuthorSubdir` | 是否按作者建子目录 |
| `concurrency` | 直连并发数 |
| `port` | HTTP 端口（默认 8643） |

## 凭证获取

浏览器安装 `iwara-cred-fetch.user.js`（油猴脚本）：
1. 打开并登录 iwara.tv（等待 Cloudflare 挑战完成，确保出现 `cf_clearance` cookie）
2. 点页面右下角 🎫 按钮
3. 一键复制完整 Cookie / Token，粘贴到网页「设置」保存

手机端无法跑油猴脚本时，可用 `iwara-cred.bookmarklet.js`（书签方案）。

## 技术说明

- **IP 直连**：所有 `.iwara.tv` 子域在代码内部替换为 `104.26.12.12`（Cloudflare 边缘），通过 SNI + Host header 访问，彻底绕开 DNS 污染。
- **下载链接有效期**：Iwara 返回的直链 `expires` 很短，每次下载都会重新解析 fresh 链接，避免 403。
- **子域轮换**：不同 CDN 子域（naja/firefly/aiko/filesq 等）在边缘 IP 上的可用性不同，失败自动轮换。

## 目录结构

```
├── start.sh / stop.sh / restart.sh / status.sh   # 启停脚本
├── iwara-cred-fetch.user.js                      # 油猴凭证采集脚本
├── iwara-cred.bookmarklet.js                     # 书签方案
└── server/
    ├── app.js            # HTTP 入口
    ├── auth.js           # 密码认证
    ├── config.js         # 配置管理
    ├── config.example.json
    ├── lib/
    │   ├── iwara-api.js  # Iwara API（IP 直连 + CF 绕过）
    │   └── downloader.js # 下载引擎（direct/aria2 + 子域轮换）
    └── public/           # 网页前端
```

## License

MIT
