// ============================================================
// iwara-downloader-server - Iwara API 封装（零依赖 Node 18+）
// 移植自 IwaraDownloadTool 油猴脚本：src/network/auth.ts + video.ts + xVersion.ts
//
// 关键机制（逆向自油猴脚本）：
//   1. X-Version 请求头 = SHA1([pathname末尾段, expires, 密钥].join('_'))
//      密钥: mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN
//   2. 视频直链：/api/video/{id} → RAW.fileUrl → 源列表 JSON → 按优先级选 src.download
//      DownloadUrl = decodeURIComponent("https:" + src.download)
//   3. 登录态：refresh_token(localStorage 'token') → POST /user/token → access_token
//   4. ⚠️ CF 挑战：必须用 Node 原生 https（OpenSSL TLS 指纹）——Cloudflare 对
//      undici fetch 指纹触发 JS 挑战，对 OpenSSL 指纹放行（2026-08 实测）。
//      无需 cf_clearance cookie 即可直连 api.iwara.tv。
// ============================================================
"use strict";

const crypto = require("crypto");
const https = require("https");
const dns = require("dns");
const zlib = require("zlib");

const cfg = require("../config");

const API_HOST = "api.iwara.tv";
const X_VERSION_SECRET = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";
// ⚠️ UA 必须不带 "AppleWebKit/537.36 (KHTML, like Gecko)" 片段！
// 实测（2026-08）：完整 Chrome UA 被 CF 挑战拦截(403)，
// 而精简 UA "Mozilla/5.0 ... Chrome/126.0.0.0 Safari/537.36" 直接放行(200/401)。
// CF 的 bot 检测对常见抓包 UA 反而更警惕。
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36";
// Cloudflare 边缘 IP（由 vhosts.js /hosts 托管块管理）
// Virtual Hosts APK 原理：本地 DNS 拦截 → 命中规则返回固定 IP → 应用层直连该 IP
// 这里在应用层做同样的事：跳过系统 DNS（防污染），用 IP 直连 + SNI/Host header
const IWARA_CF_IP = "104.26.12.12";
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 32 });

// ---------- X-Version 签名（与油猴 xVersion.ts 完全一致） ----------
function getXVersion(urlString) {
  const u = new URL(urlString);
  const file = u.pathname.split("/").pop() || "";
  const expires = u.searchParams.get("expires") || "";
  const data = Buffer.from([file, expires, X_VERSION_SECRET].join("_"), "utf8");
  return crypto.createHash("sha1").update(data).digest("hex");
}

// ---------- 请求头 ----------
function configHeaders(urlString, withAuth) {
  const c = cfg.readConfig();
  const headers = {
    "User-Agent": DEFAULT_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.iwara.tv/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site"
  };
  // Cookie（含 cf_clearance 过 CF 挑战；token 登录态一并带上）
  if (c.iwaraCookie) headers["Cookie"] = c.iwaraCookie;
  if (withAuth && urlString) headers["X-Version"] = getXVersion(urlString);
  // 诊断日志：确认发送了什么（不打印完整敏感值，只打标记）
  try {
    const ck = headers["Cookie"] || "";
    console.log(`[iwara-api] → ${urlString && urlString.split("?")[0]} | UA: ${(headers["User-Agent"] || "").slice(0, 40)}... | cookie ${ck.length}B | cf_clearance: ${ck.includes("cf_clearance") ? "YES" : "NO"}`);
  } catch (_) {}
  return headers;
}

