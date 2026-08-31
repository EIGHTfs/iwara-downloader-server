// ============================================================
// iwara-downloader-server - 会话鉴权（可选密码保护）
// 参考 gbmd auth.js：scrypt 密码 + HttpOnly session cookie
// ============================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.GBMD_DATA_DIR || __dirname;
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

let sessions = new Map(); // token -> expireTs

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      sessions = new Map(Object.entries(data));
    }
  } catch (_) {}
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2), "utf8");
  } catch (_) {}
}

function createSession(hours) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + (hours || 72) * 3600 * 1000);
  saveSessions();
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    saveSessions();
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
  saveSessions();
}

function extractToken(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

function pruneExpired() {
  const now = Date.now();
  let changed = false;
  for (const [t, exp] of sessions) {
    if (exp < now) { sessions.delete(t); changed = true; }
  }
  if (changed) saveSessions();
}

module.exports = { loadSessions, createSession, isValidSession, destroySession, extractToken, pruneExpired };