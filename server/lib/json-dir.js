// 运行态 JSON 目录：仓库根 json/（不是 server/json/）
// 用户原话：「都是运行态json，只许放服务端json文件夹」「而且不止这两个json文件是运行态」
// 「config.json是例外本来就应该在server文件夹」
// userdata-manifest.json 也在 json/
"use strict";

const fs = require("fs");
const path = require("path");

const SERVER_DIR = process.env.GBMD_DATA_DIR || path.join(__dirname, "..");
const JSON_DIR = path.join(SERVER_DIR, "..", "json");

function ensureJsonDir() {
  fs.mkdirSync(JSON_DIR, { recursive: true });
}

function jsonFile(name) {
  return path.join(JSON_DIR, name);
}

function migrateRuntimeJson(name) {
  ensureJsonDir();
  const dest = jsonFile(name);
  if (fs.existsSync(dest)) return dest;
  const legacy = [
    path.join(SERVER_DIR, name),
    path.join(SERVER_DIR, "json", name),
    path.join(SERVER_DIR, "..", name)
  ];
  for (const src of legacy) {
    if (!src || src === dest || !fs.existsSync(src)) continue;
    try { fs.renameSync(src, dest); return dest; } catch (_) {
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); return dest; } catch (_) {}
    }
  }
  return dest;
}

module.exports = { SERVER_DIR, JSON_DIR, jsonFile, ensureJsonDir, migrateRuntimeJson };
