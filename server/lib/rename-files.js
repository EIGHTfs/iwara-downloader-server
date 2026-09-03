// 按当前文件名模板批量重命名已下载视频
// 用户原话：「iwara 设置增加重命名文件功能类似 gbmd 的合并文件夹，将含 id 的视频但不是模板命名格式的扫描出来先预览，然后批量重命名」
"use strict";

const fs = require("fs");
const path = require("path");
const cfg = require("../config");
const downloader = require("./downloader");
const videoIndex = require("./video-index");

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v"]);

function walkVideos(dir, out, depth) {
  if (depth > 8 || out.length >= 20000) return;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of names) {
    if (name === ".trash" || name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) walkVideos(full, out, depth + 1);
    else if (st.isFile() && VIDEO_EXT.has(path.extname(name).toLowerCase()) && !/\.part$/i.test(name)) {
      out.push(full);
    }
  }
}

function extractId(filename, idSet) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  const brackets = [];
  const re = /\[([A-Za-z0-9_-]{6,24})\]/g;
  let m;
  while ((m = re.exec(base))) brackets.push(m[1]);
  for (const id of brackets) {
    if (idSet.has(id)) return id;
  }
  for (const id of brackets) {
    if (/^[A-Za-z0-9_-]{10,16}$/.test(id)) return id;
  }
  for (const id of idSet) {
    if (id && base.indexOf(id) >= 0) return id;
  }
  return "";
}

function qualityFromName(filename, id) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  if (id) {
    const after = base.split(id).pop() || "";
    const m = after.match(/^\]_\[([^\]]+)\]/);
    if (m && m[1]) return m[1];
  }
  const m2 = base.match(/_\[(Source|source|\d{2,4}p?)\]$/);
  return m2 ? m2[1] : "";
}

function expectedName(id, entry, c, filename) {
  const e = entry || {};
  const name = downloader.applyFileNameTemplate(c.fileNameTemplate || "", {
    title: e.title || "",
    alias: e.name || "",
    id,
    author: e.username || "",
    quality: e.quality || qualityFromName(filename, id),
    uploadTime: e.createdAt || ""
  });
  return name.replace(/_\[\]/g, "");
}

function scanPlan() {
  const c = cfg.readConfig();
  const root = c.downloadPath;
  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: "请先在设置中配置下载路径" };
  }
  const listed = videoIndex.listCatalog(root) || {};
  const map = listed.videos || {};
  const idSet = new Set(Object.keys(map));
  const files = [];
  walkVideos(root, files, 0);
  const plan = [];
  const skipped = [];
  for (const from of files) {
    const base = path.basename(from);
    const id = extractId(base, idSet);
    if (!id) {
      skipped.push({ from, reason: "文件名不含已知 id" });
      continue;
    }
    const entry = map[id] || videoIndex.readEntry(id) || {};
    // 索引没有标题时，用旧文件名里 id 前面一段当 TITLE、后面当 AUTHOR（旧格式 title[id]author.mp4）
    let title = entry.title || "";
    let author = entry.username || "";
    let alias = entry.name || "";
    if (!title) {
      const i = base.indexOf(id);
      const before = i >= 0 ? base.slice(0, i) : base;
      const after = i >= 0 ? base.slice(i + id.length) : "";
      title = before.replace(/^Iwara_-_/i, "").replace(/[_\[\-\s]+$/g, "").trim();
      if (!author) author = after.replace(/^[\]_\-\s]+/g, "").replace(/\.[^.]+$/, "").trim();
    }
    if (!title) {
      skipped.push({ from, id, reason: "没有标题，无法套模板" });
      continue;
    }
    const destName = expectedName(id, { title, name: alias || author, username: author, quality: entry.quality, createdAt: entry.createdAt }, c, base);
    const authorDir = c.useAuthorSubdir ? downloader.sanitizeFileName(entry.username || "unknown") : "";
    const to = authorDir ? path.join(root, authorDir, destName) : path.join(path.dirname(from), destName);
    if (path.resolve(from) === path.resolve(to)) continue;
    let exists = false;
    try { exists = fs.existsSync(to); } catch (_) { exists = false; }
    plan.push({
      id,
      from,
      to,
      fromName: path.relative(root, from) || base,
      toName: path.relative(root, to) || destName,
      exists
    });
  }
  return { ok: true, root, template: c.fileNameTemplate || "", count: plan.length, skipped: skipped.length, plan, skippedSample: skipped.slice(0, 20) };
}

function executePlan(dryRun) {
  const scanned = scanPlan();
  if (!scanned.ok) return scanned;
  if (dryRun !== false) {
    return Object.assign({ dryRun: true }, scanned);
  }
  const renamed = [];
  const failed = [];
  for (const row of scanned.plan) {
    if (row.exists) {
      failed.push({ from: row.fromName, to: row.toName, error: "目标已存在" });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(row.to), { recursive: true });
      fs.renameSync(row.from, row.to);
      renamed.push({ from: row.fromName, to: row.toName, id: row.id });
    } catch (e) {
      failed.push({ from: row.fromName, to: row.toName, error: String(e.message || e) });
    }
  }
  return {
    ok: true,
    dryRun: false,
    renamed: renamed.length,
    failed: failed.length,
    items: renamed,
    errors: failed
  };
}

module.exports = { scanPlan, executePlan };
