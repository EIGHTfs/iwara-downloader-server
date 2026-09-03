// ============================================================
// 下载索引（精简）
//
// 我们生成的结构（不以完整 API dump 落盘）：
// {
//   "z2rctWsaRNogFK": {
//     "name": "作者显示名",
//     "username": "作者用户名",
//     "title": "视频标题",
//     "fileId": "7d14494c-072b-43b5-a67c-42b75d286426",
//     "duration": 124,
//     "tags": [{ "id": "kancolle", "type": "general", "sensitive": false }],
//     "createdAt": "2025-06-03T21:16:40.000Z"
//   }
// }
//
// 读取兼容别人那种完整 /video/:id dump（id/user/file/tags/_fetchTime）。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const crypto = require("crypto");
const SCHEMA = "iwara-index/1";
const CATALOG_NAME = "iwara-index.json";
const DATA_DIR = process.env.GBMD_DATA_DIR || path.join(__dirname, "..");
const SIDECAR_CACHE = path.join(DATA_DIR, "index-sidecars");

function sidecarKey(id) {
  const cfg = require("../config").readConfig();
  const secret = cfg.passwordSalt || cfg.aria2Token || "iwara-index";
  return crypto.createHmac("sha256", String(secret)).update(String(id)).digest("hex").slice(0, 16);
}

function writeFetchableSidecar(id, entry) {
  if (!id || !entry) return null;
  fs.mkdirSync(SIDECAR_CACHE, { recursive: true });
  const file = path.join(SIDECAR_CACHE, id + ".json");
  writeJson(file, sidecarPayload(id, entry));
  return { id, key: sidecarKey(id), file };
}

function readFetchableSidecar(id, key) {
  if (!id || sidecarKey(id) !== String(key || "")) return null;
  const file = path.join(SIDECAR_CACHE, id + ".json");
  const raw = readJson(file);
  if (!raw) return null;
  return Buffer.from(JSON.stringify(raw, null, 2), "utf8");
}

function isWritableDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** 下载根目录（Aria2 机器上的路径）可能本机不可写；数据目录一定写。 */
function catalogRoots(downloadRoot) {
  const out = [];
  const data = path.resolve(DATA_DIR);
  if (downloadRoot) {
    const r = path.resolve(downloadRoot);
    if (r !== data) out.push(r);
  }
  out.push(data);
  return out;
}

function asTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (typeof t === "string") {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ id: t, type: "", sensitive: false });
      continue;
    }
    if (!t || typeof t !== "object") continue;
    const id = String(t.id || t.name || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: String(t.type || ""),
      sensitive: !!t.sensitive
    });
  }
  return out;
}

function emptyEntry() {
  return {
    name: "",
    username: "",
    title: "",
    fileId: "",
    duration: 0,
    tags: [],
    createdAt: ""
  };
}

function looksLikeEntry(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return !!(obj.title || obj.username || obj.fileId || obj.createdAt || obj.name);
}

function looksLikeDump(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.user && typeof obj.user === "object") return true;
  if (obj.file && typeof obj.file === "object" && (obj.file.id || obj.file.duration != null)) return true;
  if (obj.id && (obj.tags || obj.rating || obj.numViews != null || obj._fetchTime)) return true;
  return false;
}

/** 别人完整 dump / 我们精简条目 → 精简条目。识别不了返回 null。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (looksLikeDump(raw)) {
    const user = raw.user && typeof raw.user === "object" ? raw.user : {};
    const file = raw.file && typeof raw.file === "object" ? raw.file : {};
    return {
      name: String(user.name || raw.name || raw.authorName || ""),
      username: String(user.username || raw.username || raw.author || ""),
      title: String(raw.title || ""),
      fileId: String(file.id || raw.fileId || ""),
      duration: Number(file.duration || raw.duration) || 0,
      tags: asTags(raw.tags),
      createdAt: String(raw.createdAt || "")
    };
  }
  if (!looksLikeEntry(raw)) return null;
  return {
    name: String(raw.name || raw.authorName || ""),
    username: String(raw.username || raw.author || ""),
    title: String(raw.title || ""),
    fileId: String(raw.fileId || ""),
    duration: Number(raw.duration) || 0,
    tags: asTags(raw.tags),
    createdAt: String(raw.createdAt || "")
  };
}

function idOfDump(raw) {
  return String((raw && raw.id) || "").trim();
}

/** 任意 JSON（单条 dump / {id:entry} 图 / {videos:{}} / 数组）→ { [id]: entry } */
function parseIndexPayload(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const it of raw) {
      const id = idOfDump(it);
      const e = normalizeEntry(it);
      if (id && e) out[id] = e;
    }
    return out;
  }
  if (typeof raw !== "object") return out;
  if (raw.videos && typeof raw.videos === "object" && !Array.isArray(raw.videos)) {
    return parseIndexPayload(raw.videos);
  }
  if (raw.items && Array.isArray(raw.items)) return parseIndexPayload(raw.items);
  if (looksLikeDump(raw) && idOfDump(raw)) {
    const e = normalizeEntry(raw);
    if (e) out[idOfDump(raw)] = e;
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "schema" || k === "updatedAt" || k === "count") continue;
    const e = normalizeEntry(v);
    if (e) out[String(k)] = e;
  }
  return out;
}

