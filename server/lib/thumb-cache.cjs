// 封面缓存：按视频 id 落到项目目录 server/thumbs/<id>.jpg
// 用户原话：「封面是后台扫描完成抽帧，前台直接读取」「打开视频页面所有视频都已经是加载好封面」
// AI 思路：启动后后台扫下载目录，tool/ffmpeg 抽 1s 处一帧写入 thumbs/。
//   /api/thumb 只读已有 jpg，请求路径不抽帧。下载完成时顺手补一张。
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const api = require("./iwara-api");

const DATA_DIR = process.env.GBMD_DATA_DIR || path.join(__dirname, "..");
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
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

function hasThumb(id) {
  const p = thumbPath(id);
  if (!p) return false;
  try { return fs.existsSync(p) && fs.statSync(p).size > 32 && isJpegFile(p); }
  catch (_) { return false; }
}

function readThumb(id) {
  const p = thumbPath(id);
  if (!p || !hasThumb(id)) return null;
  try {
    return { buf: fs.readFileSync(p), contentType: "image/jpeg", path: p };
  } catch (_) { return null; }
}

function writeThumb(id, buf) {
  const p = thumbPath(id);
  if (!p || !buf || !buf.length) return null;
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

async function fetchRemote(id, fileId, n) {
  const vid = safeId(id);
  const fid = String(fileId || "").trim();
  if (!vid || !fid) return null;
  const img = await api.fetchThumbnail(fid, n);
  if (!img || !img.buf || !img.buf.length) return null;
  writeThumb(vid, img.buf);
  return { buf: img.buf, contentType: img.contentType || "image/jpeg" };
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
    if (o.filePath && await extractFrame(o.filePath, out)) return readThumb(vid);
    if (o.fileId) {
      const remote = await fetchRemote(vid, o.fileId, o.n);
      if (remote) return remote;
    }
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
  if (inflight.has(vid)) return inflight.get(vid);
  const job = (async () => {
    const out = thumbPath(vid);
    if (await extractFrame(fp, out)) return readThumb(vid);
    // 本地抽帧失败，尝试从 Iwara CDN 下载
    const fid = fileIdOf(info);
    if (fid) {
      const remote = await fetchRemote(vid, fid, thumbIndexOf(info));
      if (remote) return remote;
    }
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
        return ensureThumb(vid, {
          filePath: found && found.file || "",
          fileId: entry.fileId || (found && found.entry && found.entry.fileId) || ""
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
  extractFrame, listCached, warmupAll, warmupReady
};
