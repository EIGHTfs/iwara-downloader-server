// ============================================================
// iwara-downloader-server - 下载引擎（参考 gbmd downloader.js）
//
// 双后端：
//   direct:  Node fetch 流式写盘，.part + Range 断点续传，失败重试
//   aria2:   aria2.addUri JSON-RPC 推送（支持断点/代理/多线程）
//
// 任务持久化：download_task.json（重启可恢复 restorePendingTask）
// 并发控制：concurrency 限制同时下载数
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const os = require("os");

const cfg = require("../config");
const api = require("./iwara-api");
const videoIndex = require("./video-index");
const deviceCheck = require("./device-check");
const thumbCache = require("./thumb-cache.cjs");

const DATA_DIR = process.env.GBMD_DATA_DIR || __dirname;
const TASK_FILE = path.join(DATA_DIR, "..", "download_task.json");
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 2000;

// ---------- CDN 子域动态管理器 ----------
// 动态维护两个列表，并持久化到外部文件 server/cdn_hosts_state.json（重启不丢）：
//   GOOD 成功列表 —— 在该子域上成功下载过（优先使用，避免反复踩 403）
//   BAD  失败列表 —— 在该子域上失败过（403/超时/连接中断，自动跳过）
// 规则：
//   - 下载开始时，候选 = [原始子域] + GOOD + 种子列表（排除 BAD）
//   - 成功后：该子域移出 BAD、加入 GOOD
//   - 失败后：该子域移出 GOOD、加入 BAD
//   - 因此成功/失败子域会随实际下载结果动态增删，无需硬编码维护
const CDN_STATE_FILE = path.join(DATA_DIR, "..", "cdn_hosts_state.json");
let GOOD_CDN_HOSTS = new Set();             // 已成功子域（按成功时间追加，越新越优先）
let BAD_CDN_HOSTS = new Set();              // 已失败子域
// 种子列表：初始候选（首次运行无成功记录时用；也会随下载动态增删修正）
const SEED_CDN_HOSTS = ["firefly.iwara.tv", "aiko.iwara.tv", "filesq.iwara.tv"];

// 从外部文件恢复两个列表
function cdnLoadState() {
  try {
    if (fs.existsSync(CDN_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(CDN_STATE_FILE, "utf8"));
      if (Array.isArray(s.good)) GOOD_CDN_HOSTS = new Set(s.good);
      if (Array.isArray(s.bad)) BAD_CDN_HOSTS = new Set(s.bad);
      if (GOOD_CDN_HOSTS.size || BAD_CDN_HOSTS.size) {
        console.log(`[downloader] 已恢复 CDN 子域状态：成功 ${GOOD_CDN_HOSTS.size} 个 / 失败 ${BAD_CDN_HOSTS.size} 个`);
      }
    }
  } catch (_) {}
}

