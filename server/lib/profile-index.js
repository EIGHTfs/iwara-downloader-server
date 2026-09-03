// 作者信息索引：json/profile/<username>.json + 总表 json/profile/iwara-profile.json
// 用户原话：「json/profile/放作者信息索引」kiralan:{ name, profile:"/profile/kiralan", avatar:"/avatar/<id>/<id>.jpg" }
// 「下载时同时生成作者索引（存在则跳过，除非name变了）」
// 「有的作者没有avatar检查下原因」——官方 GET /profile/{u} 的 user.avatar 就是 null，不是漏下。
// 「iwara-downloader-server/avatar/保存这些头像」
"use strict";

const fs = require("fs");
const path = require("path");
const jsonDir = require("./json-dir");

const PROFILE_DIR = path.join(jsonDir.JSON_DIR, "profile"); //userdata-manifest.json dir json/profile .json 作者信息索引
const CATALOG = path.join(PROFILE_DIR, "iwara-profile.json");
const AVATAR_DIR = path.join(jsonDir.SERVER_DIR, "..", "avatar"); //userdata-manifest.json dir avatar .jpg 作者头像

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeUser(name) {
  return String(name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
}

function profilePath(username) {
  const u = safeUser(username);
  if (!u || u === "iwara-profile") return "";
  return path.join(PROFILE_DIR, u + ".json");
}

function profileRel(username) {
  const u = String(username || "").trim();
  return u ? "/profile/" + encodeURIComponent(u) : "";
}

function avatarIdOf(idOrUser) {
  if (!idOrUser) return "";
  if (typeof idOrUser === "string") {
    if (/^[0-9a-f-]{36}$/i.test(idOrUser)) return idOrUser;
    const m = idOrUser.match(/\/avatar\/([0-9a-f-]{36})\//i) || idOrUser.match(/\/image\/avatar\/([0-9a-f-]{36})\//i);
    return m ? m[1] : "";
  }
  if (typeof idOrUser === "object") return String(idOrUser.id || "").trim();
  return "";
}

function avatarRel(idOrUser) {
  const id = avatarIdOf(idOrUser);
  return id ? "/avatar/" + id + "/" + id + ".jpg" : "";
}

function avatarFile(idOrUser) {
  const id = avatarIdOf(idOrUser);
  return id ? path.join(AVATAR_DIR, id, id + ".jpg") : "";
}

function avatarExists(idOrUser) {
  const f = avatarFile(idOrUser);
  try { return !!(f && fs.existsSync(f) && fs.statSync(f).size > 32); } catch (_) { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function entryOf(raw, username) {
  const row = raw && typeof raw === "object" ? (raw[username] || raw) : {};
  return {
    name: String(row.name || ""),
    profile: String(row.profile || row["作者首页地址"] || ""),
    avatar: avatarRel(row.avatar || row["头像地址"] || "")
  };
}

function patchCatalog(username, entry) {
  if (!username || !entry) return;
  const map = (readJson(CATALOG) && typeof readJson(CATALOG) === "object") ? readJson(CATALOG) : {};
  map[username] = {
    name: entry.name || "",
    profile: entry.profile || profileRel(username),
    avatar: entry.avatar || ""
  };
  writeJson(CATALOG, map);
}

function rebuildCatalog() {
  const map = {};
  let names = [];
  try { names = fs.readdirSync(PROFILE_DIR); } catch (_) { return map; }
  for (const n of names) {
    if (!n.endsWith(".json") || n === "iwara-profile.json") continue;
    const username = n.slice(0, -5);
    const entry = entryOf(readJson(path.join(PROFILE_DIR, n)), username);
    if (!username || !entry.name) continue;
    map[username] = {
      name: entry.name,
      profile: entry.profile || profileRel(username),
      avatar: entry.avatar || ""
    };
  }
  writeJson(CATALOG, map);
  return map;
}

async function fetchProfileUser(username) {
  try {
    const api = require("./iwara-api");
    const data = await api.getUserProfile(username);
    return (data && data.user && typeof data.user === "object") ? data.user : null;
  } catch (_) {
    return null;
  }
}

async function saveAvatarFile(avatarId) {
  const id = avatarIdOf(avatarId);
  if (!id) return "";
  const dest = avatarFile(id);
  if (avatarExists(id)) return dest;
  const api = require("./iwara-api");
  const img = await api.fetchAvatar(id);
  if (!img || !img.buf || img.buf.length < 32) return "";
  if (api.isIwaraPlaceholder(img.buf)) return "";
  ensureDir(path.dirname(dest));
  const tmp = dest + ".part";
  fs.writeFileSync(tmp, img.buf);
  fs.renameSync(tmp, dest);
  return dest;
}

async function upsertFromUser(user, extra) {
  const u = user && typeof user === "object" ? user : {};
  // 用户名只能用 username，禁止把显示名 author 当文件名（否则 json/profile/<中文名>.json，官方 profile 404）
  const username = safeUser(u.username || (extra && extra.username) || "");
  if (!username) return null;
  const file = profilePath(username);
  if (!file) return null;
  const prev = entryOf(readJson(file), username);
  const existed = !!(prev && (prev.name || prev.profile || prev.avatar !== undefined) && fs.existsSync(file));
  let name = String(u.name || (extra && extra.name) || "").trim();

  // 用户原话：「存在则跳过，除非name变了」
  // 【原代码】空头像每次都打官方 /profile，搜索翻页反复请求。
  // 【改为】文件在且 name 没变就跳过；官方 avatar=null 的作者保持 avatar:""。
  if (existed && prev.name && (!name || name === prev.name)) {
    return { username, file, entry: prev, skipped: true };
  }

  let avatar = avatarRel(u.avatar) || avatarRel(extra && extra.avatar);
  const remote = await fetchProfileUser(username);
  if (remote) {
    if (!name) name = String(remote.name || "").trim();
    if (!avatar) avatar = avatarRel(remote.avatar);
  }
  if (!name) name = prev.name || username;
  if (!avatar) avatar = prev.avatar || "";

  if (avatar && !avatarExists(avatar)) {
    try { await saveAvatarFile(avatar); } catch (_) {}
  }

  const entry = {
    name,
    profile: profileRel(username),
    avatar: avatar || ""
  };
  const obj = {};
  obj[username] = entry;
  writeJson(file, obj);
  patchCatalog(username, entry);
  return { username, file, entry, skipped: false };
}

function upsertFromVideo(v) {
  if (!v) return Promise.resolve(null);
  const user = (v.user && typeof v.user === "object") ? v.user : {};
  const username = user.username || v.username;
  if (!username) return Promise.resolve(null);
  return upsertFromUser(user, {
    username,
    name: user.name || v.alias || ""
  });
}

function upsertFromInfo(info) {
  if (!info) return Promise.resolve(null);
  const raw = info.raw || {};
  const user = (raw.user && typeof raw.user === "object") ? raw.user : {};
  const username = user.username || info.username;
  if (!username) return Promise.resolve(null);
  return upsertFromUser(user, {
    username,
    name: user.name || info.alias || ""
  });
}

function upsertFromIndexEntry(entry) {
  if (!entry || !entry.username) return Promise.resolve(null);
  return upsertFromUser({
    username: entry.username,
    name: entry.name
  }, { username: entry.username, name: entry.name });
}

async function backfillMissing() {
  // 下载当时没挂上 hook 的作者：索引里有 username、json/profile 没有文件
  let map = {};
  try {
    const videoIndex = require("./video-index");
    const cfg = require("../config");
    const listed = videoIndex.listCatalog(cfg.readConfig().downloadPath) || {};
    map = listed.videos || {};
  } catch (_) { return { ok: false }; }
  let added = 0, skipped = 0;
  const seen = new Set();
  for (const e of Object.values(map)) {
    const u = e && e.username;
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const file = profilePath(u);
    if (file && fs.existsSync(file)) { skipped++; continue; }
    try {
      const r = await upsertFromIndexEntry(e);
      if (r && !r.skipped) added++;
    } catch (_) {}
  }
  rebuildCatalog();
  return { ok: true, added, skipped, authors: seen.size };
}

module.exports = {
  PROFILE_DIR,
  AVATAR_DIR,
  CATALOG,
  profilePath,
  profileRel,
  avatarRel,
  avatarFile,
  avatarExists,
  upsertFromUser,
  upsertFromVideo,
  upsertFromInfo,
  upsertFromIndexEntry,
  backfillMissing,
  rebuildCatalog
};
