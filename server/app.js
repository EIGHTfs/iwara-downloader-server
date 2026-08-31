// ============================================================
// iwara-downloader-server - HTTP 入口（零依赖，参考 gbmd app.js）
// 路由：登录/设置/iwara 检测/视频列表/下载任务 + 静态前端
// ============================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const urlMod = require("url");

const os = require("os");

const cfg = require("./config");
const auth = require("./auth");
const api = require("./lib/iwara-api");
const downloader = require("./lib/downloader");
const search = require("./lib/search-cache");
const dataBackup = require("./lib/data-backup");
const videoIndex = require("./lib/video-index");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// ---------- 命令行：设置密码 / 端口 ----------
if (process.argv.includes("--set-password")) {
  const idx = process.argv.indexOf("--set-password");
  const pwd = process.argv[idx + 1];
  if (!pwd) { console.error('用法: node app.js --set-password "你的密码"'); process.exit(1); }
  cfg.setPassword(pwd);
  console.log("密码已设置（scrypt 哈希存入 config.json）");
  process.exit(0);
}
let CLI_PORT = null;
{
  const idx = process.argv.indexOf("--port");
  if (idx >= 0 && process.argv[idx + 1]) CLI_PORT = parseInt(process.argv[idx + 1], 10);
}

// ---------- 工具 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("无效 JSON")); }
    });
    req.on("error", reject);
  });
}

/**
 * 解析油猴脚本自动复制的组合凭证文本：
 *   Cookie=...\nToken=...\nAccessToken=...
 * 返回 { cookie, token, accessToken }（未命中的字段为 null）；
 * 若文本不含任何 "字段=" 行，返回 null（视为纯 Cookie 串）。
 */
function parseCredentialText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const get = (key) => {
    const m = text.split(/\r?\n/).find((l) => l.startsWith(key + "="));
    if (!m) return null;
    return m.slice(key.length + 1).trim() || "";
  };
  const cookie = get("Cookie");
  const token = get("Token");
  const accessToken = get("AccessToken");
  const hit = /(^|\n)(Cookie|Token|AccessToken)=/.test("\n" + text);
  if (!hit) return null; // 不是组合文本
  return {
    cookie: cookie === null ? null : cookie,
    token: token === null ? null : token,
    accessToken: accessToken === null ? null : accessToken
  };
}

/**
 * 解析下载项：支持字符串（完整 iwara.tv 链接 / 纯 ID）与对象（{ id|url|title|author }）。
 * 返回标准化 items 数组；解析不出 id 的项被丢弃。
 */
function parseDownloadItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const items = rawItems
    .map((it) => {
      if (typeof it === "string") it = { url: it };
      if (!it || typeof it !== "object") return null;
      let id = String(it.id || "").trim();
      const url = String(it.url || "").trim();
      if (!id && url) {
        const m = url.match(/\/(?:video|v)\/([\w-]+)/i);
        id = m ? m[1] : url.replace(/^https?:\/\/[^/]+\//, "").split("?")[0].trim();
      }
      if (!/^[\w-]+$/.test(id)) return null;
      return Object.assign({}, it, { id, url });
    })
    .filter(Boolean);
  return items;
}

