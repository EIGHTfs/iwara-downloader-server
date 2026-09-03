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
const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const cfg = require("../config");
const jsonDir = require("./json-dir");
const DATA_DIR = jsonDir.SERVER_DIR;
const JSON_DIR = jsonDir.JSON_DIR;

const API_HOST = "api.iwara.tv";
const X_VERSION_SECRET = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";
// ⚠️ UA 必须不带 "AppleWebKit/537.36 (KHTML, like Gecko)" 片段！
// 实测（2026-08）：完整 Chrome UA 被 CF 挑战拦截(403)，
// 而精简 UA "Mozilla/5.0 ... Chrome/126.0.0.0 Safari/537.36" 直接放行(200/401)。
// CF 的 bot 检测对常见抓包 UA 反而更警惕。
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36";
// Cloudflare 边缘 IP：不写死，从 config.json 的 iwaraCfgIp 读取（默认 104.26.12.12）。
// Virtual Hosts APK 原理：本地 DNS 拦截 → 命中规则返回固定 IP → 应用层直连该 IP
// 这里在应用层做同样的事：跳过系统 DNS（防污染），用 IP 直连 + SNI/Host header
function getCfIp() {
  const v = String(cfg.readConfig().iwaraCfgIp || "").trim();
  return v || "104.26.12.12";
}
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
/** 发给 Iwara 的 Cookie：丢掉 deleted / 空值。IP 直连 + 精简 UA 不依赖 cf_clearance；残 Cookie 才可能害事。 */
function cookieForRequest(raw) {
  const ck = String(raw || "").trim();
  if (!ck) return "";
  return ck.split(";").map((s) => s.trim()).filter((p) => {
    if (!p) return false;
    if (/deleted/i.test(p)) return false;
    const eq = p.indexOf("=");
    const v = eq >= 0 ? p.slice(eq + 1).trim() : "";
    return !!v;
  }).join("; ");
}

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
  const ck = cookieForRequest(c.iwaraCookie);
  if (ck) headers["Cookie"] = ck;
  if (c.iwaraAccessToken) headers["Authorization"] = "Bearer " + c.iwaraAccessToken;
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
  const headers = Object.assign({}, configHeaders(url, withAuth), opts.headers || {});

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
          host: getCfIp(),
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
                if (res.statusCode === 204 || res.statusCode === 201) return done(null, text ? (() => { try { return JSON.parse(text); } catch (_) { return null; } })() : null);
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

/** refresh_token → access_token（油猴 localStorage token） */
async function ensureAccessToken(force) {
  const c = cfg.readConfig();
  const exp = jwtExpMs(c.iwaraAccessToken);
  const stillGood = c.iwaraAccessToken && exp && exp - Date.now() > 60 * 1000;
  if (!force && stillGood) return c.iwaraAccessToken;
  if (!c.iwaraToken) return c.iwaraAccessToken || "";
  const data = await fetchJson(`https://${API_HOST}/user/token`, {
    method: "POST",
    withAuth: false,
    retries: 1,
    headers: { Authorization: "Bearer " + c.iwaraToken },
    body: {}
  });
  const access = data && data.accessToken;
  if (!access) throw new Error("刷新 accessToken 失败");
  c.iwaraAccessToken = access;
  cfg.writeConfig(c);
  return access;
}

function unwrapUser(raw) {
  if (!raw) return null;
  if (raw.user && (raw.user.id || raw.user.username)) return raw.user;
  if (raw.id || raw.username) return raw;
  return null;
}

function jwtExpMs(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return 0;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const p = JSON.parse(json);
    return p && p.exp ? p.exp * 1000 : 0;
  } catch (_) { return 0; }
}

const LOGIN_WARN_DAYS = 7;

function loginExpiryMeta(c) {
  const expiresAt = jwtExpMs(c && c.iwaraToken) || jwtExpMs(c && c.iwaraAccessToken) || 0;
  const remainingMs = expiresAt ? expiresAt - Date.now() : 0;
  const remainingDays = expiresAt ? remainingMs / 86400000 : null;
  let warnLevel = "unknown";
  if (!expiresAt) warnLevel = "unknown";
  else if (remainingMs <= 0) warnLevel = "expired";
  else if (remainingDays <= LOGIN_WARN_DAYS) warnLevel = "warn";
  else warnLevel = "ok";
  return { expiresAt, remainingMs, remainingDays, warnLevel, warnDays: LOGIN_WARN_DAYS };
}

