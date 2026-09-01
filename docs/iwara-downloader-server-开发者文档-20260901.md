# iwara-downloader-server 开发者文档

> 版本：**1.0.5**（2026-09-01）
> 运行环境：Node.js **24**（零依赖 HTTP 服务）。默认端口 8643。群晖必须用项目 `tool/node`（官方 linux-x64 v24.19.0）；套件 Node 22 打 `api.iwara.tv` 会被 CF 挑战。
> 对照：本文件结构对齐 `gbmd-开发者文档-20260827.md`（项目结构 / API / 下载流程 / 配置 / 坑）

---

## 目录

1. [项目结构](#1-项目结构)
2. [启动/停止/状态](#2-启动停止状态)
3. [API 总览](#3-api-总览)
4. [认证与鉴权](#4-认证与鉴权)
5. [设置类 API](#5-设置类-api)
6. [Iwara 检测 / 关注用户 / 视频解析](#6-iwara-检测--关注用户--视频解析)
7. [搜索 API](#7-搜索-api)
8. [下载/任务 API](#8-下载任务-api)
9. [用户数据备份 API](#9-用户数据备份-api)
10. [下载流程详解（重点）](#10-下载流程详解重点)
    - 含 [10.7 群晖 Node 版本 vs Cloudflare（2026-09-01 实测）](#107-群晖-node-版本-vs-cloudflare2026-09-01-实测)
11. [前端（gbmd 纯前端模板）](#11-前端gbmd-纯前端模板)
12. [配置文件与数据文件](#12-配置文件与数据文件)
13. [注意事项/坑](#13-注意事项坑)
14. [变更日志](#14-变更日志)

---

## 1. 项目结构

```
iwara-downloader-server/
├── start.sh / start-macos.sh / start-windows.bat / start-windows-background.bat  # 启停脚本（单脚本子命令）
├── stop.sh / restart.sh / status.sh      # 兼容薄壳 → start.sh
├── scripts/git-push.sh                 # 读项目根 .git-push-token 推 origin + tags
├── scripts/iwara-cred-fetch.user.js    # 油猴脚本（凭证 + 一键发送 /api/receive）
├── userdata-manifest.json              # 用户数据清单（备份/恢复按此收集）
├── TROUBLESHOOTING.md                  # 踩坑：UA / IP 直连 / DNS / 链接过期 / aria2 / Node 24
├── tool/node/                          # 官方 Node 24 linux-x64（gitignore，群晖部署解压到这里）
├── docs/                               # 开发者文档（本文件）
└── server/
    ├── app.js                          # HTTP 入口 + 全部 API 路由
    ├── auth.js                         # session / scrypt 密码
    ├── config.js                       # 配置读写（config.json）
    ├── config.example.json             # 入库模板（空凭证、示例路径）
    ├── config.json                     # 运行配置（gitignore）
    ├── download_task.json              # 下载任务持久化（gitignore）
    ├── search_task.json                # 按时间搜索任务（gitignore）
    ├── search_cache.json               # 搜索记录缓存（gitignore）
    ├── cdn_hosts_state.json            # CDN 子域 GOOD/BAD（gitignore）
    ├── following_cache.json            # 关注用户列表缓存（增量同步，gitignore）
    ├── server.log / app.pid
    ├── lib/
    │   ├── iwara-api.js                # Iwara API（IP 直连 + 精简 UA + X-Version）
    │   ├── downloader.js               # 下载引擎（direct / aria2 + 子域轮换）
    │   ├── search-cache.js             # 按时间翻页搜索 + 记录导入导出
    │   ├── video-index.js              # 精简索引 sidecar（不算 hash）
    │   └── data-backup.js              # zip 备份/恢复（对照 gbmd）
    └── public/                         # 网页前端（骨架来自 gbmd docs/ui-template）
        ├── index.html / app.js / style.css
        ├── favicon.ico / favicon.png / iwara-logo.png
        └── login.html
```

---

## 2. 启动/停止/状态

```bash
cd /path/to/iwara-downloader-server
./start.sh                 # 无参 = 默认 restart（未运行则直接启动），写 server/app.pid
./start.sh start           # 启动；可带 --port 8643
./start.sh restart         # stop + sleep 1 + start；可带 --port 8643
./start.sh stop            # 读 pid 发 SIGTERM → 兜底 pkill
./start.sh status          # 打印进程 / 端口 / HTTP 健康检查
./start.sh --port 8643     # 兼容旧用法（等价 restart）
./start.sh --set-password "新密码"   # 设置访问密码（不启动服务）
```

旧脚本名 `stop.sh` / `restart.sh` / `status.sh` 保留为薄壳，转发 `start.sh`（旧习惯/文档引用不受影响）。macOS 用 `start-macos.sh`（自动找 Homebrew/nvm node），Windows 用 `start-windows.bat` / `start-windows-background.bat`，命令结构一致。

`start.sh` 选 Node 的顺序：`tool/node/bin/node`（项目自带官方 linux-x64 **Node 24**）→ `/usr/local/bin` → 群晖 Node.js_v24 / v22 / v20 套件。DSM 默认 PATH 没有 `node`。

**必须用 Node 24**：群晖套件 Node 22（OpenSSL 1.1）打 `api.iwara.tv` 会被 Cloudflare JS 挑战（403 Just a moment），与有没有 `cf_clearance` 无关。同一台机器、同一个 `104.26.12.12` 泛解析，Node 24 精简 UA + IP/SNI 直连可以直接 200/401。Aria2 能下视频是因为走的是 CDN 文件站，不是 `api.iwara.tv`。`tool/node/` 不入库，部署时解压官方 `node-v24.x-linux-x64` 到该目录。

正式运行副本在群晖共享盘（与 gbmd 同目录）：`/volume6/Game.Patch N MOD/iwara-downloader-server/`。fnOS 上 `/vol02/1000-0-1c60be7b/iwara-downloader-server` 是同一份共享的挂载，改代码后必须在 **SA6400** 上 `./restart.sh`，不要再在 fnOS 起一份抢同一端口。

---

## 3. API 总览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/status` | 否 | 服务状态（needsAuth / port） |
| GET | `/api/thumb` | 否 | 视频封面（IP 直连 i.iwara.tv） |
| POST | `/api/login` | 否 | 登录 → Set-Cookie: session |
| POST | `/api/logout` | 是 | 销毁 session |
| GET | `/api/settings` | 是 | 读配置（脱敏，不回传明文） |
| POST | `/api/settings` | 是 | 保存配置（支持组合文本） |
| POST | `/api/change-password` | 是 | 设密码（≥4 位） |
| POST | `/api/token` | 是 | 单独保存 iwaraToken |
| GET | `/api/account-check` | 是 | 账号/登录态检测（油猴+设置页） |
| GET | `/api/following` | 是 | 关注用户列表（增量同步） |
| GET | `/api/videos` | 否 | 视频列表（关键词走 `/search?query=`；登录后结果含 liked） |
| POST | `/api/search` | 是 | 按时间后台翻页 |
| GET | `/api/search-status` | 是 | 查询任务进度 |
| POST | `/api/search/stop` | 是 | 停止搜索 |
| GET | `/api/search/cache` | 是 | 查缓存 |
| POST | `/api/search/save` | 是 | 保存缓存 |
| POST | `/api/search/import` | 是 | 导入记录（按 id 合并覆盖） |
| GET | `/api/search/export` | 是 | 下载 JSON |
| POST | `/api/search/clear` | 是 | 清缓存 |
| GET | `/api/video-info` | 是 | 解析单视频直链 |
| GET | `/api/index` | 是 | 读下载根目录精简索引 `iwara-index.json` |
| GET | `/api/index/export` | 是 | 下载纯 `{ 视频id: 条目 }` JSON |
| POST | `/api/index/import` | 是 | 导入索引（兼容别人完整 /video dump） |
| POST | `/api/index/scan` | 是 | 扫描下载目录 json，合并进总表 |
| POST | `/api/download` | 是 | 提交下载任务 |
| POST | `/api/receive` | 是 | 油猴专用接收口（规整后转发给 `/api/download`） |
| GET | `/api/task` | 是 | 查询任务状态 |
| POST | `/api/task/pause` | 是 | 暂停 |
| POST | `/api/task/resume` | 是 | 继续 |
| POST | `/api/task/stop` | 是 | 停止 |
| POST | `/api/task/retry` | 是 | 重跑失败项 |
| POST | `/api/task/concurrency` | 是 | 改并发数 |
| GET | `/api/browse` | 是 | 浏览本机目录（设置页 📂 选下载根） |
| GET | `/api/index-sidecar` | 否（HMAC） | Aria2 拉 sidecar JSON：`?id=&k=` |
| GET | `/api/data/export` | 是 | 下载用户数据 zip（含 config.json） |
| POST | `/api/data/import` | 是 | 导入用户数据 zip（body.data = zip 的 base64） |

**鉴权**：设置密码后所有 `/api/*` 需要 cookie `session=xxx`。没设密码（`needsAuth:false`）全部放行。公共静态资源（index.html / login.html / favicon / js / css）无需鉴权。

---

## 4. 认证与鉴权

### 登录

```
POST /api/login
Content-Type: application/json
{ "password": "xxx" }
→ Set-Cookie: session=<jwt>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<sessionHours*3600>
{ ok: true }
```

密码用 scrypt 哈希存 `config.json`（passwordSalt + passwordHash）。

### 登出

```
POST /api/logout → { ok: true }
```

服务端发 `Set-Cookie: session=; Path=/; HttpOnly; Max-Age=0`。

---

## 5. 设置类 API

### GET /api/settings

脱敏返回，不回传明文：

```json
{
  "ok": true,
  "settings": {
    "port": 28463,
    "downloadBackend": "aria2",
    "concurrency": 3,
    "aria2Path": "https://10.10.10.4:xxx/jsonrpc",
    "downloadPath": "/volume3/WORKGROUP/",
    "fileNameTemplate": "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]",
    "useAuthorSubdir": false,
    "sessionHours": 72,
    "hasCookie": true,
    "hasToken": true,
    "hasAria2Token": true
  }
}
```

注意：`hasCookie` / `hasToken` / `hasAria2Token` 只表示磁盘有值，**不反回明文**。前端保存时留空 = 不改。

### POST /api/settings

```json
{
  "downloadPath": "/volume3/WORKGROUP/",
  "downloadBackend": "aria2",
  "concurrency": 3,
  "aria2Path": "https://...",
  "aria2Token": "abc",           // 留空不改
  "iwaraCookie": "...\nToken=...\nAccessToken=...",
  "fileNameTemplate": "...",
  "useAuthorSubdir": false,
  "sessionHours": 72
}
```

**兼容油猴组合文本**：`Cookie=...\nToken=...\nAccessToken=...` 会被 `parseCredentialText` 拆成三个字段分别写入 `iwaraCookie` / `iwaraToken` / `iwaraAccessToken`。

允许字段白名单：`iwaraCookie`, `iwaraToken`, `iwaraAccessToken`, `downloadBackend`, `concurrency`, `aria2Path`, `aria2Token`, `downloadPath`, `fileNameTemplate`, `useAuthorSubdir`, `sessionHours`, `port`, `checkDownloadLink`。敏感字段为空字符串时跳过不覆盖。

返回同上（脱敏）。

### GET /api/browse

设置页下载根目录 📂 弹窗用。只列目录，排除 `@eaDir` / `#recycle` / `.git`。路径必须以 `/` 开头。

```
GET /api/browse?path=/volume3/WORKGROUP
→ { ok:true, path, parent, dirs:["subdir", ...] }
```

读的是**跑本服务那台机器**上的文件系统。Aria2 后端要把服务和 Aria2 放同一台，才能选到 Aria2 的 `dir`。

### POST /api/change-password

```json
{ "password": "新密码" }
```

密码至少 4 位。scrypt 哈希覆盖写入。

### POST /api/token

```json
{ "iwaraToken": "..." }
```

单独保存 refresh_token（供油猴凭证获取器推送）。

---

## 6. Iwara 检测 / 关注用户 / 视频解析

### GET /api/account-check

油猴脚本与设置页「检测登录状态」共用。不回传 Cookie/Token 明文，只给脱敏诊断 `cred`。

```json
// 未配置
{ "ok": true, "cookieSet": false, "checked": false, "message": "未配置 Cookie / Token",
  "cred": { "hasCookie": false, "cookieChars": 0, "cookieItems": 0, "hasCfClearance": false,
            "hasToken": false, "hasAccessToken": false } }

// 已登录
{ "ok": true, "cookieSet": true, "checked": true, "loggedIn": true,
  "user": "fluquormyosotis", "userId": "c1d1cf1f-...", "username": "fluquormyosotis",
  "warnLevel": "ok", "remainingDays": 29.5, "expiresAt": 1790763448000,
  "cred": { "hasCookie": true, "cookieChars": 127, "cookieItems": 2, "hasCfClearance": false,
            "hasToken": true, "hasAccessToken": true } }

// CF 挑战（几乎总是 Node 运行时指纹，不是缺 cf_clearance）
{ "ok": false, "loggedIn": false, "cfChallenge": true,
  "error": "Cloudflare 挑战未通过（Node TLS 指纹，与 Cookie 无关）" }
```

内部会先 `ensureAccessToken`（用 iwaraToken 刷 access_token 并持久化）。401 时自动再刷一次重试。导入 zip 走 `checkLogin({ force: true })`。

**不要用「Cookie 缺 cf_clearance」解释 403。** IP 直连 + 精简 UA + **Node 24** 时，残 Cookie（只有 `_ga`、没有 clearance）也能 `loggedIn: true`。见 §10.7。

### GET /api/following

分页 / 增量同步两用。

**分页（默认）**

```
GET /api/following?page=0&limit=50
```

```json
{ "ok": true, "count": 2516, "me": { "id":"...", "username":"...", "name":"..." },
  "following": [{ "id","username","name","following":true,"createdAt":"" }, ...],
  "page": 0, "limit": 50, "synced": null, "added": null, "fetchedPages": null }
```

**全量（强制刷新）**

```
GET /api/following?all=1
GET /api/following?all=1&refresh=1   # 清内存缓存
```

返回同上，多出 `synced` / `added` / `fetchedPages`。

**增量同步规则**（`following_cache.json` 落盘，10 分钟内存 TTL）：
- 首次拉满所有页
- 之后从 page 0 往后，直到碰上本地已有的用户 → **新增 = 这部分前缀**
- 合并 = 新增 + 原有（从重合点起）
- **原有 + 新增 < 远端 count** → 有取关或本地不完整，才继续往更旧的页找（避免每次全量翻 51 页）
- `mode` 取值：`full` / `incr` / `incr-backfill` / `no-overlap` / `backfill`

实测：2516 人首次 51 页约 14s；无变化 1 页 481ms；模拟头部 +3 人 1 页 891ms。

### GET /api/thumb

公开接口，绕过鉴权让未登录也能预览封面。IP 直连 `i.iwara.tv/image/thumbnail/{fileId}/thumbnail-{n}.jpg`。

```
GET /api/thumb?file=<fileId>&n=<0..>
```

返回原始图片字节（JPEG / WebP），`Content-Type` 对应，`Cache-Control: public, max-age=86400`。

前端示例：

```html
<img src="/api/thumb?file=a610e581-...&n=5" loading="lazy">
```

### GET /api/videos

Query：`sort`（date/trending/views）、`page`、`limit`、`user`、`search`、`rating`（all/general/ecchi）、`subscribed=1`。

**关键词必须走 `/search?query=`，不用 `/videos?search=`**（实测「奥黛塔」用后者只有 4 条垃圾，前者 12 条正确）。

```
GET /api/videos?search=奥黛塔&rating=all&page=0&limit=20
GET /api/videos?user=xxx&rating=general
GET /api/videos?subscribed=1
```

返回 `{ ok, count, page, limit, results: [Video] }`。Video 字段：`id, slug, title, body, rating, thumbnail, file (id/name/size), user (id/username/name), createdAt, numLikes, numViews, numComments, tags`。

### GET /api/video-info?id=<id>

1. `GET /video/{id}` → RAW 响应
2. 有 `embedUrl` → `{ type:"external" }`（无直链）
3. 否则拉 `fileUrl` 源列表 JSON，按 Source > 540 > 360 选 `src.download`
4. `downloadUrl = decodeURIComponent("https:" + src.download)`（带 `expires`）

X-Version：`SHA1([pathname末段, expires, 密钥].join('_'))`，密钥 `mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN`（油猴公开密钥，可入库）。

---

## 7. 搜索 API

### POST /api/search

按时间后台翻页（对照 gbmd `/api/search`）。body：

```json
{
  "startDate": "2026-08-01",
  "endDate": "2026-09-01",
  "contentFilter": ["normal", "nsfw"],
  "user": "",
  "search": ""
}
```

实现（`server/lib/search-cache.js`）：
- 调 `listVideos({ sort:"date", rating })` 翻页（limit 48）
- 用 `createdAt` 过滤 `[startTs, endTs)`
- `contentFilter` → `rating=all|general|ecchi`，再用 `video.rating` 二次筛
- 上限 80 页 / 2000 条；页间隔 400ms
- 结果写入 `search_cache.json`，任务写入 `search_task.json`（重启可恢复）

### GET /api/search-status

`{ ok, task: { status, page, results, message, ... } }`。`status`: running / done / error。

### POST /api/search/stop

停止，保留已找到结果。

### GET /api/search/cache

`{ ok, cache: { results, startDate, endDate, contentFilter, queryTime } }`。

记录字段（兼容 gbmd 导入习惯，同时保留 Iwara 字段）：

```json
{
  "id": "KzQf3RIaBEf5vL",
  "modId": "KzQf3RIaBEf5vL",
  "title": "...",
  "name": "...",
  "author": "...",
  "createdAt": "2026-...",
  "dateAdded": 1750000000,
  "rating": "ecchi",
  "isNsfw": true,
  "thumbnail": 5,
  "file": { "id":"a610e581-...", "name":"...", "size":107512609 }
}
```

### POST /api/search/save

```json
{ "results": [ /* 当前前端列表 */ ] }
```

覆盖写入 `search_cache.json`。返回 `{ ok, total }`。

### POST /api/search/import

```json
{ "records": [ /* 数组，或 {results}/{records} 包一层 */ ] }
```

按 `id`/`modId` 合并，**导入覆盖原有**。返回 `{ ok, added, replaced, total }`。

### GET /api/search/export

`Content-Disposition: attachment; filename="iwara-search-records-YYYY-MM-DD.json"`。

### POST /api/search/clear

删 cache + task 文件。

---

## 8. 下载/任务 API

### POST /api/download

```json
{
  "items": [
    { "id": "KzQf3RIaBEf5vL", "title": "奥黛塔 经纪人的性爱计划 Day1", "author": "user320002" }
  ]
}
```

- `id` 必填；title/author 可空（下载时 `getVideoInfo` 会补文件名）。
- 需已配 `downloadPath`，否则 400。
- 返回 `{ ok:true, total }`。
- **每次下载都重新 `getVideoInfo`**，禁止复用旧 URL。
- 提交成功后写精简索引（不算 hash）：本机总表 `server/iwara-index.json`（下载目录可写则双写）。direct 落盘后再写视频旁 `<同名>.json`。aria2：本机生成 sidecar，公开 `GET /api/index-sidecar?id=&k=`（HMAC 短链），再 `aria2.addUri` 让 Aria2 把 JSON 拉到下载目录，和视频同名（`.json`）。

### GET /api/index

磁盘文件是纯映射（没有外壳）。优先 `downloadPath/iwara-index.json`；若下载目录对本进程不可写（Aria2 在另一台机器），写到服务数据目录 `server/iwara-index.json`。读取时两处合并。

```json
{
  "z2rctWsaRNogFK": {
    "name": "帰ってきたtakesiman",
    "username": "takesiman",
    "title": "ワカメちゃん化浦波＆初雪で駅の階段を上る",
    "fileId": "7d14494c-072b-43b5-a67c-42b75d286426",
    "duration": 124,
    "tags": [
      { "id": "kancolle", "type": "general", "sensitive": false },
      { "id": "mikumikudance", "type": "category", "sensitive": false }
    ],
    "createdAt": "2025-06-03T21:16:40.000Z"
  }
}
```

接口返回 `{ ok:true, count, videos }`。不算 hash。不生成别人那种完整 `/video/:id` dump。

### GET /api/index/export

下载上面这份纯 JSON。

### POST /api/index/import

body 可以是纯 `{ 视频id: 条目 }`、`{ videos: {...} }`，或别人单条/数组完整 dump。按 id 合并。

### POST /api/index/scan

扫描 `downloadPath` 下 json（跳过总表本身），把别人 dump / sidecar 合并进总表。返回 `{ ok, filesRead, filesUsed, added, updated, count }`。

前端批量框：每行一个完整链接或纯 ID，`parseVideoIds` 抽出 `iwara.tv/video/<id>`。

油猴脚本 `POST /api/download` 也可传字符串数组（完整链接或纯 ID）。

### POST /api/receive

油猴脚本专用。需登录。**不自己解析**，只把 body 规整成 `{ items }` 后走 `/api/download` 同一处理：

```json
{ "url": "https://www.iwara.tv/video/KzQf3RIaBEf5vL" }
```

也接受 `{ urls: [...] }` / `{ items: [...] }` / `{ text: "每行一个链接" }`。返回 `{ ok, total, received }`。

### GET /api/task

```json
{
  "ok": true,
  "task": {
    "status": "idle|running|paused",
    "backend": "direct|aria2",
    "completed": 1,
    "failed": 0,
    "items": [
      {
        "id": "...",
        "title": "...",
        "author": "...",
        "file": "Iwara_-_..._[ID]_[Source].mp4",
        "url": "https://pela.iwara.tv/download?hash=...&expires=...",
        "savePath": "/volume3/WORKGROUP/...",
        "state": "pending|downloading|done|failed|submitted",
        "progress": 100,
        "doneBytes": 0,
        "total": 107512609,
        "error": ""
      }
    ]
  }
}
```

`state=submitted`：已推给 aria2，本服务不再跟踪字节进度（看 Aria2 WebUI）。

前端每 1.5s 轮询，用相邻两次 `doneBytes` 算速度。

### POST /api/task/pause | resume | stop

无 body。pause 保留列表；resume 继续；stop 置 idle。

### POST /api/task/retry

失败项改回 pending 并再跑循环。返回 `{ ok, retried }`。

### POST /api/task/concurrency

```json
{ "n": 3 }
```

写入 config，范围 1~8。

---

## 9. 用户数据备份 API

对照 gbmd：清单驱动，`zip`/`unzip` 系统命令（或 `tool/bin/`）。

### GET /api/data/export

下载 `iwara-userdata-YYYY-MM-DD.zip`，内含 `userdata-manifest.json` + 清单里实际存在的文件。

### POST /api/data/import

```json
{ "data": "<zip 的 base64>" }
```

按 zip 内（或当前项目）清单白名单写回 `server/config.json`（含 Cookie / Token）。**写盘后立刻 `checkLogin({ force: true })`**：刷 access_token，再 GET `/user`。返回：

```json
{ "ok": true, "restored": ["server/config.json", ...], "skipped": ["userdata-manifest.json"], "note": "...",
  "login": { "ok": true, "loggedIn": true, "username": "...", "userId": "...", "remainingDays": 29.4, "warnLevel": "ok" } }
```

`login.loggedIn=false` 时带 `error` / `cfChallenge`。网页设置页会显示这次登录结果并刷新顶栏。运行中导入任务/密码哈希后仍建议 `./restart.sh`。

当前清单 `files`：

- `server/config.json`
- `server/download_task.json`
- `server/search_cache.json`
- `server/search_task.json`
- `server/cdn_hosts_state.json`
- `server/following_cache.json`
- `server/iwara-index.json`
- `server/sessions.json`
- `server/server.log`
- `server/app.pid`

全部 gitignore，**禁止入库**。`.git-push-token` 不进备份清单（推送凭据只留本机，不随用户数据 zip 导出）。

网页设置页「📦 数据备份 / 恢复」走这两条 API。导入会按清单白名单覆盖 `server/config.json`（含 Cookie / Token / 密码哈希 / 下载路径），**运行中导入后必须 `./restart.sh` 才完全生效**。

---

## 10. 下载流程详解（重点）

```
items[]
  → 校验 downloadPath
  → 按 useAuthorSubdir 拼 savePath（默认否：直接根目录）
  → 对每一项：
       跳过判定（不看索引）：下载根（及一层作者子目录）已有文件名含 [视频id] 的非空视频
         或 Aria2 tellActive/tellWaiting/tellStopped 已有同 id / 同文件名
       getVideoInfo(id)                    // 必须每次 fresh
       applyFileNameTemplate(...)          // Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]  （落盘自动补 .mp4）
       direct: downloadToFile（IP 直连 + Range + 子域轮换）
       aria2:  aria2.addUri（UA header + dir + 可选 Cookie）
```

### 10.1 IP 直连（Virtual Hosts 的应用层实现）

系统 DNS 污染 `*.iwara.tv`（223.5.5.5 / 8.8.8.8 / 1.1.1.1 都不准）。Node **禁止自定义 lookup**（Node 24 会炸）。一律：

```js
https.request({
  host: api.getCfIp(),              // 读 config.json 的 iwaraCfgIp（默认 104.26.12.12），代码不写死
  servername: "<真实域名>",          // TLS SNI
  headers: { Host: "<真实域名>", "User-Agent": DEFAULT_UA }
})
```

CF 边缘 IP 从 `server/config.json` 的 `iwaraCfgIp` 读取（默认 `104.26.12.12`），aria2 用的 DNS 从 `aria2Dns` 读取（默认 `10.10.10.64`，留空则不传 `dns-server`）。设置页「下载后端」卡片可改。

### 10.2 User-Agent

**完整 Chrome UA（含 AppleWebKit/537.36 (KHTML, like Gecko)）→ CF 403。**

精简 UA（唯一允许值）：

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36
```

API、direct 下载、aria2 `header` 都必须带这个。aria2 默认 `aria2/1.37.0` 会被 403。

### 10.3 直链过期

`downloadUrl` 带 `expires`（Unix 秒），几分钟失效。旧 URL 换任何 CDN 子域都没用。
`runDownloadLoop` 的 **direct 与 aria2 两个分支**都先 `getVideoInfo`。

### 10.4 CDN 子域动态列表

文件：`server/cdn_hosts_state.json`。

- GOOD：成功过的子域，优先
- BAD：403/超时，跳过
- 种子：`firefly` / `aiko` / `filesq`
- 实测常可用：firefly、aiko、filesq、pela、phoebe、topaz；`naja` 常 403

失败只换 hostname，path/query（含 hash、expires）保持不变。

### 10.5 文件名

模板变量：`{TITLE}` `{ALIAS}` `{ID}` `{AUTHOR}` `{QUALITY}` `{UPLOADTIME}` `{NOWTIME}`。
默认：`Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]`（不要写 `.mp4`，落盘自动补）。
非法字符替换为 `_`。`useAuthorSubdir` 默认 **false**。

### 10.6 aria2 后端

- RPC：`https.request`，DSM 自签证书 `rejectUnauthorized:false`（不要用 undici fetch）
- token：`params: ["token:"+aria2Token, [uris], options]`，不要放 query string
- `options.dir` = **aria2 机器上的路径**（群晖例 `/volume3/WORKGROUP/`）
- `options.header` = `User-Agent: <精简 UA>`；仅当 Cookie 含 `cf_clearance` 且不含 `deleted` 才附带 Cookie
- `options["dns-server"]` = 配置 `aria2Dns`（默认 `10.10.10.64`，群晖 DNS Server：`iwara.tv * A <iwaraCfgIp>`）
- aria2 自己做 DNS：NAS 系统 DNS 必须能把 `*.iwara.tv` 解到 `104.26.12.12`；`127.0.0.1#53` 未监听时用套件地址
- 提交成功后本服务标 `submitted`；真实进度在 Aria2 WebUI
- 写目录权限不够时表现为拿到 Content-Length 后速度 0 / abort——先给目标目录写权限

实测（权限放开后）：`KzQf3RIaBEf5vL` → 107,512,609 bytes complete，路径
`/volume3/WORKGROUP/Iwara_-_奥黛塔 经纪人的性爱计划 Day1_[KzQf3RIaBEf5vL]_[Source].mp4`

### 10.7 群晖 Node 版本 vs Cloudflare（2026-09-01 实测）

现象：Aria2 在 SA6400 上能把视频下完，网页顶栏却报「Cloudflare 挑战未通过：Cookie 缺少 cf_clearance」。导入用户数据 zip 也「成功」，Cookie 原样写回，登录还是失败。

**结论：不是 Cookie，也不是 IP。是跑 API 的那个 Node 的 TLS 指纹。**

对照实验（同一台 SA6400 `10.10.10.64`，同一出口，同一精简 UA，**都不带 cf_clearance**）：

| 客户端 | 目标 | DNS / 连接 | 结果 |
|---|---|---|---|
| 群晖 Aria2 套件 | CDN 文件（`firefly.iwara.tv` 等） | 系统 DNS → 泛解析 `104.26.12.12` | ✅ 视频 complete |
| 群晖 Node.js_v22 套件（OpenSSL 1.1.1u） | `GET https://api.iwara.tv/user` | 代码写死 IP **或** `dns.lookup` 得到 `104.26.12.12` | ❌ 403 `cf-mitigated: challenge` / `Just a moment` |
| 群晖 curl 7.86（OpenSSL 3.0.9） | 同上 | `--resolve api.iwara.tv:443:104.26.12.12` 或走 hostname | ❌ 同上 |
| 官方 Node **v24.19.0** linux-x64（项目 `tool/node`） | 同上 | 同上 IP + SNI `api.iwara.tv` | ✅ 200 JSON；有 refresh_token 则 `loggedIn: true` |
| fnOS `/usr/bin/node` v24.19.0 | 同上 | 同上 | ✅ 200 / 401 JSON |

关键观测：

1. **`api.iwara.tv` 已被群晖 DNS Server 泛解析。**  
   `dns.lookup('api.iwara.tv')` → `{ address: '104.26.12.12', family: 4 }`。  
   代码里 `host: "104.26.12.12"` + `servername: "api.iwara.tv"` 和走系统 DNS 是同一条路，不是两套绕过。
2. **nslookup 走 10.10.10.1 会污染**（`75.126.124.162` / `2001::1f0d:5322`）。Node 走 `127.0.0.1`（DNS Server 套件）才是 `104.26.12.12`。Aria2 必须用套件 DNS，不能用上游 10.10.10.1。
3. **Aria2 能下 ≠ API 能登录。** Aria2 打的是 CDN 文件站（`*.iwara.tv` 下载子域）；登录 / 搜索 / `getVideoInfo` 打的是 `api.iwara.tv`。CF 对「浏览器不像」的 TLS 指纹只拦 API，文件站放行。
4. **不需要 `cf_clearance`。** 当时 `config.json` 的 Cookie 只有 `_ga` + 一条 `deleted`（127 字符、3 项，`hasCfClearance: false`）。换成 Node 24 后 `GET /api/account-check`：
   ```
   loggedIn: true, username: fluquormyosotis, remainingDays: 29.4, cfChallenge: 无
   ```
   `POST /api/data/import` 写回同一份 config 再 `checkLogin({force:true})` 同样成功。
5. **误判路径：** 代码曾把所有 `HTTP 403 Just a moment` 标成「Cookie 缺少 cf_clearance」，顶栏把 JWT 剩余天数（refresh_token 还剩 29 天）叠在这条错误下面，看起来像「导入丢了 Cookie」。其实 zip 里 Cookie 原样在，Token 也在。
6. **部署：** `start.sh` 第一优先 `tool/node/bin/node`。把官方 `node-v24.19.0-linux-x64` 解压到 `tool/node/`（gitignore，不入库）。不要用群晖 Node.js_v22 / v20 套件跑本服务。

硬约束补一条：**SA6400 上禁止用套件 Node 跑 iwara-api；CF 403 先看 `node -v`，再看 Cookie。**

---

## 11. 前端（gbmd 纯前端模板）

**不要再维护 1.0.0 那套自绘 header-nav。** 界面骨架来自：

`gbmd-project/docs/ui-template/`（index.html / style.css / favicon / 交互约定）

保留：

- 白天蓝白 / 夜间深色（`localStorage gbmd-theme`，进页防闪）
- header + 未设密码警告条 + 胶囊 tabs
- 四个 tab：⬇ 下载 / 📊 下载进度 / 🔍 搜索 / ⚙ 设置
- toast `showFeedback`、状态行 `setStatus`、任务进度条 / 每行 row-bar
- 登录页 `login.html`

裁掉香蕉网专属：游戏映射、角色下拉、找回模式、hash 反查、目录合并。

接回的模板功能（1.0.1+）：

- 搜索：关键词 + 按时间 + 普通/R18 + **选关注用户**（下拉组合框）+ 保存/清空/导入导出记录
- 设置：导出/导入用户数据 zip；**Cookie 留空不改**；组合文本拆开存
- 视频搜索列加封面缩略图（走 `/api/thumb` 代理）
- 登录后自动拉关注列表；头部 +N 后增量同步

`api(path, method, body)` 遇 401 → `/login.html`。不要加载 `mock-api.js`。

---

## 12. 配置文件与数据文件

### server/config.example.json（入库）

空凭证，`downloadPath` 用 `/path/to/your/Iwara/`。真实 `config.json` gitignore。

| 字段 | 说明 |
|---|---|
| `port` | 默认 8643 |
| `iwaraToken` | refresh_token |
| `iwaraAccessToken` | 由 refresh_token 自动刷新，服务自己写 |
| `iwaraCookie` | 完整 Cookie；过期/`deleted` 的 `_ga` 不要传给 aria2 |
| `downloadBackend` | `direct` / `aria2` |
| `concurrency` | 直连并发，1~8 |
| `aria2Path` | JSON-RPC URL |
| `aria2Token` | 不含 `token:` 前缀 |
| `downloadPath` | direct=本机路径；aria2=aria2 机器路径 |
| `fileNameTemplate` | 见 §10.5 |
| `useAuthorSubdir` | 默认 false |
| `sessionHours` | 默认 72 |
| `checkDownloadLink` | 预留，当前 false |

### GitHub 推送凭据

项目根 `.git-push-token`（一行 `ghp_` / `github_pat_`，gitignore）。

```bash
bash scripts/git-push.sh
```

临时 credential store：`.git-credentials-local`（trap 删除）。

---

## 13. 注意事项/坑

细节以 `TROUBLESHOOTING.md` 为准。开发时硬约束：

1. **UA 只许精简版**，完整 Chrome UA = 403。
2. **CF 边缘 IP 从配置读（`iwaraCfgIp`），代码不写死；IP 直连 + SNI + Host**，不要修系统 DNS、不要 Node 24 lookup。
3. **每次下载必须 fresh `getVideoInfo`**，禁止复用 URL。
4. 搜索关键词走 `/search?query=`，禁止 `/videos?search=`。
5. `useAuthorSubdir` 默认否，代码必须读配置，不要写死 true。
6. 改代码后同步运行副本并在 **SA6400** 上 **重启**，看 PID 是否变化。不要在 fnOS 再起一份。
7. aria2：UA header、DSM 证书、`dir` 权限、`aria2Dns` → `<iwaraCfgIp>`。
8. 用户数据（config / cookie / token / 任务 / 搜索缓存 / `.git-push-token` / `iwara-index.json` / `sessions.json`）全部 gitignore。
9. 前端交给模板复用：先改 `docs/ui-template` 对应结构，不要另起一套 DOM。
10. **Cookie 保存填组合文本**：多行 `Cookie=...\nToken=...\nAccessToken=...` 会被拆开存；留空不覆盖。
11. **关注列表增量同步**：落 `following_cache.json`，内存 10 分钟 TTL；首次全量，之后只拉头部新增。
12. **跳过已下载只认文件或 Aria2 记录**，索引不能当跳过依据（Aria2 记录可被用户清掉）。
13. 文件名模板不要写 `.mp4`，`applyFileNameTemplate` 落盘时自动补。
14. 设置页下载根目录用 `/api/browse` 选的是**跑服务那台机器**上的路径；Aria2 后端必须让服务和 Aria2 看到同一块盘。
15. **SA6400 必须用 Node 24**（`tool/node`）。套件 Node 22 / curl 打 `api.iwara.tv` = CF 挑战，与 Cookie 无关。Aria2 能下视频不能当 API 已通。见 §10.7。
16. 导入 zip 必须立刻 `checkLogin({force:true})` 并看返回的 `login`，不能只看 `restored` 文件列表。

**改动后必测**

1. `node --check` 相关 js
2. `getVideoInfo` 200 且有 downloadUrl
3. 关键词「奥黛塔」条数与官网一致
4. `POST /api/download` 用网页 API，不手搓过期链接
5. aria2 场景：tellStatus 有 totalLength 且能 complete
6. 新建 `following_cache.json` 后重启，页面显示关注数量正确
7. SA6400：`./start.sh` 打印的 Node 必须是 v24.x；`GET /api/account-check` 在无 cf_clearance 时也能 `loggedIn:true`
8. `POST /api/data/import` 返回体含 `login.loggedIn`，不能只看 restored

---

## 14. 变更日志

### 1.0.5（本次）

| 项 | 说明 |
|---|---|
| 运行位置 | 正式进程改到群晖 SA6400（`/volume6/Game.Patch N MOD/iwara-downloader-server`），与 Aria2 / 下载盘同机，目录选择和「文件已存在跳过」才能看见 `/volume3/WORKGROUP/` |
| 启停脚本 | 改单脚本子命令（对照 gbmd start-linux.sh）：`start.sh [start|stop|restart|status] [--port]`，无参默认 restart；`stop.sh/restart.sh/status.sh` 保留为薄壳；补 `start-macos.sh`（Homebrew/nvm）与 `start-windows.bat` / `start-windows-background.bat` |
| 跳过已下载 | **不看索引**。本机文件名含 `[视频id]` 的非空视频，或 Aria2 活动/等待/已完成记录命中，才跳过、不再 `addUri` |
| 目录选择 | 设置页下载根目录 📂，对照 gbmd：`GET /api/browse?path=` + 弹窗 |
| 文件名模板 | 默认 `Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]`，不要写 `.mp4`；设置页列出全部变量 |
| 顶栏 | 标题三行；用户名 / 剩余天数分行；年月日 / 时分秒分行；油猴 📥 / 油猴脚本分行 |
| 关键词搜索 | 下拉 type=videos\|users；视频 `sort=date`，作者 `sort=relevance`；关注列表只在作者模式加载；与按时间搜索互不干扰 |
| 视频索引 | 自己生成精简 `{id:{name,username,title,fileId,duration,tags,createdAt}}`；兼容读取别人完整 dump；sidecar 经 HMAC 短链推给 Aria2 |
| 账号检测 | 只保留 `GET /api/account-check`（旧 `/api/iwara-check` 已删） |
| 用户数据 zip | 清单增加 `iwara-index.json`、`sessions.json`；**导入后立刻 `checkLogin({force:true})`，返回 `login`** |
| Node 运行时 | 项目 `tool/node/` 放官方 Node 24（gitignore）。群晖套件 Node 22 打 `api.iwara.tv` 会被 CF 挑战；Node 24 + 泛解析 104.26.12.12 **不需要 cf_clearance**。完整对照见 §10.7 |

### 1.0.2

| 项 | 说明 |
|---|---|
| 关注列表 | 增量同步 `following_cache.json`；首次全量，之后只拉头部新增；原有+新增<总数才往后翻页补齐 |
| 搜索封面 | 结果行加缩略图；公开接口 `GET /api/thumb` 走本机 IP 直连 |
| 搜索栏 | 「选关注用户」下拉组合框：登录后拉关注列表，输入过滤，选中后填入用户名并搜索 |
| Cookie 保存 | 修复「保存后回填旧值」：GET /api/settings 脱敏不回明文；留空不改；组合文本拆存；config.js 加 `iwaraAccessToken` 字段 |
| 登录态 | `checkLogin` 自动刷新 access_token；401 时再刷一次重试 |
| 鉴权 | `publicSettings()` 提到模块顶层，返回含 `hasCookie`/`hasToken`/`hasAria2Token` 标志 |

### 1.0.1

| 项 | 1.0.0 | 1.0.1 |
|---|---|---|
| 前端 | 自绘简单页 | **整份替换为 gbmd `docs/ui-template` 骨架** |
| 搜索 | 仅关键词一页 | 按时间翻页、普通/R18、保存/导入导出记录 |
| 用户数据 | 仅清单文件 | `/api/data/export|import` zip |
| 搜索端点 | 已修 `/search?query=` | 同左，并加 `rating` |
| CDN | 静态列表 | GOOD/BAD 持久化 `cdn_hosts_state.json` |
| aria2 | 初版 | 精简 UA、忽略自签证书、dns-server、不传垃圾 Cookie |
| 文件名 | 油猴模板 | 同左；`useAuthorSubdir` 默认 false |
| 文档 | README | + TROUBLESHOOTING + 本开发者文档 |
| 推送 | 无 | `scripts/git-push.sh` + `.git-push-token` |

---

**不要提交**：`server/config.json`、任务/缓存 json、日志、视频、token 文件、`following_cache.json`（用户凭据衍生产物）。