// 写入外部文件（每次增删都落盘，保证重启后仍记住成功/失败子域）
function cdnSaveState() {
  try {
    fs.writeFileSync(CDN_STATE_FILE, JSON.stringify({
      good: [...GOOD_CDN_HOSTS],
      bad: [...BAD_CDN_HOSTS],
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
  } catch (_) {}
}

/** 当前候选子域：原始子域 → 成功列表（新→旧）→ 种子（未失败过） */
function cdnCandidates(originalHost) {
  const out = [];
  const seen = new Set();
  const push = (h) => {
    if (h && !seen.has(h) && !BAD_CDN_HOSTS.has(h)) { seen.add(h); out.push(h); }
  };
  push(originalHost);
  [...GOOD_CDN_HOSTS].reverse().forEach(push); // Set 迭代序 = 插入序，反转让最近成功的优先
  SEED_CDN_HOSTS.forEach(push);
  return out;
}

/** 下载成功后调用：把子域沉淀进成功列表 */
function cdnMarkSuccess(host) {
  if (!host) return;
  BAD_CDN_HOSTS.delete(host);
  GOOD_CDN_HOSTS.delete(host);
  GOOD_CDN_HOSTS.add(host); // 追加到末尾（最新成功）
  cdnSaveState();
}

/** 下载失败后调用：把子域移入失败列表 */
function cdnMarkFail(host) {
  if (!host) return;
  GOOD_CDN_HOSTS.delete(host);
  BAD_CDN_HOSTS.add(host);
  cdnSaveState();
}

// keep-alive 连接池（避免每文件吃一次慢首连接）
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 64, maxFreeSockets: 32 });

let task = {
  status: "idle", // idle | running | paused
  items: [],      // [{ id, title, author, file, url, savePath, state, progress, error }]
  idx: 0,
  completed: 0,
  failed: 0,
  totalBytes: 0,
  doneBytes: 0
};
let activeDownloads = 0;

// ---------- 工具 ----------
function sanitizeFileName(name) {
  if (!name) return "unnamed";
  // 去掉路径分隔与非法字符（保留原始文件名主体）
  let n = String(name).replace(/[/\\:*?"<>|]/g, "_").trim();
  return n || "unnamed";
}

/**
 * 文件名模板（学 IwaraDownloadTool 油猴脚本 src/download/downloadPath.ts）：
 *   config.fileNameTemplate 支持 {TITLE} {ALIAS} {ID} {AUTHOR} {QUALITY} {UPLOADTIME} {NOWTIME}
 *   例：Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]  （不要写 .mp4，落盘时自动补）
 * @param {string} template
 * @param {Object} info - getVideoInfo 返回的视频信息
 */
function applyParsedName(item, info, c) {
  // 【原代码】解析后只改 item.file，任务列表仍用入队时的 title/id。【改为】用户原话「任务列表里面显示的不是按解析后的名字」【思路】把 Iwara 标题和模板文件名写回任务项，进度页才能显示解析名
  if (info.title) item.title = info.title;
  if (info.author) item.author = info.author;
  if (info.alias) item.alias = info.alias;
  if (info.quality) item.quality = info.quality;
  const fid = thumbCache.fileIdOf(info);
  if (fid) item.fileId = fid;
  thumbCache.ensureFromInfo(item.id, info, item.savePath).catch(() => null);
  item.file = applyFileNameTemplate((c && c.fileNameTemplate) || "", {
    title: info.title || item.title,
    alias: info.alias || "",
    id: item.id,
    author: info.author || item.author,
    quality: info.quality || "",
    uploadTime: info.uploadTime
  });
}

function applyFileNameTemplate(template, info) {
  const now = new Date();
  const upload = info.uploadTime ? new Date(info.uploadTime) : now;
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDT = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const vars = {
    TITLE: info.title || "",
    ALIAS: info.alias || "",
    ID: info.id || "",
    AUTHOR: info.author || "",
    QUALITY: info.quality || "",
    UPLOADTIME: fmtDT(upload),
    NOWTIME: fmtDT(now)
  };
  let name = cfg.normalizeFileNameTemplate(template);
  for (const k of Object.keys(vars)) {
    name = name.split(`{${k}}`).join(vars[k]);
  }
  name = sanitizeFileName(name);
  name = name.replace(/\.(mp4|webm|mov|mkv|m4v)$/i, "");
  const vid = String(info.id || "").trim();
  if (vid && name.indexOf(vid) < 0) name += "_[" + vid + "]";
  if (!name) name = sanitizeFileName(vid || "unnamed");
  return name + ".mp4";
}

function safeJoin(root, sub) {
  const full = path.resolve(root, sub);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) {
    throw new Error("非法路径: " + sub);
  }
  return full;
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

// ---------- 任务持久化 ----------
function saveTask() {
  try { fs.writeFileSync(TASK_FILE, JSON.stringify(task, null, 2), "utf8"); } catch (_) {}
}

function getTask() { return task; }

function restorePendingTask() {
  try {
    if (fs.existsSync(TASK_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TASK_FILE, "utf8"));
      if (saved && Array.isArray(saved.items)) {
        // 恢复未完成任务（保持 paused 状态，等待用户恢复）
        const pending = saved.items.filter((i) => i.state === "pending" || i.state === "downloading");
        pending.forEach((i) => (i.state = "pending"));
        task = Object.assign(task, saved, { items: saved.items, status: "paused" });
        if (pending.length > 0) console.log(`[downloader] 恢复 ${pending.length} 个未完成任务（已暂停，等待恢复）`);
      }
    }
  } catch (_) {}
}

// ---------- 下载 ----------
/** 检查 .part 已下载字节数（断点续传起点） */
function partBytes(partPath) {
  try { return fs.statSync(partPath).size; } catch (_) { return 0; }
}

/**
 * direct 后端：带 Range 断点续传的单文件下载
 * 子域自动轮换（动态）：原始下载链接的子域若失败（403/超时/连接中断），
 * 自动尝试 GOOD 成功列表 / 种子列表中的子域；成功→写入 GOOD，失败→写入 BAD，
 * 两个列表持久化到外部文件 cdn_hosts_state.json，随实际下载结果动态增删。
 * @returns {Promise<'done'|'retry'>}
 */
function downloadToFile(item, onProgress) {
  return new Promise((resolve, reject) => {
    const url = item.url;
    const tmpFile = item.savePath + ".part";
    const start = partBytes(tmpFile);
    const u0 = new URL(url);

    // 候选子域（动态）：原始子域 → GOOD 成功列表（新→旧）→ 种子（未失败过）
    const candidates = cdnCandidates(u0.hostname);
    let ci = 0;

    const attempt = () => {
      if (ci >= candidates.length) return reject(new Error("所有 CDN 子域均失败（403/超时）"));
      const host = candidates[ci++];
      const headers = {
        "User-Agent": api.DEFAULT_UA,
        Accept: "*/*",
        Referer: "https://www.iwara.tv/",
        Range: `bytes=${start}-`
      };
      if (cfg.readConfig().iwaraCookie) headers["Cookie"] = cfg.readConfig().iwaraCookie;

      const req = https.request(
        {
          host: api.getCfIp(),
          port: u0.port || 443,
          path: u0.pathname + u0.search,
          method: "GET",
          headers: Object.assign({ Host: host }, headers),
          agent: HTTPS_AGENT,
          servername: host
        },
        (res) => {
          // 206 = 断点续传；200 = 重新开始（服务器不支持 Range）
          if (res.statusCode === 403 || res.statusCode === 404 || (res.statusCode !== 200 && res.statusCode !== 206)) {
            res.resume();
            cdnMarkFail(host); // 失败 → 写入 BAD 列表
            if (ci < candidates.length) {
              console.log(`[downloader] ${host} → HTTP ${res.statusCode}，换子域重试 (${ci}/${candidates.length})`);
              return attempt();
            }
            return reject(new Error(`HTTP ${res.statusCode}（${host}）`));
          }
          // 若服务器返回 200（无视 Range），从头写
          const writeStart = res.statusCode === 206 ? start : 0;
          const mode = writeStart > 0 ? "a" : "w";
          let done = writeStart;
          const stream = fs.createWriteStream(tmpFile, { flags: mode });
          res.on("data", (c) => {
            done += c.length;
            if (item.total) item.doneBytes = done - writeStart + (item.baseBytes || 0);
            if (onProgress) onProgress({ done, total: item.total });
          });
          res.pipe(stream);
          stream.on("finish", () => {
            // 校验：若已到达或超过总大小则完成（无法精确校验时以 HTTP 结束为准）
            fs.renameSync(tmpFile, item.savePath);
            cdnMarkSuccess(host); // 成功 → 写入 GOOD 列表
            resolve("done");
          });
          stream.on("error", (e) => reject(e));
          req.on("error", (e) => reject(e));
        }
      );
      req.setTimeout(30000, () => {
        try {
          req.destroy(new Error("连接超时"));
        } catch (_) {}
      });
      req.on("error", (e) => {
        // 连接级错误（socket hang up / ECONNRESET 等）→ 换子域重试
        cdnMarkFail(host);
        if (ci < candidates.length) {
          console.log(`[downloader] ${host} → ${String(e.message).slice(0, 40)}，换子域重试`);
          return attempt();
        }
        reject(e);
      });
      req.end();
    };

    attempt();
  });
}

function aria2Rpc(method, params) {
  const c = cfg.readConfig();
  const token = c.aria2Token;
  const endpoint = c.aria2Path && c.aria2Path.trim() ? c.aria2Path.trim() : "http://127.0.0.1:6800/jsonrpc";
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2),
    method,
    params: token ? ["token:" + token].concat(params) : params
  };
  const { request } = endpoint.startsWith("https") ? require("https") : require("http");
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(endpoint);
    } catch (e) {
      return reject(new Error("aria2 RPC 地址无效: " + endpoint));
    }
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        },
        rejectUnauthorized: false,
        timeout: 20000
      },
      (res) => {
        let d = "";
        res.on("data", (chunk) => (d += chunk));
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return reject(new Error((j.error.message) || `aria2 错误 code=${j.error.code}`));
            resolve(j.result);
          } catch (e) {
            reject(new Error("aria2 返回非 JSON: " + String(d).slice(0, 120)));
          }
        });
      }
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      try { req.destroy(new Error("aria2 RPC 超时")); } catch (_) {}
    });
    req.write(payload);
    req.end();
  });
}