function withExpiry(base) {
  return Object.assign({}, base, loginExpiryMeta(cfg.readConfig()));
}

function packUser(raw) {
  const user = unwrapUser(raw);
  const id = user && user.id;
  const loggedIn = !!(id && user.role !== "anonymous");
  return {
    ok: loggedIn,
    loggedIn,
    user: loggedIn ? (user.name || user.username || user.id) : "",
    userId: loggedIn ? id : "",
    username: loggedIn ? (user.username || "") : ""
  };
}

async function fetchUserMe() {
  return fetchJson(`https://${API_HOST}/user`, { withAuth: false, retries: 1 });
}

/** 检测登录态：先刷 access_token，再 GET /user。导入配置后应 force 刷新。 */
async function checkLogin(opts) {
  const force = !!(opts && opts.force);
  try {
    try { await ensureAccessToken(force); } catch (e) {
      const msg = String(e.message || e);
      if (msg.startsWith("CF_CHALLENGE")) return withExpiry({ ok: false, loggedIn: false, cfChallenge: true, error: "Cloudflare 挑战未通过（Node TLS 指纹，与 Cookie 无关）" });
      if (!cfg.readConfig().iwaraToken) return withExpiry({ ok: false, loggedIn: false, error: msg });
    }
    const raw = await fetchUserMe();
    return withExpiry(packUser(raw));
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("CF_CHALLENGE")) return withExpiry({ ok: false, loggedIn: false, cfChallenge: true, error: "Cloudflare 挑战未通过（Node TLS 指纹，与 Cookie 无关）" });
    if (/HTTP 401/.test(msg) && cfg.readConfig().iwaraToken) {
      try {
        await ensureAccessToken(true);
        const raw = await fetchUserMe();
        return withExpiry(packUser(raw));
      } catch (e2) {
        const m2 = String(e2.message || e2);
        if (m2.startsWith("CF_CHALLENGE")) return withExpiry({ ok: false, loggedIn: false, cfChallenge: true, error: "Cloudflare 挑战未通过（Node TLS 指纹，与 Cookie 无关）" });
        return withExpiry({ ok: false, loggedIn: false, error: m2 });
      }
    }
    return withExpiry({ ok: false, loggedIn: false, error: msg });
  }
}

/**
 * 关注列表：按关注时间新→旧。落盘增量同步，不要每次全量翻页。
 * 端点：GET /user/{id}/following
 *
 * 增量规则（列表按时间序）：
 *   1. 从第 0 页往后拉，直到碰上本地已有的用户 = 新增
 *   2. 合并 = 新增 + 原有（从重合点起）
 *   3. 若合并条数 < 远端 total → 中间有删关注，才继续往更旧的页找
 */
const FOLLOW_FILE = jsonDir.migrateRuntimeJson("following_cache.json");
const FOLLOW_LIMIT = 50;
let followingMem = null;

function mapFollowRow(r) {
  const u = unwrapUser(r) || r;
  const id = String((u && u.id) || "");
  const username = String((u && (u.username || u.name)) || "");
  if (!username && !id) return null;
  return {
    id,
    username,
    name: String((u && (u.name || u.username)) || username),
    following: true,
    createdAt: (r && r.createdAt) || (u && u.createdAt) || ""
  };
}

function followKey(u) {
  return String((u && (u.id || u.username)) || "");
}

function loadFollowingStore() {
  if (followingMem && followingMem.following) return followingMem;
  try {
    if (fs.existsSync(FOLLOW_FILE)) {
      const d = JSON.parse(fs.readFileSync(FOLLOW_FILE, "utf8"));
      if (d && Array.isArray(d.following)) {
        followingMem = d;
        return followingMem;
      }
    }
  } catch (_) {}
  followingMem = null;
  return null;
}