function setSessionCookie(res, token) {
  const cfgNow = cfg.readConfig();
  const maxAge = (cfgNow.sessionHours || 72) * 3600;
  res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function requireAuth(req) {
  const c = cfg.readConfig();
  if (!c.passwordHash) return true;
  return auth.isValidSession(auth.extractToken(req));
}

function publicSettings(c) {
  const { passwordHash, passwordSalt, iwaraCookie, iwaraToken, iwaraAccessToken, aria2Token, ...safe } = c;
  return Object.assign({}, safe, {
    hasCookie: !!(iwaraCookie && String(iwaraCookie).trim()),
    hasToken: !!(iwaraToken && String(iwaraToken).trim()),
    hasAria2Token: !!(aria2Token && String(aria2Token).trim())
  });
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html" || ext === ".js" || ext === ".css") headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    if (ext === ".ico" || ext === ".png") headers["Cache-Control"] = "public, max-age=86400";
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  try {
    // ---- 公开路由 ----
    // 油猴脚本下载（免鉴权，手机浏览器直接打开即触发 Tampermonkey 安装）
    if (method === "GET" && (pathname === "/userscript" || pathname === "/userscript.user.js" || pathname === "/iwara-cred-fetch.user.js")) {
      const scriptCandidates = [
        path.join(__dirname, "..", "scripts", "iwara-cred-fetch.user.js"),
        path.join(process.cwd(), "..", "scripts", "iwara-cred-fetch.user.js"),
        path.join(process.cwd(), "scripts", "iwara-cred-fetch.user.js")
      ];
      const scriptPath = scriptCandidates.find((p) => fs.existsSync(p));
      if (!scriptPath) return sendJson(res, 404, { ok: false, error: "脚本不存在" });
      fs.readFile(scriptPath, (err, data) => {
        if (err) return sendJson(res, 404, { ok: false, error: "脚本不存在" });
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Content-Disposition": "inline; filename=iwara-cred-fetch.user.js",
          "Cache-Control": "no-store"
        });
        res.end(data);
      });
      return;
    }
    if (method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      const c = cfg.readConfig();
      if (!c.passwordHash) {
        const token = auth.createSession(c.sessionHours || 72);
        setSessionCookie(res, token);
        return sendJson(res, 200, { ok: true, noPassword: true, message: "未设置访问密码，可直接使用" });
      }
      if (cfg.verifyPassword(body.password || "", c.passwordHash, c.passwordSalt)) {
        const token = auth.createSession(c.sessionHours || 72);
        setSessionCookie(res, token);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { ok: false, error: "密码错误" });
    }
    if (method === "POST" && pathname === "/api/logout") {
      auth.destroySession(auth.extractToken(req));
      res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/status") {
      const c = cfg.readConfig();
      return sendJson(res, 200, { ok: true, needsSetup: !c.passwordHash, needsAuth: !!c.passwordHash, port: c.port || 8643 });
    }
    // aria2 拉取本机生成的 sidecar JSON（短链带 HMAC，不走登录 cookie）
    if (method === "GET" && pathname === "/api/index-sidecar") {
      const id = String(parsed.query.id || "").trim();
      const k = String(parsed.query.k || "").trim();
      const buf = videoIndex.readFetchableSidecar(id, k);
      if (!buf) return sendJson(res, 404, { ok: false, error: "not found" });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "inline; filename=\"" + id.replace(/[^\w.-]+/g, "_") + ".json\"",
        "Cache-Control": "no-store",
        "Content-Length": buf.length
      });
      return res.end(buf);
    }
    if (method === "GET" && pathname === "/api/thumb") {
      const fileId = String(parsed.query.file || "").trim();
      const n = String(parsed.query.n || "0");
      if (!fileId) return sendJson(res, 400, { ok: false, error: "缺 file" });
      try {
        const img = await api.fetchThumbnail(fileId, n);
        res.writeHead(200, {
          "Content-Type": img.contentType,
          "Content-Length": img.buf.length,
          "Cache-Control": "public, max-age=86400"
        });
        return res.end(img.buf);
      } catch (e) {
        return sendJson(res, 404, { ok: false, error: String(e.message || e) });
      }
    }

    // ---- 需鉴权 ----
    if (pathname.startsWith("/api/") && !requireAuth(req)) {
      return sendJson(res, 401, { ok: false, error: "未登录" });
    }

    // ---- 本机目录浏览（设置页「读取本地选择」下载路径，对照 gbmd /api/browse）----
    if (method === "GET" && pathname === "/api/browse") {
      const p = String(parsed.query.path || "").trim();
      const dir = p && p.startsWith("/") ? p : "/";
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          return sendJson(res, 400, { ok: false, error: "目录不存在: " + dir });
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && e.name !== "@eaDir" && e.name !== "#recycle" && e.name !== ".git")
          .map((e) => e.name)
          .sort();
        return sendJson(res, 200, { ok: true, path: dir, parent: dir === "/" ? null : path.dirname(dir), dirs });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }

    // ---- 设置 ----
    if (method === "GET" && pathname === "/api/settings") {
      return sendJson(res, 200, { ok: true, settings: publicSettings(cfg.readConfig()) });
    }
    if (method === "POST" && pathname === "/api/settings") {
      const body = await readBody(req);
      const c = cfg.readConfig();
      // 兼容油猴脚本自动复制的组合文本（多行 Cookie=.../Token=.../AccessToken=...）
      if (typeof body.iwaraCookie === "string") {
        const parsed = parseCredentialText(body.iwaraCookie);
        if (parsed) {
          if (parsed.cookie) body.iwaraCookie = parsed.cookie;
          if (parsed.token) { body.iwaraToken = parsed.token; delete body.token; }
          if (parsed.accessToken) body.iwaraAccessToken = parsed.accessToken;
        }
      }
      const allowed = ["iwaraCookie", "iwaraToken", "iwaraAccessToken", "downloadBackend", "concurrency", "aria2Path", "aria2Token", "downloadPath", "fileNameTemplate", "useAuthorSubdir", "showLikedInSearch", "autoLike", "autoFollow", "sessionHours", "port", "checkDownloadLink"];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        if ((k === "iwaraCookie" || k === "iwaraToken" || k === "iwaraAccessToken" || k === "aria2Token") && String(body[k]).trim() === "") continue;
        if (k === "showLikedInSearch" || k === "autoLike" || k === "autoFollow" || k === "useAuthorSubdir" || k === "checkDownloadLink") {
          c[k] = body[k] === true || body[k] === "true" || body[k] === 1 || body[k] === "1";
          continue;
        }
        if (k === "fileNameTemplate") {
          c[k] = String(body[k] || "").trim().replace(/\.(mp4|webm|mov)$/i, "") || "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]";
          continue;
        }
        c[k] = body[k];
      }
      cfg.writeConfig(c);
      return sendJson(res, 200, { ok: true, settings: publicSettings(cfg.readConfig()), parsedFromText: !!parseCredentialText(typeof body.iwaraCookie === "string" ? body.iwaraCookie : "") });
    }
    if (method === "POST" && pathname === "/api/change-password") {
      const body = await readBody(req);
      if (!body.password || String(body.password).length < 4) {
        return sendJson(res, 400, { ok: false, error: "密码至少 4 位" });
      }
      cfg.setPassword(body.password);
      return sendJson(res, 200, { ok: true });
    }
    // ---- 单独保存 iwaraToken（配合油猴凭证获取器推送） ----
    if (method === "POST" && pathname === "/api/token") {
      const body = await readBody(req);
      if (body.iwaraToken === undefined) return sendJson(res, 400, { ok: false, error: "缺 iwaraToken" });
      const c = cfg.readConfig();
      c.iwaraToken = String(body.iwaraToken).trim();
      cfg.writeConfig(c);
      return sendJson(res, 200, { ok: true });
    }

    // ---- Iwara 账号检测（油猴 / 设置页共用）----
    if (method === "GET" && pathname === "/api/account-check") {
      const c = cfg.readConfig();
      const cookie = String(c.iwaraCookie || "");
      const cookieItems = cookie ? cookie.split(";").map((s) => s.trim()).filter(Boolean) : [];
      const cred = {
        hasCookie: !!cookie.trim(),
        cookieChars: cookie.length,
        cookieItems: cookieItems.length,
        hasCfClearance: /(?:^|;\s*)cf_clearance=/.test(cookie),
        hasToken: !!(c.iwaraToken && String(c.iwaraToken).trim()),
        hasAccessToken: !!(c.iwaraAccessToken && String(c.iwaraAccessToken).trim())
      };
      if (!c.iwaraCookie && !c.iwaraToken) {
        return sendJson(res, 200, { ok: true, cookieSet: false, checked: false, message: "未配置 Cookie / Token", cred });
      }
      const r = await api.checkLogin();
      return sendJson(res, 200, Object.assign({ cookieSet: !!(c.iwaraCookie || c.iwaraToken), checked: true, cred }, r));
    }
    if (method === "GET" && pathname === "/api/following") {
      try {
        const all = parsed.query.all === "1";
        const force = parsed.query.refresh === "1";
        const r = all
          ? await api.listFollowing(force)
          : await api.listFollowingPage(parsed.query.page || 0, parsed.query.limit || 50);
        return sendJson(res, 200, {
          ok: true,
          count: r.count || r.following.length,
          me: r.me,
          following: r.following,
          page: r.page,
          limit: r.limit,
          synced: r.synced,
          added: r.added,
          fetchedPages: r.fetchedPages
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    // ---- 视频列表 / 搜索 ----
    if (method === "GET" && pathname === "/api/videos") {
      const q = {
        sort: String(parsed.query.sort || "date"),
        page: parseInt(parsed.query.page || "0", 10),
        limit: parseInt(parsed.query.limit || "20", 10),
        user: String(parsed.query.user || ""),
        search: String(parsed.query.search || ""),
        rating: String(parsed.query.rating || "all"),
        type: String(parsed.query.type || "videos"),
        subscribed: parsed.query.subscribed === "1"
      };
      try {
        const data = await api.listVideos(q);
        return sendJson(res, 200, { ok: true, count: data.count, page: data.page, limit: data.limit, results: data.results });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e), hint: String(e.message || "").startsWith("CF_CHALLENGE") ? "Cookie 未通过 Cloudflare 挑战：请在设置中更新（需含 cf_clearance）" : "" });
      }
    }
    // ---- 按时间搜索 / 搜索记录 ----
    if (method === "POST" && pathname === "/api/search") {
      const body = await readBody(req);
      const startTs = Math.floor(new Date(body.startDate + "T00:00:00").getTime() / 1000);
      const endTs = Math.floor(new Date(body.endDate + "T00:00:00").getTime() / 1000) + 86400;
      if (isNaN(startTs) || isNaN(endTs)) return sendJson(res, 400, { ok: false, error: "日期格式无效" });
      const contentFilter = Array.isArray(body.contentFilter) && body.contentFilter.length ? body.contentFilter : ["normal", "nsfw"];
      try {
        const t = await search.startSearchTask({
          startDate: body.startDate,
          endDate: body.endDate,
          contentFilter,
          startTs,
          endTs,
          user: String(body.user || "")
        });
        return sendJson(res, 200, { ok: true, started: true, task: t });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    if (method === "GET" && pathname === "/api/search-status") return sendJson(res, 200, { ok: true, task: search.getQueryTask() });
    if (method === "POST" && pathname === "/api/search/stop") return sendJson(res, 200, search.stopSearch());
    if (method === "GET" && pathname === "/api/search/cache") return sendJson(res, 200, { ok: true, cache: search.getCache() });
    if (method === "POST" && pathname === "/api/search/clear") return sendJson(res, 200, search.clearCache());
    if (method === "POST" && pathname === "/api/search/import") {
      const body = await readBody(req);
      let records = body && body.records;
      if (typeof records === "string") {
        try { records = JSON.parse(records); } catch (_) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败，请上传正确的搜索记录数组" }); }
      }
      if (body && body.json && !records) {
        try { records = JSON.parse(body.json); } catch (_) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败，请上传正确的搜索记录数组" }); }
      }
      return sendJson(res, 200, search.importCache(records));
    }
    if (method === "POST" && pathname === "/api/search/save") {
      const body = await readBody(req);
      const results = Array.isArray(body && body.results) ? body.results : [];
      return sendJson(res, 200, search.saveRecords(results));
    }
    if (method === "GET" && pathname === "/api/search/export") {
      const cache = search.exportCache();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="iwara-search-records-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.end(JSON.stringify(cache, null, 2));
    }

    // ---- 用户数据备份/恢复（按 userdata-manifest.json）----
    if (method === "GET" && pathname === "/api/data/export") {
      try {
        const buf = await dataBackup.exportZip();
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="iwara-userdata-${new Date().toISOString().slice(0, 10)}.zip"`);
        return res.end(buf);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "备份失败: " + (e && e.message || e) });
      }
    }
    if (method === "POST" && pathname === "/api/data/import") {
      const body = await readBody(req, 512 * 1024 * 1024);
      const b64 = body && (body.data || body.zip);
      if (!b64 || typeof b64 !== "string") return sendJson(res, 400, { ok: false, error: "缺少 zip 数据（data 字段，base64）" });
      let zipBuf;
      try { zipBuf = Buffer.from(b64, "base64"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "zip 数据解码失败" }); }
      const zipPath = path.join(os.tmpdir(), "iwara-upload-" + Date.now() + ".zip");
      fs.writeFileSync(zipPath, zipBuf);
      try {
        const r = await dataBackup.importZip(zipPath);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "导入失败: " + (e && e.message || e) });
      } finally {
        try { fs.unlinkSync(zipPath); } catch (_) {}
      }
    }

    // ---- 下载索引（精简：id → 作者/标题/fileId/时长/tags/上传日；不算 hash）----
    if (method === "GET" && pathname === "/api/index") {
      const c = cfg.readConfig();
      return sendJson(res, 200, Object.assign({ ok: true }, videoIndex.listCatalog(c.downloadPath)));
    }
    if (method === "GET" && pathname === "/api/index/export") {
      const c = cfg.readConfig();
      const buf = videoIndex.catalogFileBuffer(c.downloadPath);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="iwara-index-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.end(buf);
    }
    if (method === "POST" && pathname === "/api/index/import") {
      const c = cfg.readConfig();
      const body = await readBody(req, 64 * 1024 * 1024);
      const payload = body && (body.videos || body.items || body.dump || body);
      try {
        return sendJson(res, 200, videoIndex.importPayload(c.downloadPath, payload));
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "导入失败: " + (e && e.message || e) });
      }
    }
    if (method === "POST" && pathname === "/api/index/scan") {
      const c = cfg.readConfig();
      try {
        return sendJson(res, 200, videoIndex.scanDownloadDir(c.downloadPath));
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "扫描失败: " + (e && e.message || e) });
      }
    }

    // 解析单个视频（拿直链/文件名预览）
    if (method === "GET" && pathname === "/api/video-info") {
      const id = String(parsed.query.id || "").trim();
      if (!id) return sendJson(res, 400, { ok: false, error: "缺 id" });
      try {
        const info = await api.getVideoInfo(id);
        return sendJson(res, 200, { ok: true, ...info });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e), hint: String(e.message || "").startsWith("CF_CHALLENGE") ? "Cookie 未通过 Cloudflare 挑战" : "" });
      }
    }

    // ---- 下载任务 ----
    if (method === "GET" && pathname === "/api/task") {
      return sendJson(res, 200, { ok: true, task: downloader.getTask() });
    }
    // /api/download：唯一解析入口（parseDownloadItems）
    // /api/receive：油猴脚本专用接收口，只规整 body 形态，解析/下载全部转发给 /api/download 的处理
    if (method === "POST" && (pathname === "/api/download" || pathname === "/api/receive")) {
      const body = await readBody(req);
      if (pathname === "/api/receive") {
        // 支持 { items:[...] } / { url } / { urls:[...] } / { text:"每行一个链接" }，一律规整成 items
        let rawItems = body.items;
        if (!rawItems && typeof body.url === "string") rawItems = [body.url];
        if (!rawItems && Array.isArray(body.urls)) rawItems = body.urls;
        if (!rawItems && typeof body.text === "string") rawItems = body.text.split(/\r?\n/);
        if (typeof rawItems === "string") rawItems = [rawItems];
        body.items = rawItems;
      }
      const rawItems = body.items || [];
      if (!Array.isArray(rawItems) || rawItems.length === 0) return sendJson(res, 400, { ok: false, error: "无下载项" });
      // 兼容油猴脚本「发送到服务器」：支持字符串（完整 iwara.tv 链接或纯 ID）与对象两种形态
      const items = parseDownloadItems(rawItems);
      if (items.length === 0) return sendJson(res, 400, { ok: false, error: "无法识别下载项" });
      try {
        const r = await downloader.startDownloadTask(items);
        if (pathname === "/api/receive") return sendJson(res, 200, Object.assign({ ok: true }, r, { received: items.length }));
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
    }
    if (method === "POST" && pathname === "/api/task/pause") { return sendJson(res, 200, { ok: true, status: downloader.pauseTask() }); }
    if (method === "POST" && pathname === "/api/task/resume") { return sendJson(res, 200, { ok: true, status: downloader.resumeTask() }); }
    if (method === "POST" && pathname === "/api/task/stop") { return sendJson(res, 200, { ok: true, status: downloader.stopTask() }); }
    if (method === "POST" && pathname === "/api/task/retry") { return sendJson(res, 200, { ok: true, retried: downloader.retryFailed() }); }
    if (method === "POST" && pathname === "/api/task/concurrency") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, concurrency: downloader.setConcurrency(body.n) });
    }

    // ---- 静态 ----
    if (method === "GET") return serveStatic(req, res, pathname);
    return sendJson(res, 405, { ok: false, error: "方法不允许" });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

// ---------- 启动 ----------
(async function start() {
  // 端口优先级：--port 命令行 > PORT 环境变量 > config.json；被占用自动换随机端口
  let preferred = CLI_PORT || (process.env.PORT ? parseInt(process.env.PORT, 10) : null) || cfg.readConfig().port || 8643;
  const finalPort = await new Promise((resolve) => {
    const net = require("net");
    const srv = net.createServer();
    const tryListen = (port) => {
      srv.once("error", () => {
        const rnd = 20000 + Math.floor(Math.random() * 10000);
        tryListen(rnd);
      });
      srv.listen(port, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    };
    tryListen(preferred);
  });

  const cfgNow = cfg.readConfig();
  cfgNow.port = finalPort;
  cfg.writeConfig(cfgNow);

  auth.loadSessions();
  downloader.restorePendingTask();
  search.restorePendingQuery();

  server.listen(finalPort, "0.0.0.0", () => {
    console.log("==============================================");
    console.log("iwara-downloader-server 已启动");
    console.log(`  本机访问: http://127.0.0.1:${finalPort}`);
    console.log(`  局域网访问: http://<本机IP>:${finalPort}`);
    if (!cfg.hasPassword()) console.log('  ⚠️ 未设置密码！可运行: node app.js --set-password "你的密码"');
    console.log("==============================================");
  });
})();