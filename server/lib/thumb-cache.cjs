// 封面缓存：按视频 id 落到项目目录 server/thumbs/<id>.jpg
// 用户原话：「封面是后台扫描完成抽帧，前台直接读取」「打开视频页面所有视频都已经是加载好封面」
// AI 思路：启动后后台扫下载目录，tool/ffmpeg 抽 1s 处一帧写入 thumbs/。
//   /api/thumb 只读已有 jpg，请求路径不抽帧。下载完成时顺手补一张。
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const api = require("./iwara-api");

const DATA_DIR = process.env.GBMD_DATA_DIR || path.join(__dirname, "..");
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const THUMB_DIR = path.join(DATA_DIR, "thumbs"); //userdata-manifest.json dir server/thumbs .jpg 本机封面缓存 thumbs/<id>.jpg
const inflight = new Map();

function safeId(id) {
  const v = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(v)) return "";
  return v;
}

function thumbPath(id) {
  const vid = safeId(id);
  if (!vid) return "";
  return path.join(THUMB_DIR, vid + ".jpg");
}

function isJpegFile(p) {
  try {
    const fd = fs.openSync(p, "r");
    const b = Buffer.alloc(3);
    fs.readSync(fd, b, 0, 3, 0);
    fs.closeSync(fd);
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  } catch (_) { return false; }
}

const IWARA_PLACEHOLDER_MD5 = "a244c06f2a6369b23a5e18c9a2cb2a1b";
function isPlaceholderFile(p) {
  try {
    const st = fs.statSync(p);
    if (st.size !== 4824) return false;
    const buf = fs.readFileSync(p);
    return crypto.createHash("md5").update(buf).digest("hex") === IWARA_PLACEHOLDER_MD5;
  } catch (_) { return false; }
}

function hasThumb(id) {
  const p = thumbPath(id);
  if (!p) return false;
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size <= 32 || !isJpegFile(p)) return false;
    // 占位图不算有封面，允许官方重拉覆盖
    if (isPlaceholderFile(p)) return false;
    return true;
  } catch (_) { return false; }
}