/**
 * aria2 addUri 基础 options。
 * @param {boolean} [includeDir] 是否传 dir（= 设置里 downloadPath）。
 *   仅当 aria2 与服务器同一台设备时为 true；跨设备不传，aria2 用默认目录。
 *   缺省 true（保留旧行为），调用方按同机判断显式传入。
 */
function aria2DirOptions(c, outName, includeDir = true) {
  const options = {
    out: sanitizeFileName(outName),
    "continue": "true",
    "allow-overwrite": "true",
    "auto-file-renaming": "false"
  };
  if (includeDir && c.downloadPath && c.downloadPath.trim()) options["dir"] = c.downloadPath.trim();
  return options;
}

function lanIPv4() {
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces || {})) {
      for (const i of list || []) {
        const fam = i.family;
        if ((fam === "IPv4" || fam === 4) && !i.internal) return i.address;
      }
    }
  } catch (_) {}
  return "";
}

/** 本机生成 sidecar JSON，公开短链给 aria2 拉到下载目录。 */
async function aria2AddIndexJson(outName, id, entry) {
  const c = cfg.readConfig();
  videoIndex.writeFetchableSidecar(id, entry);
  const port = c.port || 28463;
  const host = process.env.IWARA_PUBLIC_HOST || lanIPv4() || "127.0.0.1";
  const url = "http://" + host + ":" + port + "/api/index-sidecar?id=" + encodeURIComponent(id) + "&k=" + encodeURIComponent(videoIndex.sidecarKey(id));
  const options = aria2DirOptions(c, outName, await deviceCheck.aria2SameDevice(c.aria2Path) === true);
  options["max-connection-per-server"] = "1";
  console.log("[downloader] 索引 JSON → aria2", url, "→", outName);
  return aria2Rpc("aria2.addUri", [[url], options]);
}