function fromDownload(info, item) {
  const raw = (info && info.raw) || {};
  const user = raw.user || {};
  const file = raw.file || {};
  const id = String((info && info.id) || (item && item.id) || raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    entry: {
      name: String(user.name || (info && info.alias) || ""),
      username: String(user.username || (info && info.author) || (item && item.author) || ""),
      title: String((info && info.title) || (item && item.title) || raw.title || ""),
      fileId: String(file.id || ""),
      duration: Number(file.duration) || 0,
      tags: asTags(raw.tags),
      createdAt: String(raw.createdAt || "")
    }
  };
}

function sidecarPath(videoPath) {
  const ext = path.extname(videoPath);
  const base = ext ? videoPath.slice(0, -ext.length) : videoPath;
  return base + ".json";
}

const VIDEO_EXT = [".mp4", ".webm", ".mkv", ".mov", ".m4v", ".m3u8", ".m3u", ".ts", ".flv", ".mpd"];

function playableStat(file) {
  if (!file) return null;
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const st = fs.statSync(file);
    if (st.size <= 0) return null;
    return st;
  } catch (_) { return null; }
}

function findPlayable(root, id, hintPath) {
  const vid = String(id || "").trim();
  if (!vid) return null;
  const catalog = loadCatalogMap(root);
  const catalogEntry = catalog[vid] || null;

  function fromVideo(file, forcedEntry) {
    const st = playableStat(file);
    if (!st) return null;
    let probe = file;
    let partial = false;
    if (/\.part$/i.test(file)) {
      partial = true;
      probe = file.replace(/\.part$/i, "");
    }
    const ext = path.extname(probe).toLowerCase();
    if (VIDEO_EXT.indexOf(ext) < 0) return null;
    const mapped = parseIndexPayload(readJson(sidecarPath(probe)));
    const entry = forcedEntry || mapped[vid] || catalogEntry || Object.values(mapped)[0] || null;
    return { file, entry, size: st.size, partial };
  }

  const hinted = fromVideo(hintPath, catalogEntry) || fromVideo(hintPath ? hintPath + ".part" : "", catalogEntry);
  if (hinted) return hinted;

  const files = [];
  if (root && fs.existsSync(root)) walkJsonFiles(root, files, 0);
  for (const jf of files) {
    const incoming = parseIndexPayload(readJson(jf));
    if (!incoming[vid]) continue;
    const base = jf.toLowerCase().endsWith(".json") ? jf.slice(0, -5) : jf;
    for (let i = 0; i < VIDEO_EXT.length; i++) {
      const hit = fromVideo(base + VIDEO_EXT[i], incoming[vid]) || fromVideo(base + VIDEO_EXT[i] + ".part", incoming[vid]);
      if (hit) return hit;
    }
  }
  const byName = findExistingById(root, vid);
  if (byName) {
    const hit = fromVideo(byName, catalogEntry);
    if (hit) return hit;
  }
  if (catalogEntry) return { file: null, entry: catalogEntry, size: 0, partial: false };
  return null;
}