function saveFollowingStore(packed) {
  followingMem = packed;
  try {
    jsonDir.ensureJsonDir();
    fs.writeFileSync(FOLLOW_FILE, JSON.stringify({
      me: packed.me,
      following: packed.following,
      count: packed.count,
      updatedAt: new Date().toISOString()
    }), "utf8");
  } catch (e) {
    console.error("[iwara-api] 写入 following_cache.json 失败:", e && e.message);
  }
}

async function currentUser() {
  await ensureAccessToken(false);
  const meRaw = await fetchJson(`https://${API_HOST}/user`, { withAuth: false, retries: 1 });
  const me = unwrapUser(meRaw);
  if (!me || !me.id) throw new Error("未登录，无法获取关注列表");
  return me;
}

async function listFollowingPage(page, limit, meOpt) {
  const me = meOpt || await currentUser();
  const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 50));
  const pg = Math.max(0, parseInt(page, 10) || 0);
  const data = await fetchJson(`https://${API_HOST}/user/${encodeURIComponent(me.id)}/following?page=${pg}&limit=${lim}`, { withAuth: false, retries: 1 });
  const following = ((data && data.results) || []).map(mapFollowRow).filter(Boolean);
  return {
    me: { id: me.id, username: me.username, name: me.name },
    following,
    count: Number(data && data.count) || following.length,
    page: pg,
    limit: lim
  };
}

function packFollowing(me, list, total, extra) {
  return Object.assign({
    me,
    following: list,
    count: total != null ? total : list.length
  }, extra || {});
}

async function fetchFollowingPages(me, startPage, total, seen, out, maxPages) {
  let pages = 0;
  for (let page = startPage; page < maxPages && out.length < total; page++) {
    const data = await listFollowingPage(page, FOLLOW_LIMIT, me);
    pages++;
    if (Number.isFinite(data.count)) total = data.count;
    if (!data.following.length) break;
    for (const u of data.following) {
      const k = followKey(u);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
    if (data.following.length < FOLLOW_LIMIT) break;
  }
  return { total, pages };
}

/**
 * 增量同步：列表按关注时间新→旧。
 * 从 page0 拉到与本地重合 = 新增；合并 = 新增 + 原有（从重合点起）。
 * 仅当「原有+新增 < 远端总数」才继续往更旧的页找（中间有删关注或本地不完整）。
 */
async function syncFollowing(force) {
  const me = await currentUser();
  const meInfo = { id: me.id, username: me.username, name: me.name };
  const store = loadFollowingStore();
  const cached = (!force && store && store.me && store.me.id === me.id && Array.isArray(store.following))
    ? store.following
    : [];

  const first = await listFollowingPage(0, FOLLOW_LIMIT, me);
  const total = first.count || first.following.length;
  const maxPages = Math.min(120, Math.ceil((total || 1) / FOLLOW_LIMIT) + 2);

  if (!cached.length) {
    const out = first.following.slice();
    const seen = new Set(out.map(followKey).filter(Boolean));
    const r = await fetchFollowingPages(me, 1, total, seen, out, maxPages);
    const packed = packFollowing(meInfo, out, r.total, { synced: "full", fetchedPages: 1 + r.pages, added: out.length });
    saveFollowingStore(packed);
    console.log(`[iwara-api] following sync full: local=${out.length} remote=${r.total} pages=${1 + r.pages}`);
    return packed;
  }

  const cachedKey = new Set(cached.map(followKey).filter(Boolean));
  const prefix = [];
  const seen = new Set();
  let overlapKey = null;
  let page = 0;

  outer:
  for (; page < maxPages; page++) {
    const data = page === 0 ? first : await listFollowingPage(page, FOLLOW_LIMIT, me);
    const rows = data.following || [];
    if (!rows.length) break;
    for (const u of rows) {
      const k = followKey(u);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (cachedKey.has(k)) {
        overlapKey = k;
        break outer;
      }
      prefix.push(u);
    }
    if (rows.length < FOLLOW_LIMIT) break;
  }

  let merged;
  if (overlapKey) {
    const idx = cached.findIndex((u) => followKey(u) === overlapKey);
    const tail = idx >= 0 ? cached.slice(idx) : cached;
    const seen2 = new Set();
    merged = prefix.concat(tail).filter((u) => {
      const k = followKey(u);
      if (!k || seen2.has(k)) return false;
      seen2.add(k);
      return true;
    });
    for (const k of seen2) seen.add(k);
  } else {
    merged = prefix;
  }

  const added = prefix.length;
  let fetchedPages = page + 1;
  let mode = overlapKey ? "incr" : "no-overlap";

  // 原有+新增 < 总数 → 有删关注或本地不完整：才往更旧的页找（从当前重合页起，seen 去重）
  if (merged.length < total) {
    mode = overlapKey ? "incr-backfill" : "backfill";
    const r = await fetchFollowingPages(me, page, total, seen, merged, maxPages);
    fetchedPages += r.pages;
  }

  const packed = packFollowing(meInfo, merged, total, { synced: mode, added, fetchedPages });
  saveFollowingStore(packed);
  console.log(`[iwara-api] following sync ${mode}: added=${added} local=${merged.length} remote=${total} pages=${fetchedPages}`);
  return packed;
}

async function listFollowing(force) {
  return syncFollowing(!!force);
}

/** 封面 URL（i.iwara.tv；浏览器侧请走 /api/thumb 以免 DNS 污染） */
function thumbnailUrl(v) {
  if (!v) return "";
  if (typeof v.thumbnailUrl === "string" && v.thumbnailUrl) return v.thumbnailUrl;
  if (typeof v.thumbnail === "string" && /^https?:/i.test(v.thumbnail)) return v.thumbnail;
  const fileId = v.file && v.file.id;
  if (!fileId) return "";
  const n = Number.isFinite(Number(v.thumbnail)) ? Number(v.thumbnail) : 0;
  return `https://i.iwara.tv/image/thumbnail/${fileId}/thumbnail-${n}.jpg`;
}

/** 封面图字节（IP 直连 i.iwara.tv） */
function fetchOneThumbnail(fileId, name) {
  const url = "https://i.iwara.tv/image/thumbnail/" + fileId + "/" + name;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: getCfIp(),
      port: 443,
      path: u.pathname,
      method: "GET",
      headers: { Host: u.hostname, "User-Agent": DEFAULT_UA, Referer: "https://www.iwara.tv/", Accept: "image/*,*/*" },
      agent: HTTPS_AGENT,
      servername: u.hostname
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        buf: Buffer.concat(chunks),
        contentType: res.headers["content-type"] || "image/jpeg"
      }));
    });
    req.setTimeout(15000, () => req.destroy(new Error("封面超时")));
    req.on("error", reject);
    req.end();
  });
}