// ---------- 原生 https JSON 请求（替代 undici fetch，规避 CF 挑战） ----------
function httpsJson(url, opts = {}) {
  const { retries = 3, timeoutMs = 30000, withAuth = true, method = "GET", body } = opts;
  const headers = Object.assign(configHeaders(url, withAuth), opts.headers || {});

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let timer = null;

    const done = (err, data) => {
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };

    const attemptOnce = () => {
      const u = new URL(url);
      const isPost = method === "POST" || method === "PUT" || method === "PATCH";
      const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
      if (payload && isPost) headers["Content-Type"] = headers["Content-Type"] || "application/json";

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        req.destroy(new Error("超时: " + url));
      }, timeoutMs);

      const req = https.request(
        {
          host: IWARA_CF_IP,
          port: u.port || 443,
          path: u.pathname + u.search,
          method,
          headers: Object.assign({ Host: u.hostname }, headers),
          agent: HTTPS_AGENT,
          servername: u.hostname
        },
        (res) => {
          const chunks = [];
          const collect = (s) => {
            s.on("data", (c) => chunks.push(c));
            s.on("end", () => {
              let buf = Buffer.concat(chunks);
              const enc = String(res.headers["content-encoding"] || "");
              const finish = (finalBuf) => {
                const text = finalBuf.toString("utf8");
                if (res.statusCode === 403) {
                  return done(new Error("CF_CHALLENGE:" + (text.includes("Just a moment") ? "cloudflare js challenge" : "http 403")));
                }
                if (res.statusCode === 204) return done(null, null);
                if (res.statusCode >= 400) {
                  return done(new Error(`HTTP ${res.statusCode} for ${url}`));
                }
                try {
                  done(null, text ? JSON.parse(text) : null);
                } catch (e) {
                  done(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${text.slice(0, 120)}`));
                }
              };
              if (enc === "gzip") zlib.gunzip(buf, (e, out) => finish(e ? buf : out));
              else if (enc === "deflate") zlib.inflate(buf, (e, out) => finish(e ? buf : out));
              else finish(buf);
            });
          };
          collect(res);
        }
      );
      req.on("error", (e) => {
        if (timer) clearTimeout(timer);
        const netErr = e instanceof TypeError || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|超时/i.test(String(e.message || ""));
        const maxAttempts = netErr ? retries + 2 : retries;
        if (attempt >= maxAttempts) return done(e);
        attempt++;
        const delay = netErr ? 1200 * Math.pow(2, Math.min(attempt, 4)) : 800 * Math.pow(2, Math.min(attempt, 4));
        setTimeout(attemptOnce, delay);
      });
      if (payload) req.write(payload);
      req.end();
    };

    attemptOnce();
  });
}

/** 兼容旧接口签名（async fetchJson） */
async function fetchJson(url, opts = {}) {
  // CF 挑战不重试
  const inline = (o) =>
    httpsJson(url, o).catch((e) => {
      if (String(e.message || "").startsWith("CF_CHALLENGE")) throw e;
      throw e;
    });
  return inline(opts);
}

// ============================================================
// 认证
// ============================================================

/** 检测登录态：GET /user 200 = 已登录，403 CF 挑战 = cookie 失效 */
async function checkLogin() {
  try {
    const user = await fetchJson(`https://${API_HOST}/user`, { withAuth: false, retries: 1 });
    return { ok: true, loggedIn: true, user: user && (user.name || user.username || user) };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("CF_CHALLENGE")) return { ok: false, loggedIn: false, cfChallenge: true, error: "Cloudflare 挑战未通过：Cookie 缺少 cf_clearance 或已过期" };
    return { ok: false, loggedIn: false, error: msg };
  }
}

/**
 * 获取视频信息（移植自油猴 src/network/video.ts parseVideoInfo full 分支）
 * @param {string} id - 视频 ID
 * @returns {Promise<Object>} { type:'full', id, title, author, uploadTime, file:{name,size}, downloadUrl, quality, raw }
 */
async function getVideoInfo(id) {
  const raw = await fetchJson(`https://${API_HOST}/video/${id}`, { retries: 2 });

  // 外链视频（embedUrl）→ 无直链
  if (raw.embedUrl) {
    return { type: "external", id, title: raw.title, author: raw.user?.username, embedUrl: raw.embedUrl };
  }

  // 源列表：RAW.fileUrl（如 /file/{hash}）
  const fileUrl = raw.fileUrl;
  if (!fileUrl) throw new Error("视频缺少 fileUrl 字段");

  const sources = await fetchJson(fileUrl.startsWith("http") ? fileUrl : `https://${API_HOST}${fileUrl}`, {
    withAuth: true,
    retries: 2
  });

  if (!Array.isArray(sources) || sources.length === 0) throw new Error("无可用视频源");

  // 优先级：Source(100) > 540(99) > 360(98) > preview(1)；默认优先 source
  const PRIORITY = { Source: 100, "540": 99, "360": 98, preview: 1 };
  const sorted = sources.slice().sort((a, b) => (PRIORITY[b.name] ?? 0) - (PRIORITY[a.name] ?? 0));
  const best = sorted[0];
  if (!best || !best.src || !best.src.download) throw new Error("源缺少 download 字段");

  const downloadUrl = decodeURIComponent(`https:${best.src.download}`);

  return {
    type: "full",
    id,
    title: raw.title,
    author: raw.user?.username,
    alias: raw.user?.name,
    authorId: raw.user?.id,
    uploadTime: new Date(raw.createdAt ?? 0).getTime(),
    description: raw.body,
    private: !!raw.private,
    unlisted: !!raw.unlisted,
    thumbnail: raw.thumbnail,
    file: { name: raw.file?.name, size: raw.file?.size },
    quality: best.name,
    downloadUrl,
    raw
  };
}

// ============================================================
// 列表 / 搜索
// ============================================================

/**
 * 视频列表 / 搜索（iwara /videos 接口）
 * @param {Object} q - { sort:'date'|'trending'|'views'|'rating', page, limit, user, subscribed, type, search, rating }
 */
async function listVideos(q = {}) {
  const params = new URLSearchParams();
  params.set("page", String(q.page ?? 0));
  params.set("limit", String(q.limit ?? 20));
  if (q.sort && !q.search) params.set("sort", q.sort || "date");
  if (q.user) params.set("user", q.user);
  if (q.subscribed) params.set("subscribed", "true");
  if (q.type) params.set("type", q.type);
  if (q.rating && q.rating !== "all") params.set("rating", q.rating);
  // 关键词搜索必须走 /search 端点（type=videos + query），
  // /videos?search= 的结果不相关（实测「奥黛塔」只返回无关内容）。
  // 参考网页搜索：https://www.iwara.tv/search?type=videos&page=0&query=奥黛塔
  if (q.search) {
    params.set("type", q.type || "videos");
    params.set("query", q.search);
    const url = `https://${API_HOST}/search?${params.toString()}`;
    console.log(`[iwara-api] listVideos(search): ${url}`);
    const data = await fetchJson(url, { withAuth: false, retries: 2 });
    return data; // { results:[Video], count, page, limit }
  }
  const url = `https://${API_HOST}/videos?${params.toString()}`;
  console.log(`[iwara-api] listVideos: ${url}`);
  const data = await fetchJson(url, { withAuth: false, retries: 2 });
  return data; // { results:[Video], count, page, limit }
}

/** 用户资料（含 id → username 转换 / 用户视频） */
async function getUserProfile(usernameOrId) {
  return await fetchJson(`https://${API_HOST}/user/${usernameOrId}`, { withAuth: false, retries: 2 });
}

/** 评论分页（每页全部回复递归合并为纯文本，供网盘链接探测） */
async function getComments(id) {
  const out = [];
  let page = 0;
  for (;;) {
    const data = await fetchJson(`https://${API_HOST}/video/${id}/comments?page=${page}&limit=50`, { withAuth: false, retries: 1 });
    const results = data.results || [];
    for (const c of results) {
      out.push(c.body || c.text || "");
      for (const r of c.children || []) out.push(r.body || r.text || "");
    }
    if (!data.hasNext || results.length === 0) break;
    page++;
    if (page > 50) break;
  }
  return out.join("\n");
}

module.exports = { getXVersion, checkLogin, getVideoInfo, listVideos, getUserProfile, getComments, API_HOST, DEFAULT_UA, IWARA_CF_IP };