function aria2FileName(st) {
  try {
    const files = (st && st.files) || [];
    const p = files[0] && files[0].path;
    if (p) return path.basename(String(p));
  } catch (_) {}
  return "";
}

function aria2StatusHasId(st, id, fileName) {
  const vid = String(id || "");
  const needle = vid ? "[" + vid + "]" : "";
  const name = aria2FileName(st);
  if (needle && name && name.indexOf(needle) >= 0) return true;
  if (fileName && name && name === sanitizeFileName(fileName)) return true;
  const uris = ((st && st.files && st.files[0] && st.files[0].uris) || []).map((u) => String(u.uri || ""));
  if (vid && uris.some((u) => u.indexOf(vid) >= 0)) return true;
  return false;
}

async function aria2TellList(method) {
  try {
    const keys = ["gid", "status", "files", "totalLength", "completedLength"];
    const r = await aria2Rpc(method, [0, 1000, keys]);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    console.error("[downloader] " + method + " 失败:", e && e.message || e);
    return [];
  }
}

/** 活动 / 等待 / 已完成 里已有同视频 → 视为已下过。 */
async function aria2AlreadyHas(id, fileName) {
  const lists = await Promise.all([
    aria2TellList("aria2.tellActive"),
    aria2TellList("aria2.tellWaiting"),
    aria2TellList("aria2.tellStopped")
  ]);
  for (const list of lists) {
    for (const st of list) {
      if (aria2StatusHasId(st, id, fileName)) return true;
    }
  }
  return false;
}

function markSkipped(item, reason) {
  item.state = "skipped";
  item.progress = 100;
  item.error = reason || "已下载，跳过";
  task.completed++;
}

function localFileExists(savePath) {
  try {
    return !!(savePath && fs.existsSync(savePath) && fs.statSync(savePath).size > 0);
  } catch (_) {
    return false;
  }
}

/** 下载根目录（及一层作者子目录）里文件名含 [视频id] 的非空视频 → 视为已下过（不靠索引）。 */
function findExistingVideoFile(root, id) {
  const vid = String(id || "").trim();
  if (!vid || !root) return "";
  const needle = "[" + vid + "]";
  function scanDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ""; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.indexOf(needle) < 0 || !/\.(mp4|webm|mov|mkv)$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      try { if (fs.statSync(full).size > 0) return full; } catch (_) {}
    }
    return "";
  }
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "";
  } catch (_) { return ""; }
  const hit = scanDir(root);
  if (hit) return hit;
  // 作者子目录只扫一层，避免把整个共享盘走一遍
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return ""; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "@eaDir" || e.name === "#recycle" || e.name === ".git") continue;
    const found = scanDir(path.join(root, e.name));
    if (found) return found;
  }
  return "";
}