// i.iwara.tv：thumbnail-0.jpg … thumbnail-9.jpg 经常是同一张 4824B 占位图；
// 真封面是补零 thumbnail-00.jpg … thumbnail-09.jpg。10 以上不补零才是真图。
const IWARA_PLACEHOLDER_MD5 = "a244c06f2a6369b23a5e18c9a2cb2a1b";
function isIwaraPlaceholder(buf) {
  if (!buf || buf.length !== 4824) return false;
  return crypto.createHash("md5").update(buf).digest("hex") === IWARA_PLACEHOLDER_MD5;
}

function fetchThumbnail(fileId, n) {
  // 2026-09-04：用户点名「椿: 要是被发现没穿衣服」和下面 2 个封面网页上一直错。
  // 【原代码】先拉 thumbnail-${idx}.jpg，成功（含占位图）就返回；0-9 不补零全是占位图。
  // 【改为】0-9 先补零；任一张若是 4824B 占位 MD5 则当失败试下一个。
  // 【思路】模拟三条：本地 12 张 jpg 同一 hash a244c06f…；官方 thumbnail-0.jpg=占位，thumbnail-00.jpg 才是图。
  const idx = Number.isFinite(Number(n)) ? Number(n) : 0;
  const unpadded = "thumbnail-" + idx + ".jpg";
  const padded = "thumbnail-" + String(idx).padStart(2, "0") + ".jpg";
  const names = idx < 10 ? [padded, unpadded] : [unpadded, padded];
  const uniq = [];
  for (const name of names) if (uniq.indexOf(name) < 0) uniq.push(name);
  return (async () => {
    let lastErr = null;
    for (const name of uniq) {
      try {
        const img = await fetchOneThumbnail(fileId, name);
        if (!img || !img.buf || img.buf.length <= 32) continue;
        if (isIwaraPlaceholder(img.buf)) continue;
        return img;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("无官方封面");
  })();
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
    file: { id: raw.file && raw.file.id, name: raw.file && raw.file.name, size: raw.file && raw.file.size },
    quality: best.name,
    liked: !!raw.liked,
    following: !!(raw.user && raw.user.following),
    downloadUrl,
    raw
  };
}

async function postAuth(url) {
  await ensureAccessToken(false);
  try {
    return await fetchJson(url, { method: "POST", withAuth: false, retries: 1, body: {} });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/HTTP 401/.test(msg)) {
      await ensureAccessToken(true);
      return await fetchJson(url, { method: "POST", withAuth: false, retries: 1, body: {} });
    }
    // 已点赞 / 已关注：400/409 视为成功
    if (/HTTP (400|409|422)/.test(msg)) return { ok: true, already: true };
    throw e;
  }
}