function findExistingById(root, id) {
  const vid = String(id || "").trim();
  if (!vid || !root) return "";
  const needle = "[" + vid + "]";
  function scanDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ""; }
    let part = "";
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.indexOf(needle) < 0) continue;
      const full = path.join(dir, e.name);
      if (/\.(mp4|webm|mov|mkv|m4v)$/i.test(e.name)) return full;
      // 用户原话：「没下载完的part文件我希望也能部分播放」
      // AI 思路：按 id 扫目录时完整文件优先；没有完整文件才回 .part（含 m3u8/flv 等扩展）
      if (/\.(mp4|webm|mov|mkv|m4v|m3u8|m3u|ts|flv|mpd)\.part$/i.test(e.name)) part = full;
    }
    return part;
  }
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "";
  } catch (_) { return ""; }
  const hit = scanDir(root);
  if (hit) return hit;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return ""; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "@eaDir" || e.name === "#recycle" || e.name === ".git") continue;
    const found = scanDir(path.join(root, e.name));
    if (found) return found;
  }
  return "";
}

function catalogPath(root) {
  return path.join(root, CATALOG_NAME);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadCatalogMap(root) {
  const map = {};
  for (const r of catalogRoots(root)) {
    Object.assign(map, parseIndexPayload(readJson(catalogPath(r))));
  }
  return map;
}

function saveCatalogMap(root, map) {
  const videos = {};
  for (const [id, e] of Object.entries(map)) videos[id] = e;
  let saved = 0;
  const errors = [];
  for (const r of catalogRoots(root)) {
    try {
      if (path.resolve(r) === path.resolve(DATA_DIR)) {
        writeJson(catalogPath(r), videos);
        saved++;
        continue;
      }
      if (!isWritableDir(r)) {
        errors.push(r + " 不可写");
        continue;
      }
      writeJson(catalogPath(r), videos);
      saved++;
    } catch (e) {
      errors.push(r + ": " + (e && e.message || e));
    }
  }
  if (!saved) throw new Error(errors.join("; ") || "无可用索引目录");
}

function writeSidecar(videoPath, id, entry) {
  if (!videoPath || !id || !entry) return;
  const obj = {};
  obj[id] = entry;
  writeJson(sidecarPath(videoPath), obj);
}

function sidecarFileName(videoFileName) {
  const name = String(videoFileName || "").trim() || "video.mp4";
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return base + ".json";
}

function sidecarPayload(id, entry) {
  const obj = {};
  obj[id] = entry;
  return obj;
}

function sidecarJson(id, entry) {
  return JSON.stringify(sidecarPayload(id, entry), null, 2);
}

function recordDownload(root, info, item, opts) {
  try {
    const packed = fromDownload(info, item);
    if (!packed) return null;
    const writeSidecarFile = !opts || opts.writeSidecar !== false;
    // sidecar：direct 本机落盘后写；aria2 侧由 downloader 把 JSON 推给 RPC 写到下载目录
    if (writeSidecarFile && item && item.savePath && (opts && opts.sidecarOnly || fs.existsSync(item.savePath))) {
      writeSidecar(item.savePath, packed.id, packed.entry);
    }
    const map = loadCatalogMap(root);
    map[packed.id] = packed.entry;
    saveCatalogMap(root, map);
    return packed;
  } catch (e) {
    console.error("[video-index] 写入失败:", e && e.message || e);
    return null;
  }
}

/** 导入别人 dump / 我们自己的图，合并进总表。 */
function importPayload(root, raw) {
  const incoming = parseIndexPayload(raw);
  const map = loadCatalogMap(root);
  const r = mergeMap(map, incoming);
  saveCatalogMap(root, map);
  return { ok: true, added: r.added, updated: r.updated, count: Object.keys(map).length };
}

// ═══════════════════════════════════════════════════════════════
// listCatalog：视频列表 = JSON 文件里有的 ID + 视频文件必须存在
// ═══════════════════════════════════════════════════════════════
// 用户原话：「扫描设置的下载路径下所有 json 文件取到 id 用 id 去匹配封面，视频。
//   不管视频名怎么变只要 id 对的上就能找到，找不到的视频直接不显示在视频列表」
//
// AI 思路：之前 listCatalog 直接读 iwara-index.json 总表返回，
//   不验证视频文件是否存在——总表有 ID 但视频被删/改名/没下完照样显示，点开播不了。
//   现在改为：① 扫下载目录所有 JSON → ② 解析出 ID → ③ 用 ID 找视频文件 → ④ 没视频跳过。
//   视频文件名任意变，只要文件名含 [id] 就能匹配（findExistingById）。
// ═══════════════════════════════════════════════════════════════
function listCatalog(root) {
  // 总表兜底：下载中的视频还没有 sidecar JSON，靠总表取元数据
  const catalogMap = loadCatalogMap(root);
  const result = {};

  // ① 扫下载目录所有 JSON 文件，解析出 { [id]: entry }
  const jsonFiles = [];
  if (root && fs.existsSync(root)) walkJsonFiles(root, jsonFiles, 0);
  const dataDirResolved = path.resolve(DATA_DIR);
  for (const jf of jsonFiles) {
    // 跳过总表文件本身（避免重复）
    if (path.resolve(jf) === path.resolve(catalogPath(root)) ||
        path.resolve(jf) === path.resolve(path.join(dataDirResolved, CATALOG_NAME))) continue;
    const raw = readJson(jf);
    const entries = parseIndexPayload(raw);
    for (const [id, entry] of Object.entries(entries)) {
      if (!id || !entry || result[id]) continue;
      // ② 用 ID 找视频文件：文件名含 [id] 的 mp4/webm/mkv/mov/m4v 或 .part
      const videoFile = findExistingById(root, id);
      if (!videoFile) {
        // 没视频 → 跳过，不显示在列表
        // 用户原话：「找不到的视频直接不显示在视频列表」
        continue;
      }
      // ③ 有视频 → 用 sidecar 元数据，总表兜底补充
      result[id] = Object.assign({}, catalogMap[id] || {}, entry);
    }
  }

  // ④ 总表里有但 JSON 里没扫到的（edge case：只有总表没有 sidecar），也检查视频是否存在
  for (const [id, entry] of Object.entries(catalogMap)) {
    if (result[id]) continue;
    const videoFile = findExistingById(root, id);
    if (!videoFile) continue;
    result[id] = entry;
  }

  return { count: Object.keys(result).length, videos: result };
}

function hasVideo(root, id) {
  const vid = String(id || "").trim();
  if (!vid) return false;
  const map = loadCatalogMap(root);
  return !!map[vid];
}

function catalogFileBuffer(root) {
  const videos = loadCatalogMap(root);
  return Buffer.from(JSON.stringify(videos, null, 2), "utf8");
}

function mergeMap(target, incoming) {
  let added = 0, updated = 0;
  for (const [id, e] of Object.entries(incoming || {})) {
    if (!id || !e) continue;
    if (target[id]) {
      target[id] = Object.assign({}, target[id], e);
      updated++;
    } else {
      target[id] = e;
      added++;
    }
  }
  return { added, updated };
}

function walkJsonFiles(dir, out, depth) {
  if (depth > 6 || out.length >= 8000) return;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) walkJsonFiles(full, out, depth + 1);
    else if (st.isFile() && name.toLowerCase().endsWith(".json") && st.size > 2 && st.size < 32 * 1024 * 1024) {
      out.push(full);
    }
  }
}