/** aria2 后端：addUri 推送（支持 http/https；DSM 自签名证书忽略校验） */
async function aria2Add(item) {
  const c = cfg.readConfig();
  const options = aria2DirOptions(c, item.file, await deviceCheck.aria2SameDevice(c.aria2Path) === true);
  options["max-connection-per-server"] = "4";
  options.split = "4";
  options["allow-overwrite"] = "false";
  // 关键：aria2 默认 UA 是 aria2/1.37.0，Cloudflare 会 403 拦截；
  // 必须带精简浏览器 UA（NO_AWK 版，与 direct 后端一致）才能过 CF
  const headers = [`User-Agent: ${api.DEFAULT_UA}`];
  // 只传含 cf_clearance 的 Cookie；过期/deleted 的 _ga 会让 CF 直接 403
  if (c.iwaraCookie && /cf_clearance=/.test(c.iwaraCookie) && !/deleted/i.test(c.iwaraCookie)) {
    headers.push(`Cookie: ${c.iwaraCookie}`);
  }
  options.header = headers;
  // aria2 解析 *.iwara.tv 用的 DNS：读配置 aria2Dns（群晖 DNS Server 套件），留空则不传
  const dns = String(c.aria2Dns || "").trim();
  if (dns) options["dns-server"] = dns;
  return aria2Rpc("aria2.addUri", [[item.url], options]);
}

// // ---------- 任务循环 ----------
// async function runDownloadLoop() {
//   if (task.status !== "running") return;
//   const c = cfg.readConfig();
//   const concurrency = c.concurrency || 3;
// 
//   while (task.status === "running" && task.idx < task.items.length) {
//     while (activeDownloads >= concurrency && task.status === "running") {
//       await new Promise((r) => setTimeout(r, 500));
//     }
//     if (task.status !== "running") break;
// 
//     const item = task.items[task.idx];
//     task.idx++;
//     if (item.state !== "pending") continue;
//     activeDownloads++;
// 
//     try {
//       item.state = "downloading";
//       saveTask();
// 
//       const existing = findExistingVideoFile(c.downloadPath, item.id);
//       if (existing) {
//         item.file = path.basename(existing);
//         item.savePath = existing;
//         if (!item.title || item.title === item.id) item.title = item.file.replace(/\.(mp4|webm|mov|mkv)$/i, "");
//         markSkipped(item, "文件已存在，跳过");
//         thumbCache.ensureThumb(item.id, { filePath: existing }).catch(() => null);
//       } else if (c.downloadBackend === "aria2" && await aria2AlreadyHas(item.id, item.file)) {
//         markSkipped(item, "Aria2 已有此文件，跳过");
//       } else if (c.downloadBackend === "aria2") {
//         // aria2：也先取 fresh 链接（下载链接会到期，不能复用旧 URL）
//         const info = await api.getVideoInfo(item.id);
//         applyParsedName(item, info, c);
//         item.url = info.downloadUrl;
//         if (info.file && info.file.size) item.total = info.file.size;
//         if (!item.url) throw new Error("无法获取下载链接: " + (info.error || "未知"));
//         await api.autoLikeFollow(info);
//         if (await aria2AlreadyHas(item.id, item.file)) {
//           markSkipped(item, "Aria2 已有此文件，跳过");
//         } else {
//           const toggles = cfg.normalizeDownloadToggles(c.downloadToggles);
//           if (toggles.video) {
//             await aria2Add(item);
//           } else {
//             item.error = "已跳过视频（设置未勾选）";
//           }
//           const packed = videoIndex.fromDownload(info, item);
//           if (packed && toggles.json) {
//             try {
//               await aria2AddIndexJson(videoIndex.sidecarFileName(item.file), packed.id, packed.entry);
//             } catch (e) {
//               console.error("[downloader] 索引 JSON 推送 aria2 失败:", e && e.message || e);
//             }
//           }
//           // aria2 异步下载，无法（简单）追踪进度 → 直接标记为已提交
//           item.state = "submitted";
//           item.progress = 100;
//           if (toggles.video) item.error = "已提交至 Aria2（进度请查看 Aria2 WebUI）";
//           task.completed++;
//           if (toggles.json) await videoIndex.recordDownload(c.downloadPath, info, item, { writeSidecar: false });
//         }
//       } else {
//         // direct：每次下载都重新解析直链 —— 下载链接会到期，必须用 fresh 链接
//         const info = await api.getVideoInfo(item.id);
//         applyParsedName(item, info, c);
//         item.url = info.downloadUrl;
//         if (info.file && info.file.size) item.total = info.file.size;
//         if (!item.url) throw new Error("无法获取下载链接: " + (info.error || "未知"));
//         await api.autoLikeFollow(info);
//         const authorDir = c.useAuthorSubdir ? sanitizeFileName(info.author || item.author || "unknown") : "";
//         item.savePath = authorDir ? safeJoin(c.downloadPath, path.join(authorDir, item.file)) : safeJoin(c.downloadPath, item.file);
//         // 确保目录存在
//         fs.mkdirSync(path.dirname(item.savePath), { recursive: true });
//         const toggles = cfg.normalizeDownloadToggles(c.downloadToggles);
//         if (!toggles.video) {
//           item.state = "done";
//           item.progress = 100;
//           item.error = "已跳过视频（设置未勾选）";
//           task.completed++;
//           if (toggles.json) await videoIndex.recordDownload(c.downloadPath, info, item, { writeSidecar: true, sidecarOnly: true });
//         } else if (localFileExists(item.savePath)) {
//           markSkipped(item, "文件已存在，跳过");
//         } else {
//           const result = await downloadToFile(item, (p) => {
//             item.doneBytes = p.done;
//             item.progress = item.total ? Math.min(99, Math.round((p.done / item.total) * 100)) : 0;
//             saveTask();
//           });
//           if (result === "done") {
//             item.state = "done";
//             item.progress = 100;
//             item.doneBytes = item.total || 0;
//             task.completed++;
//             if (toggles.json) await videoIndex.recordDownload(c.downloadPath, info, item);
//             await thumbCache.ensureFromInfo(item.id, info, item.savePath);
//           }
//         }
//       }
//     } catch (e) {
//       item.error = String(e.message || e);
//       item.retries = (item.retries || 0) + 1;
//       if (item.retries <= MAX_RETRY && task.status === "running") {
//         item.state = "pending"; // 放回队尾？简单起见：延迟重试（同位置）
//         task.idx = Math.max(0, task.idx - 1);
//         await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * item.retries));
//       } else {
//         item.state = "failed";
//         task.failed++;
//       }
//     } finally {
//       activeDownloads--;
//       saveTask();
//     }
//   }
// 
//   if (task.status === "running") {
//     task.status = "idle";
//     saveTask();
//     console.log(`[downloader] 任务结束：完成 ${task.completed}，失败 ${task.failed}`);
//   }
// }
// 