function readThumb(id) {
  const p = thumbPath(id);
  if (!p || !hasThumb(id)) return null;
  try {
    const st = fs.statSync(p);
    return { buf: fs.readFileSync(p), contentType: "image/jpeg", path: p, mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) { return null; }
}

function writeThumb(id, buf, origin) {
  const p = thumbPath(id);
  if (!p || !buf || !buf.length) return null;
  if (api.isIwaraPlaceholder(buf)) return null;
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const tmp = p + ".part";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
  return p;
}

function findFfmpeg() {
  // 【原代码】只找系统 /usr/bin/ffmpeg。【改为】用户原话「项目用到的工具在项目tool目录保存一份 比如ffmpeg」
  // 【思路】优先项目 tool/ffmpeg 包装脚本（自带 ffmpeg-lib），换机系统没有 mediasrv 也能抽帧
  const cands = [
    process.env.FFMPEG || "",
    path.join(PROJECT_ROOT, "tool", "ffmpeg"),
    path.join(DATA_DIR, "..", "tool", "ffmpeg"),
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/bin/ffmpeg",
    "ffmpeg"
  ];
  for (const p of cands) {
    if (!p) continue;
    if (p === "ffmpeg") return p;
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return "";
}

function extractFrame(videoPath, outPath) {
  const bin = findFfmpeg();
  if (!bin || !videoPath || !fs.existsSync(videoPath)) {
    return Promise.resolve(false);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 临时文件必须是 .jpg（群晖 4.1 不认 xxx.jpg.part.jpg）；项目 tool/ffmpeg 是 mediasrv 8.1
  const tmp = outPath.replace(/\.jpg$/i, "") + ".tmp.jpg";
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-ss", "1",
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=320:-2",
    "-q:v", "4",
    "-y", tmp
  ];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 20000);
    child.on("close", (code) => {
      clearTimeout(t);
      try {
        if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 32 && isJpegFile(tmp)) {
          fs.renameSync(tmp, outPath);
          try {
            const id = path.basename(outPath, ".jpg");
          } catch (_) {}
          return resolve(true);
        }
      } catch (_) {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      if (err) console.error("[thumb] ffmpeg:", String(err).slice(0, 200));
      resolve(false);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function fileIdOf(info) {
  if (!info) return "";
  if (info.file && info.file.id) return String(info.file.id);
  if (info.raw && info.raw.file && info.raw.file.id) return String(info.raw.file.id);
  if (info.fileId) return String(info.fileId);
  return "";
}

function thumbIndexOf(info) {
  if (!info) return 0;
  const n = info.thumbnail != null ? info.thumbnail
    : (info.raw && info.raw.thumbnail);
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

async function resolveThumbMeta(id, fileId, n) {
  let fid = String(fileId || "").trim();
  let idx = Number.isFinite(Number(n)) ? Number(n) : null;
  // 封面不进视频索引。缺 fileId/序号就现查官方 /video/:id（只要这两个字段）。
  if (!fid || idx == null) {
    try {
      const meta = await api.getThumbMeta(id);
      if (meta) {
        if (!fid) fid = String(meta.fileId || "");
        if (idx == null && Number.isFinite(Number(meta.thumbnail))) idx = Number(meta.thumbnail);
      }
    } catch (_) {}
  }
  if (idx == null) idx = 0;
  return { fileId: fid, n: idx };
}

async function fetchRemote(id, fileId, n) {
  const vid = safeId(id);
  const meta = await resolveThumbMeta(vid, fileId, n);
  const fid = meta.fileId;
  if (!vid || !fid) return null;
  const img = await api.fetchThumbnail(fid, meta.n);
  if (!img || !img.buf || !img.buf.length) return null;
  writeThumb(vid, img.buf, "official");
  return { buf: img.buf, contentType: img.contentType || "image/jpeg", mtimeMs: Date.now(), size: img.buf.length };
}

// 2026-09-04：搜索/下载时把官方封面落到 thumbs/<id>.jpg。
// 用户原话：「修改代码实现搜索时，下载时从官方获取封面并按本地规范保存优先于本地生成，视频播放从本地获取，包括这从网上获取保存到本地的」
// 【思路】规范=server/thumbs/<id>.jpg。已有文件跳过（低负载）。队列并发 2。
const officialQueue = [];
const officialQueued = new Set();
let officialActive = 0;
const OFFICIAL_CONC = 2;

function saveOfficialThumb(id, fileId, n) {
  const vid = safeId(id);
  if (!vid) return Promise.resolve(null);
  // 已有封面不覆盖（播放页正确图不能被另一次官方/抽帧改掉）
  if (hasThumb(vid)) return Promise.resolve(readThumb(vid));
  if (inflight.has(vid)) return inflight.get(vid);
  const job = fetchRemote(vid, fileId, n).catch((e) => {
    console.error("[thumb] official", vid, e && e.message || e);
    return null;
  }).finally(() => inflight.delete(vid));
  inflight.set(vid, job);
  return job;
}

function pumpOfficialQueue() {
  while (officialActive < OFFICIAL_CONC && officialQueue.length) {
    const it = officialQueue.shift();
    officialQueued.delete(it.id);
    officialActive++;
    saveOfficialThumb(it.id, it.fileId, it.n).finally(() => {
      officialActive--;
      pumpOfficialQueue();
    });
  }
}

function enqueueOfficialThumb(id, fileId, n) {
  const vid = safeId(id);
  const fid = String(fileId || "").trim();
  if (!vid || !fid) return;
  if (hasThumb(vid) || inflight.has(vid) || officialQueued.has(vid)) return;
  officialQueued.add(vid);
  officialQueue.push({ id: vid, fileId: fid, n: n });
  pumpOfficialQueue();
}

function prefetchOfficialFromList(list) {
  const arr = Array.isArray(list) ? list : [];
  let n = 0;
  for (const v of arr) {
    if (!v) continue;
    const vid = safeId(v.id || v.modId);
    if (!vid || hasThumb(vid)) continue;
    const fid = (v.file && v.file.id) || v.fileId || "";
    enqueueOfficialThumb(vid, fid, v.thumbnail);
    n++;
    if (n >= 40) break; // 低负载：导入一次最多入队 40 张
  }
}

function ensureThumb(id, opts) {
  const vid = safeId(id);
  if (!vid) return Promise.resolve(null);
  const hit = readThumb(vid);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(vid)) return inflight.get(vid);
  const job = (async () => {
    const o = opts || {};
    const out = thumbPath(vid);
    // 封面文件名 thumbs/<id>.jpg 就是索引，不写进视频索引。
    // 没带 fileId 也走 fetchRemote：resolveThumbMeta 现查官方 /video/:id 拿 fileId+序号。
    const remote = await fetchRemote(vid, o.fileId, o.n);
    if (remote) return remote;
    if (o.filePath && await extractFrame(o.filePath, out)) return readThumb(vid);
    return null;
  })().catch((e) => {
    console.error("[thumb] ensure", vid, e && e.message || e);
    return null;
  }).finally(() => inflight.delete(vid));
  inflight.set(vid, job);
  return job;
}

// 2026-09-03 用户原话：「视频文件不存在就不要生成封面图」
// 最简逻辑：filePath 不存在 → 跳过；已存在 → 抽帧覆盖
function ensureFromInfo(id, info, filePath) {
  const vid = safeId(id);
  if (!vid) return Promise.resolve(null);
  const fp = filePath || "";
  if (!fp) return Promise.resolve(null);
  // 检查视频文件是否存在
  try {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return Promise.resolve(null);
  } catch (_) { return Promise.resolve(null); }
  // 2026-09-04：播放页不得覆盖已有封面。
  // 【原代码】每次 play-info 都 ensureFromInfo → fetchRemote/extractFrame 覆盖 thumbs/<id>.jpg。
  // 【改为】用户原话「正常的封面播放时刷新变成错误的」「每次HTML封面独立，封面变正确，错误。刷新后恢复原因」
  // 【思路】模拟：GET 官方/抽帧图 15351 → 打 /api/play-info → 1 秒内文件变成另一张 4824。
  //   play.html 又在 500ms/2000ms 用 &t= 强刷，把刚覆盖的错图显示出来。F5 若赶上覆盖前缓存就会「刷新又对」。
  //   已有 jpg 只读；缺图才官方优先、再抽帧。
  if (hasThumb(vid)) return Promise.resolve(readThumb(vid));
  if (inflight.has(vid)) return inflight.get(vid);
  const job = (async () => {
    const out = thumbPath(vid);
    const fid = fileIdOf(info);
    if (fid) {
      const remote = await fetchRemote(vid, fid, thumbIndexOf(info));
      if (remote) return remote;
    }
    if (await extractFrame(fp, out)) return readThumb(vid);
    return null;
  })().catch((e) => {
    console.error("[thumb] ensureFromInfo", vid, e && e.message || e);
    return null;
  }).finally(() => inflight.delete(vid));
  inflight.set(vid, job);
  return job;
}

function localSrc(id) {
  const vid = safeId(id);
  return vid ? "/api/thumb?id=" + encodeURIComponent(vid) : "";
}

function listCached() {
  try {
    if (!fs.existsSync(THUMB_DIR)) return [];
    return fs.readdirSync(THUMB_DIR)
      .filter((n) => n.endsWith(".jpg") && !n.endsWith(".tmp.jpg") && !n.endsWith(".part.jpg"))
      .map((n) => n.slice(0, -4));
  } catch (_) { return []; }
}

function pruneUnknownThumbs(known) {
  const keep = known instanceof Set ? known : new Set(known || []);
  for (const id of listCached()) {
    if (keep.has(id)) continue;
    try { fs.unlinkSync(thumbPath(id)); } catch (_) {}
  }
}

let warmupPromise = null;
let warmupRoot = "";
let warmupDone = false;

function warmupAll(root) {
  const r = String(root || "");
  if (!r) return Promise.resolve({ total: 0, cached: 0 });
  // 同一路径正在扫：复用；扫完后再调（改设置/又下了新片）就再扫一轮
  if (warmupPromise && warmupRoot === r && !warmupDone) return warmupPromise;
  warmupRoot = r;
  warmupDone = false;
  warmupPromise = (async () => {
    const videoIndex = require("./video-index");
    // id 只来自 json 索引：sidecar `{ "<id>": { title, fileId, ... } }` 与 iwara-index.json 的 key
    try { videoIndex.scanDownloadDir(r); } catch (e) {
      console.error("[thumb] scan index", e && e.message || e);
    }
    const catalog = videoIndex.listCatalog(r);
    const videos = (catalog && catalog.videos) || {};
    const ids = Object.keys(videos).filter((vid) => !!safeId(vid));
    pruneUnknownThumbs(ids);
    const missing = ids.filter((vid) => !hasThumb(vid));
    const CONC = 2;
    for (let i = 0; i < missing.length; i += CONC) {
      const batch = missing.slice(i, i + CONC);
      await Promise.all(batch.map(async (vid) => {
        const entry = videos[vid] || {};
        const found = videoIndex.findPlayable(r, vid);
        // warmup 也官方优先，缺官方再抽本地视频帧
        return ensureThumb(vid, {
          fileId: entry.fileId || (found && found.entry && found.entry.fileId) || "",
          filePath: found && found.file || ""
        });
      }));
    }
    const cached = listCached().length;
    warmupDone = true;
    console.log("[thumb] warmup done " + cached + " 张 / " + ids.length + " 个索引 → " + THUMB_DIR);
    return { total: ids.length, cached };
  })().catch((e) => {
    console.error("[thumb] warmup", e && e.message || e);
    warmupPromise = null;
    warmupRoot = "";
    warmupDone = false;
    return { total: 0, cached: 0 };
  });
  return warmupPromise;
}

function warmupReady() { return warmupPromise || Promise.resolve({ total: 0, cached: 0 }); }

module.exports = {
  THUMB_DIR, safeId, thumbPath, hasThumb, readThumb, writeThumb,
  ensureThumb, ensureFromInfo, fileIdOf, thumbIndexOf, localSrc,
  extractFrame, listCached, warmupAll, warmupReady,
  saveOfficialThumb, enqueueOfficialThumb, prefetchOfficialFromList
};
