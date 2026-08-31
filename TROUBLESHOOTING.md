# Iwara 下载踩坑记录（必读！）

> 本文档记录开发/部署 iwara-downloader-server 过程中踩过的所有坑和最终有效的方案。
> 每次改动涉及以下任一环节时，先读本文档，避免重复踩坑。

---

## 1. User-Agent 规律（最容易反复踩的坑！）

**结论：必须用「精简 UA」，绝不能用「完整 Chrome UA」。**

| 请求体 | UA | 结果 |
|---|---|---|
| Node https | 完整 UA（含 `AppleWebKit/537.36 (KHTML, like Gecko)`） | ❌ 403（CF 挑战） |
| Node https | 精简 UA `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36` | ✅ 200/401 通过 |
| curl / aria2 无 UA | `aria2/1.37.0` 等 | ❌ 403 |
| aria2 带精简浏览器 UA | 同精简 UA | ✅ 通过 |

**精简 UA 标准值（DEFAULT_UA，iwara-api.js）：**
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36
```
**注意：不要试图加回 `AppleWebKit/537.36 (KHTML, like Gecko)`，也不要加 `X11; Linux x86_64` 等扩展——越精简越稳。**

适用位置：
- `server/lib/iwara-api.js` 的 API 请求（getVideoInfo / listVideos 等）
- `server/lib/downloader.js` 的 direct 下载
- **aria2 推送时必须在 `header` 选项里带 UA**（aria2 默认 UA 会被 CF 403 拦截）

---

## 2. Cloudflare 挑战绕过核心：IP 直连 + SNI + Host

iwara.tv 全套在 Cloudflare 后面，而 DNS 被污染，所以：
1. **不通过系统 DNS 解析**，直接连 Cloudflare 边缘 IP `104.26.12.12`
2. TLS 用 `servername: <真实域名>` 保留 SNI
3. HTTP 头带 `Host: <真实域名>` 让虚拟主机识别
4. UA 用精简版（见上）

```js
https.request({
  host: "104.26.12.12",      // IP 直连，绕开 DNS
  servername: "api.iwara.tv", // TLS SNI 保持域名
  headers: { Host: "api.iwara.tv", "User-Agent": DEFAULT_UA, ... }
})
```

**这就是 Virtual Hosts APK 原理的应用层实现。任何下载请求都必须走这条路径，不要走系统 DNS。**

群晖 DNS Server 把 `*.iwara.tv` 泛解析到 `104.26.12.12` 之后，Node `dns.lookup('api.iwara.tv')` 就是这个 IP，和代码里写死 IP 是同一件事。

**Node 版本比 Cookie 更关键：**

| 运行时 | `GET https://api.iwara.tv/user`（精简 UA、无 cf_clearance） |
|---|---|
| Node 24（官方 linux-x64 / fnOS `/usr/bin/node`） | ✅ 200 / 401 JSON |
| 群晖 Node.js_v22 套件、curl 7.86 | ❌ 403 `cf-mitigated: challenge` |

Aria2 能下视频 ≠ API 能登录：Aria2 打的是 CDN 文件站，登录走 `api.iwara.tv`。SA6400 上必须用项目自带 `tool/node`（Node 24）启动。

---

## 3. DNS 污染

- 系统 DNS（阿里 223.5.5.5/223.6.6.6）把 iwara 的 CDN 子域解析到 Facebook/Twitter IP 段
  （31.13.x.x / 108.160.x.x / 199.59.x.x / 65.49.x.x / 2001:: 等）
- 上游 8.8.8.8 / 1.1.1.1 返回的也各不相同（Anycast，且不一定可达），**都不保证正确**：
  - 8.8.8.8 → Azure 段（52.175.x.x）
  - 1.1.1.1 → Facebook 污染段
  - 223.5.5.5 → Twitter 污染段
- **结论：不要试图"修复 DNS"，一律 IP 直连 104.26.12.12**

如果必须走 DNS（如 aria2 这类独立进程），在局域网配自己的 DNS：
- **群晖 DNS Server 套件**：创建主区域 `iwara.tv`，加通配 A 记录 `* → 104.26.12.12`
  （实测泛解析对任何子域都返回 104.26.12.12，覆盖新出现的子域）
- 宿主 /etc/hosts：`104.26.12.12 .iwara.tv`（泛解析展开成已知子域列表）
- **aria2 场景注意**：aria2 进程解析域名用运行机（如群晖）的 DNS，必须让群晖自己的 DNS 指到
  `127.0.0.1`（DNS Server 套件本机），否则 aria2 仍走污染 DNS。

---

## 4. 下载链接会过期（必须每次重新获取）

- iwara 的 downloadUrl 带 `expires` 参数（Unix 秒），**几分钟内过期**
- **每次下载必须重新调用 `getVideoInfo(id)` 获取 fresh 链接**，绝不能复用旧 URL
- 旧链接 → 403/404（被服务器端拒）
- 代码：`runDownloadLoop` 里 direct/aria2 两个分支都要先 `getVideoInfo` 再下载

---

## 5. CDN 子域名差异（动态列表）

- 同一 IP 104.26.12.12 下，不同的 CDN 子域结果不同：
  - ✅ 正常：`api`、`www`、`firefly`、`aiko`、`filesq`、`pela`、`phoebe`、`topaz`（带对 UA 时）
  - ❌ 部分子域 403（CF 挑战）：`naja` 等
- iwara 每次返回的 downloadUrl 子域**随机轮换**（naja/firefly/aiko/pela/phoebe/topaz…）
- 解决方案：**动态子域列表**（`server/cdn_hosts_state.json`，外部文件持久化）：
  - GOOD 成功列表：成功下载过的子域，优先使用
  - BAD 失败列表：403/超时子域，自动跳过
  - 下载失败自动换子域重试；成功/失败动态增删
  - **注意**：子域替换只对「链接未过期」时有效；链接过期了换哪个子域都没用

---

## 6. aria2 后端要点

- RPC 兼容 DSM 代理：`https://<NAS>:5001/webman/3rdparty/Aria2/aria2rpc_proxy.cgi`
- token 用 `params: ["token:xxx", ...]` 前缀方式（实测有效）
- **必须带精简浏览器 UA**（见第 1 节），否则 403
- 证书：DSM 自签名 → `rejectUnauthorized: false`
- 下载路径：用 aria2 的 `dir` 选项传 NAS 上的路径
- aria2 是独立进程，服务器提交后无法追踪进度，只标记 `submitted`

---

## 7. Node 24 的坑（程序化 DNS 全部失败，别再用）

- 自定义 `lookup` 回调 → `Invalid IP address: undefined`（callback 校验 bug）
- `dns.resolve4Sync` → "is not a function"
- `dns.resolve4(host, '8.8.8.8')` 签名不支持
- `dns.setServers` 后 resolve 仍失败
- **结论：不需要任何 DNS 编程，全部 `host: 104.26.12.12` IP 直连**

---

## 8. 环境信息

- fnOS（Debian bookworm，Node v24.19.0）：SSH `fnOS@fnos.local`（10.10.10.4）
- 群晖 NAS：`sa6400.local`（10.10.10.64），DSM 5001，Aria2 套件
- iwara 边缘 IP：`104.26.12.12`
- 文件命名模板：`Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4`（学油猴脚本变量替换）

---

## 9. 快速验证清单（改动后必测）

1. `node --check` 语法
2. getVideoInfo 返回 200 且有 downloadUrl
3. 下载用 fresh 链接 + 精简 UA + IP 直连 → 200 video/mp4
4. aria2 场景：确认 aria2 带 UA header、群晖 DNS 解析到 104.26.12.12