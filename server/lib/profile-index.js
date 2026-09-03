// 作者信息索引：json/profile/<username>.json
// 用户原话：「json/profile/放作者信息索引」kiralan:{ name, profile:"/profile/kiralan", avatar:"/avatar/<id>/<id>.jpg" }
// 「下载时同时生成作者索引（存在则跳过，除非name变了）」
// 「iwara-downloader-server/avatar/保存这些头像」「直接下载不就行了，复用上下载功能，还能跳过重复」
"use strict";

const fs = require("fs");
const path = require("path");
const jsonDir = require("./json-dir");

const PROFILE_DIR = path.join(jsonDir.JSON_DIR, "profile"); //userdata-manifest.json dir json/profile .json 作者信息索引
const AVATAR_DIR = path.join(jsonDir.SERVER_DIR, "..", "avatar"); //userdata-manifest.json dir avatar .jpg 作者头像

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeUser(name) {
  return String(name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
}

function profilePath(username) {
  const u = safeUser(username);
  return u ? path.join(PROFILE_DIR, u + ".json") : "";
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
  const username = safeUser(u.username || (extra && extra.username) || "");
  if (!username) return null;
  let name = String(u.name || (extra && extra.name) || "").trim();
  let avatar = avatarRel(u.avatar) || avatarRel(extra && extra.avatar);
  const file = profilePath(username);
  const prev = entryOf(readJson(file), username);
  const existed = !!(prev && prev.name);

  if (!avatar) {
    const remote = await fetchProfileUser(username);
    if (remote) {
      if (!name) name = String(remote.name || "").trim();
      avatar = avatarRel(remote.avatar);
    }
  }
  if (!name) name = prev.name || username;
  if (!avatar) avatar = prev.avatar || "";

  const sameName = existed && String(prev.name) === String(name);
  const haveFile = avatarExists(avatar || prev.avatar);
  if (sameName && haveFile && prev.avatar) {
    return { username, file, entry: prev, skipped: true };
  }

  if (avatar && !haveFile) {
    try { await saveAvatarFile(avatar); } catch (_) {}
  }

  const entry = {
    name,
    profile: profileRel(username),
    avatar: avatar || prev.avatar || ""
  };
  const obj = {};
  obj[username] = entry;
  writeJson(file, obj);
  return { username, file, entry, skipped: false };
}

function upsertFromVideo(v) {
  if (!v) return Promise.resolve(null);
  const user = (v.user && typeof v.user === "object") ? v.user : {};
  return upsertFromUser(user, {
    username: user.username || v.author || v.username,
    name: user.name || v.alias || v.author
  });
}

function upsertFromInfo(info) {
  if (!info) return Promise.resolve(null);
  const raw = info.raw || {};
  const user = (raw.user && typeof raw.user === "object") ? raw.user : {};
  return upsertFromUser(user, {
    username: user.username || info.author,
    name: user.name || info.alias
  });
}

function upsertFromIndexEntry(entry) {
  if (!entry) return Promise.resolve(null);
  return upsertFromUser({
    username: entry.username,
    name: entry.name
  }, { username: entry.username, name: entry.name });
}

module.exports = {
  PROFILE_DIR,
  AVATAR_DIR,
  profilePath,
  profileRel,
  avatarRel,
  avatarFile,
  avatarExists,
  upsertFromUser,
  upsertFromVideo,
  upsertFromInfo,
  upsertFromIndexEntry
};