/** POST /video/{id}/like → 201 */
async function likeVideo(id) {
  const vid = String(id || "").trim();
  if (!vid) throw new Error("缺视频 id");
  await postAuth(`https://${API_HOST}/video/${encodeURIComponent(vid)}/like`);
  return { ok: true };
}

/** POST /user/{userId}/followers → 201 */
async function followUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("缺用户 id");
  await postAuth(`https://${API_HOST}/user/${encodeURIComponent(uid)}/followers`);
  return { ok: true };
}

/** 下载时按设置自动点赞/关注；失败只记日志，不抛。 */
async function autoLikeFollow(info) {
  const c = cfg.readConfig();
  const out = { liked: false, followed: false, errors: [] };
  if (!info || info.type === "external") return out;
  if (c.autoLike && !info.liked) {
    try {
      await likeVideo(info.id);
      out.liked = true;
    } catch (e) {
      out.errors.push("like: " + (e && e.message || e));
      console.error("[iwara-api] autoLike 失败:", e && e.message || e);
    }
  }
  if (c.autoFollow && info.authorId && !info.following) {
    try {
      await followUser(info.authorId);
      out.followed = true;
    } catch (e) {
      out.errors.push("follow: " + (e && e.message || e));
      console.error("[iwara-api] autoFollow 失败:", e && e.message || e);
    }
  }
  return out;
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
  try { await ensureAccessToken(false); } catch (_) {}
  if (q.search) {
    const type = q.type || "videos";
    params.set("type", type);
    params.set("query", q.search);
    if (type === "users") {
      params.set("sort", "relevance");
      params.delete("rating");
      params.delete("user");
    } else {
      params.set("sort", "date");
    }
    const url = `https://${API_HOST}/search?${params.toString()}`;
    console.log(`[iwara-api] listVideos(search): ${url}`);
    const data = await fetchJson(url, { withAuth: false, retries: 2 });
    return data; // { results:[Video|User], count, page, limit }
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


/** 只要封面用的 fileId + 选中序号，不拉下载源、不写视频索引。封面文件名 thumbs/<id>.jpg 就是本地索引。 */
async function getThumbMeta(id) {
  const vid = String(id || "").trim();
  if (!vid) return null;
  const raw = await fetchJson(`https://${API_HOST}/video/${vid}`, { retries: 1 });
  const fileId = raw && raw.file && raw.file.id ? String(raw.file.id) : "";
  const n = Number.isFinite(Number(raw && raw.thumbnail)) ? Number(raw.thumbnail) : 0;
  return { id: vid, fileId, thumbnail: n };
}

module.exports = { getXVersion, checkLogin, getVideoInfo, listVideos, getUserProfile, getComments, ensureAccessToken, listFollowing, listFollowingPage, likeVideo, followUser, autoLikeFollow, thumbnailUrl, fetchThumbnail, getThumbMeta, isIwaraPlaceholder, API_HOST, DEFAULT_UA, getCfIp };