// ---------- 任务循环 ----------
// 2026-09-03 修改：node 直连下载做成真实并发（对照 gbmd produce/consume）。
// 【原代码】runDownloadLoop 单 while + await downloadToFile，activeDownloads 永远最多 1。
// 【改为】用户原话「iwara node下载模式实际无并发，且任务会在下载列表名字闪来闪去，对比 gamebanana-mods-downloader-server 找出原因」
// 【思路】gbmd 用 N 个 consume() 并行 executeDownloadItem；iwara 这边把「解析直链 + 下载」拆成 processOneItem，
//   启动 min(concurrency, pending) 个 worker。列表闪名是因为 applyParsedName 改 title/file 后前端 1.5s 全量 innerHTML 重绘，
//   下一提交单独修渲染；本提交只修并发，让配置的 concurrency 真正同时跑。
async function processOneItem(item) {
  const c = cfg.readConfig();
  try {
    item.state = "downloading";
    saveTask();

    const existing = findExistingVideoFile(c.downloadPath, item.id);
    if (existing) {
      item.file = path.basename(existing);
      item.savePath = existing;
      if (!item.title || item.title === item.id) item.title = item.file.replace(/\.(mp4|webm|mov|mkv)$/i, "");
      markSkipped(item, "文件已存在，跳过");
      thumbCache.ensureThumb(item.id, { filePath: existing }).catch(() => null);
      return;
    }
    if (c.downloadBackend === "aria2" && await aria2AlreadyHas(item.id, item.file)) {
      markSkipped(item, "Aria2 已有此文件，跳过");
      return;
    }
    if (c.downloadBackend === "aria2") {
      const info = await api.getVideoInfo(item.id);
      applyParsedName(item, info, c);
      item.url = info.downloadUrl;
      if (info.file && info.file.size) item.total = info.file.size;
      if (!item.url) throw new Error("无法获取下载链接: " + (info.error || "未知"));
      await api.autoLikeFollow(info);
      if (await aria2AlreadyHas(item.id, item.file)) {
        markSkipped(item, "Aria2 已有此文件，跳过");
        return;
      }
      const toggles = cfg.normalizeDownloadToggles(c.downloadToggles);
      if (toggles.video) {
        await aria2Add(item);
      } else {
        item.error = "已跳过视频（设置未勾选）";
      }
      const packed = videoIndex.fromDownload(info, item);
      if (packed && toggles.json) {
        try {
          await aria2AddIndexJson(videoIndex.sidecarFileName(item.file), packed.id, packed.entry);
        } catch (e) {
          console.error("[downloader] 索引 JSON 推送 aria2 失败:", e && e.message || e);
        }
      }
      item.state = "submitted";
      item.progress = 100;
      if (toggles.video) item.error = "已提交至 Aria2（进度请查看 Aria2 WebUI）";
      task.completed++;
      if (toggles.json) await videoIndex.recordDownload(c.downloadPath, info, item, { writeSidecar: false });
      return;
    }

    const info = await api.getVideoInfo(item.id);
    applyParsedName(item, info, c);
    item.url = info.downloadUrl;
    if (info.file && info.file.size) item.total = info.file.size;
    if (!item.url) throw new Error("无法获取下载链接: " + (info.error || "未知"));
    await api.autoLikeFollow(info);
    const authorDir = c.useAuthorSubdir ? sanitizeFileName(info.author || item.author || "unknown") : "";
    item.savePath = authorDir ? safeJoin(c.downloadPath, path.join(authorDir, item.file)) : safeJoin(c.downloadPath, item.file);
    fs.mkdirSync(path.dirname(item.savePath), { recursive: true });
    const toggles = cfg.normalizeDownloadToggles(c.downloadToggles);
    if (!toggles.video) {
      item.state = "done";
      item.progress = 100;
      item.error = "已跳过视频（设置未勾选）";
      task.completed++;
      if (toggles.json) await videoIndex.recordDownload(c.downloadPath, info, item, { writeSidecar: true, sidecarOnly: true });
      return;
    }
    if (localFileExists(item.savePath)) {
      markSkipped(item, "文件已存在，跳过");
      return;
    }
    const result = await downloadToFile(item, (p) => {
      item.doneBytes = p.done;
      item.progress = item.total ? Math.min(99, Math.round((p.done / item.total) * 100)) : 0;
      saveTask();
    });
    if (result === "done") {
      item.state = "done";
      item.progress = 100;
      item.doneBytes = item.total || 0;
      task.completed++;
      if (toggles.json) await videoIndex.recordDownload(c.downloadPath, info, item);
      await thumbCache.ensureFromInfo(item.id, info, item.savePath);
    }
  } catch (e) {
    item.error = String(e.message || e);
    item.retries = (item.retries || 0) + 1;
    if (item.retries <= MAX_RETRY && task.status === "running") {
      // 重试等待中不设 pending，避免其他 worker 抢走同一项
      item.state = "retry-wait";
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * item.retries));
      if (task.status === "running") item.state = "pending";
    } else {
      item.state = "failed";
      task.failed++;
    }
  } finally {
    if (activeDownloads > 0) activeDownloads--;
    saveTask();
  }
}

