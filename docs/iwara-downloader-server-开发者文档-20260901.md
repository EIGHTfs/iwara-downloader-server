# iwara-downloader-server 开发者文档

> 版本：**1.0.2**（2026-09-01）
> 运行环境：fnOS / Node.js v18+（实测 Node v24.19.0），零依赖 HTTP 服务，默认端口 8643
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
11. [前端（gbmd 纯前端模板）](#11-前端gbmd-纯前端模板)
12. [配置文件与数据文件](#12-配置文件与数据文件)
13. [注意事项/坑](#13-注意事项坑)
14. [变更日志](#14-变更日志)

---

## 1. 项目结构

```
iwara-downloader-server/
├── start.sh / stop.sh / restart.sh / status.sh
├── scripts/git-push.sh                 # 读项目根 .git-push-token 推 origin + tags
├── scripts/iwara-cred-fetch.user.js    # 油猴脚本（凭证 + 一键发送 /api/receive）
├── userdata-manifest.json              # 用户数据清单（备份/恢复按此收集）
├── TROUBLESHOOTING.md                  # 踩坑：UA / IP 直连 / DNS / 链接过期 / aria2
├── docs/                               # 开发者文档（本文件）
├── iwara-cred.bookmarklet.js           # 书签方案
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
    │   └── data-backup.js              # zip 备份/恢复（对照 gbmd）
    └── public/                         # 网页前端（骨架来自 gbmd docs/ui-template）
        ├── index.html / app.js / style.css / favicon.png
        └── login.html
```

---

## 2. 启动/停止/状态

```bash
cd /path/to/iwara-downloader-server
./start.sh          # 后台启动，写 server/app.pid
./stop.sh           # 读 pid 发 SIGTERM
./restart.sh        # stop + start
./status.sh         # 打印进程 / 端口 / 是否在线
```

多份副本并存机制：每个副本独立 `config.json` + pid 文件。本机开发在 `/vol1/.../会话/iwara-downloader-server/`，NAS 运行时在 `/vol02/1000-0-1c60be7b/iwara-downloader-server/`，改完必须 `cp` 两份 + `./restart.sh`。

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
| GET | `/api/iwara-check` | 是 | 登录态检测 |
| GET | `/api/following` | 是 | 关注用户列表（增量同步） |
| GET | `/api/videos` | 否 | 视频列表（关键词走 `/search?query=`） |
| POST | `/api/search` | 是 | 按时间后台翻页 |
| GET | `/api/search-status` | 是 | 查询任务进度 |
| POST | `/api/search/stop` | 是 | 停止搜索 |
| GET | `/api/search/cache` | 是 | 查缓存 |
| POST | `/api/search/save` | 是 | 保存缓存 |
| POST | `/api/search/import` | 是 | 导入记录（按 id 合并覆盖） |
| GET | `/api/search/export` | 是 | 下载 JSON |
| POST | `/api/search/clear` | 是 | 清缓存 |
| GET | `/api/video-info` | 是 | 解析单视频直链 |
| POST | `/api/download` | 是 | 提交下载任务 |
| POST | `/api/receive` | 是 | 油猴专用接收口（规整后转发给 `/api/download`） |
| GET | `/api/task` | 是 | 查询任务状态 |
| POST | `/api/task/pause` | 是 | 暂停 |
| POST | `/api/task/resume` | 是 | 继续 |
| POST | `/api/task/stop` | 是 | 停止 |
| POST | `/api/task/retry` | 是 | 重跑失败项 |
| POST | `/api/task/concurrency` | 是 | 改并发数 |
| GET | `/api/data/export` | 是 | 下载用户数据 zip |
| POST | `/api/data/import` | 是 | 导入用户数据 zip |

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
    "fileNameTemplate": "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4",
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

### GET /api/iwara-check

```json
// 未配置
{ "ok": true, "cookieSet": false, "checked": false, "message": "未配置 Cookie / Token" }

// 已登录
{ "ok": true, "cookieSet": true, "checked": true, "loggedIn": true,
  "user": "fluquormyosotis", "userId": "c1d1cf1f-...", "username": "fluquormyosotis" }

// CF 挑战
{ "ok": false, "loggedIn": false, "cfChallenge": true,
  "error": "Cloudflare 挑战未通过：Cookie 缺少 cf_clearance 或已过期" }
```

内部会先 `ensureAccessToken`（用 iwaraToken 刷 access_token 并持久化）。401 时自动再刷一次重试。

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

按 zip 内（或当前项目）清单白名单写回。返回 `{ ok, restored:[], skipped:[], note }`。运行中导入 config/任务后建议 `./restart.sh`。

当前清单 `files`：

- `server/config.json`
- `server/download_task.json`
- `server/search_cache.json`
- `server/search_task.json`
- `server/cdn_hosts_state.json`
- `server/following_cache.json`
- `server/server.log`
- `server/app.pid`

全部 gitignore，**禁止入库**。`.git-push-token` 不进备份清单（推送凭据只留本机，不随用户数据 zip 导出）。

---

## 10. 下载流程详解（重点）

```
items[]
  → 校验 downloadPath
  → 按 useAuthorSubdir 拼 savePath（默认否：直接根目录）
  → 对每一项：
       getVideoInfo(id)                    // 必须每次 fresh
       applyFileNameTemplate(...)          // Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4
       direct: downloadToFile（IP 直连 + Range + 子域轮换）
       aria2:  aria2.addUri（UA header + dir + 可选 Cookie）
```

### 10.1 IP 直连（Virtual Hosts 的应用层实现）

系统 DNS 污染 `*.iwara.tv`（223.5.5.5 / 8.8.8.8 / 1.1.1.1 都不准）。Node **禁止自定义 lookup**（Node 24 会炸）。一律：

```js
https.request({
  host: "104.26.12.12",
  servername: "<真实域名>",          // TLS SNI
  headers: { Host: "<真实域名>", "User-Agent": DEFAULT_UA }
})
```

`IWARA_CF_IP = "104.26.12.12"`。

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
默认：`Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4`。
非法字符替换为 `_`。`useAuthorSubdir` 默认 **false**。

### 10.6 aria2 后端

- RPC：`https.request`，DSM 自签证书 `rejectUnauthorized:false`（不要用 undici fetch）
- token：`params: ["token:"+aria2Token, [uris], options]`，不要放 query string
- `options.dir` = **aria2 机器上的路径**（群晖例 `/volume3/WORKGROUP/`）
- `options.header` = `User-Agent: <精简 UA>`；仅当 Cookie 含 `cf_clearance` 且不含 `deleted` 才附带 Cookie
- `options["dns-server"]` = `10.10.10.64`（群晖 DNS Server：`iwara.tv * A 104.26.12.12`）
- aria2 自己做 DNS：NAS 系统 DNS 必须能把 `*.iwara.tv` 解到 `104.26.12.12`；`127.0.0.1#53` 未监听时用套件地址
- 提交成功后本服务标 `submitted`；真实进度在 Aria2 WebUI
- 写目录权限不够时表现为拿到 Content-Length 后速度 0 / abort——先给目标目录写权限

实测（权限放开后）：`KzQf3RIaBEf5vL` → 107,512,609 bytes complete，路径
`/volume3/WORKGROUP/Iwara_-_奥黛塔 经纪人的性爱计划 Day1_[KzQf3RIaBEf5vL]_[Source].mp4`

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
2. **IP 直连 104.26.12.12 + SNI + Host**，不要修系统 DNS、不要 Node 24 lookup。
3. **每次下载必须 fresh `getVideoInfo`**，禁止复用 URL。
4. 搜索关键词走 `/search?query=`，禁止 `/videos?search=`。
5. `useAuthorSubdir` 默认否，代码必须读配置，不要写死 true。
6. 改代码后同步运行副本并 **重启**，看 PID 是否变化。
7. aria2：UA header、DSM 证书、`dir` 权限、NAS DNS → 104.26.12.12。
8. 用户数据（config / cookie / token / 任务 / 搜索缓存 / `.git-push-token`）全部 gitignore。
9. 前端交给模板复用：先改 `docs/ui-template` 对应结构，不要另起一套 DOM。
10. **Cookie 保存填组合文本**：多行 `Cookie=...\nToken=...\nAccessToken=...` 会被拆开存；留空不覆盖。
11. **关注列表增量同步**：落 `following_cache.json`，内存 10 分钟 TTL；首次全量，之后只拉头部新增。

**改动后必测**

1. `node --check` 相关 js
2. `getVideoInfo` 200 且有 downloadUrl
3. 关键词「奥黛塔」条数与官网一致
4. `POST /api/download` 用网页 API，不手搓过期链接
5. aria2 场景：tellStatus 有 totalLength 且能 complete
6. 新建 `following_cache.json` 后重启，页面显示关注数量正确

---

## 14. 变更日志

### 1.0.2（本次）

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