/** 扫描下载根目录里别人的 dump / 我们 sidecar，合并进总表。 */
function scanDownloadDir(root) {
  const map = loadCatalogMap(root);
  const files = [];
  if (root && fs.existsSync(root)) walkJsonFiles(root, files, 0);
  let filesRead = 0, filesUsed = 0;
  let added = 0, updated = 0;
  const skip = new Set(catalogRoots(root).map((r) => path.resolve(catalogPath(r))));
  for (const file of files) {
    if (skip.has(path.resolve(file)) || path.basename(file) === CATALOG_NAME) continue;
    filesRead++;
    const raw = readJson(file);
    const incoming = parseIndexPayload(raw);
    const n = Object.keys(incoming).length;
    if (!n) continue;
    filesUsed++;
    const r = mergeMap(map, incoming);
    added += r.added;
    updated += r.updated;
  }
  saveCatalogMap(root, map);
  return { ok: true, filesRead, filesUsed, added, updated, count: Object.keys(map).length };
}

module.exports = {
  SCHEMA,
  CATALOG_NAME,
  emptyEntry,
  normalizeEntry,
  parseIndexPayload,
  fromDownload,
  sidecarPath,
  catalogPath,
  recordDownload,
  importPayload,
  listCatalog,
  findPlayable,
  hasVideo,
  catalogFileBuffer,
  scanDownloadDir,
  sidecarFileName,
  sidecarJson,
  sidecarPayload,
  sidecarKey,
  writeFetchableSidecar,
  readFetchableSidecar
};