async function runDownloadLoop() {
  if (task.status !== "running") return;
  const c = cfg.readConfig();
  const concurrency = Math.max(1, Math.min(8, parseInt(c.concurrency, 10) || 3));

  const takeNext = () => {
    if (task.status !== "running") return null;
    for (const it of task.items) {
      if (it.state === "pending") {
        it.state = "downloading";
        return it;
      }
    }
    return null;
  };

  const worker = async () => {
    while (task.status === "running") {
      const item = takeNext();
      if (!item) return;
      activeDownloads++;
      await processOneItem(item);
    }
  };

  const n = Math.max(1, Math.min(concurrency, (task.items || []).filter((it) => it.state === "pending" || it.state === "downloading").length || concurrency));
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  // 重试把失败项改回 pending 时，本轮 worker 可能已退出；还有 pending 就再开一轮
  while (task.status === "running" && (task.items || []).some((it) => it.state === "pending")) {
    const again = [];
    const left = (task.items || []).filter((it) => it.state === "pending").length;
    const n2 = Math.max(1, Math.min(concurrency, left));
    for (let i = 0; i < n2; i++) again.push(worker());
    await Promise.all(again);
  }

  if (task.status === "running") {
    task.status = "idle";
    saveTask();
    console.log(`[downloader] 任务结束：完成 ${task.completed}，失败 ${task.failed}`);
  }
}

// ---------- 控制 ----------
function makeTaskItem(it, c, root) {
  const authorDir = c.useAuthorSubdir ? sanitizeFileName(it.author || "unknown") : "";
  const file = sanitizeFileName(it.file || `${it.id}.mp4`);
  const savePath = authorDir
    ? safeJoin(root, path.join(authorDir, file))
    : safeJoin(root, file);
  return {
    id: it.id,
    title: it.title || "",
    author: it.author || "",
    authorId: it.authorId || "",
    file,
    url: it.url || "",
    savePath,
    state: "pending",
    progress: 0,
    doneBytes: 0,
    total: it.size || 0,
    retries: 0,
    error: ""
  };
}

/** @param mods [{id, title, author}] */
async function startDownloadTask(items) {
  const c = cfg.readConfig();
  const root = c.downloadPath;
  if (!root) throw new Error("请先在设置中配置下载路径");

  // 【原代码】每次入队用新 list 整表替换 task.items，旧任务从进度页消失。【改为】用户原话「任务列表改成不会被自动移除，只能手动移除（不删除文件）」【思路】按 id 合并追加；进行中的不重置
  if (!Array.isArray(task.items)) task.items = [];
  let added = 0;
  let resumed = 0;
  for (const it of items) {
    const id = String(it.id || "").trim();
    if (!id) continue;
    const exist = task.items.find((x) => x.id === id);
    if (exist) {
      if (exist.state === "done" || exist.state === "skipped" || exist.state === "submitted" || exist.state === "downloading") continue;
      exist.state = "pending";
      exist.retries = 0;
      exist.error = "";
      exist.progress = exist.progress || 0;
      resumed++;
      continue;
    }
    task.items.push(makeTaskItem(it, c, root));
    added++;
  }

  task.backend = c.downloadBackend;
  task.totalBytes = task.items.reduce((s, i) => s + (i.total || 0), 0);
  if (task.status !== "running") {
    task.status = "running";
    task.idx = 0;
    saveTask();
    runDownloadLoop().catch((e) => console.error("[downloader] loop error:", e));
  } else {
    saveTask();
  }
  return { ok: true, total: task.items.length, added, resumed };
}

function removeItem(id) {
  // 只从任务列表拿掉，不删磁盘上的视频 / .part / 索引
  const vid = String(id || "").trim();
  const before = (task.items || []).length;
  task.items = (task.items || []).filter((it) => it.id !== vid);
  const removed = before - task.items.length;
  task.completed = (task.items || []).filter((it) => it.state === "done" || it.state === "skipped" || it.state === "submitted").length;
  task.failed = (task.items || []).filter((it) => it.state === "failed" || it.state === "error").length;
  saveTask();
  return { ok: true, removed, remaining: task.items.length };
}

function pauseTask() {
  if (task.status === "running") {
    task.status = "paused";
    saveTask();
  }
  return task.status;
}

function resumeTask() {
  if (task.status === "paused") {
    task.status = "running";
    if (task.idx >= task.items.length) task.idx = 0;
    saveTask();
    runDownloadLoop().catch((e) => console.error("[downloader] loop error:", e));
  }
  return task.status;
}

function stopTask() {
  task.status = "idle";
  saveTask();
  return "idle";
}

function setConcurrency(n) {
  const c = cfg.readConfig();
  c.concurrency = Math.max(1, Math.min(8, parseInt(n, 10) || 3));
  cfg.writeConfig(c);
  return c.concurrency;
}

function removeCompleted() {
  const keep = [];
  let n = 0;
  for (const it of task.items || []) {
    if (it.state === "done" || it.state === "skipped" || it.state === "submitted") {
      n++;
      continue;
    }
    keep.push(it);
  }
  task.items = keep;
  task.completed = Math.max(0, (task.completed || 0) - n);
  saveTask();
  return { ok: true, removed: n, remaining: keep.length };
}

function retryFailed(id) {
  const vid = String(id || "").trim();
  let n = 0;
  for (const it of task.items) {
    if (vid && it.id !== vid) continue;
    if (it.state === "failed" || it.state === "error") {
      it.state = "pending";
      it.retries = 0;
      it.error = "";
      n++;
    }
  }
  if (n > 0 && task.status !== "running") {
    task.status = "running";
    task.idx = 0;
    saveTask();
    runDownloadLoop().catch((e) => console.error("[downloader] loop error:", e));
  } else {
    saveTask();
  }
  return n;
}

function clearFailed() {
  const keep = [];
  let n = 0;
  for (const it of task.items || []) {
    if (it.state === "failed" || it.state === "error") {
      n++;
      continue;
    }
    keep.push(it);
  }
  task.items = keep;
  task.failed = 0;
  saveTask();
  return { ok: true, removed: n, remaining: keep.length };
}

// 模块加载时恢复 CDN 子域成功/失败列表（从外部文件 cdn_hosts_state.json）
cdnLoadState();

module.exports = {
  getTask, restorePendingTask,
  startDownloadTask, pauseTask, resumeTask, stopTask, setConcurrency, retryFailed, removeCompleted, removeItem, clearFailed,
  sanitizeFileName, fmtSize,
  aria2AddIndexJson
};