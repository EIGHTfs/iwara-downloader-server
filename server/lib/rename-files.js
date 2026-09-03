// 按当前文件名模板批量重命名已下载视频
// 用户原话：「iwara 设置增加重命名文件功能类似 gbmd 的合并文件夹，将含 id 的视频但不是模板命名格式的扫描出来先预览，然后批量重命名」
// 用户原话：「(1) 为什么没被扫描到，这不规范」——模板名后面多「 (1)」也算不规范，必须进预览。
// 用户原话：「是不是意外实现去重了」——Linux rename 覆盖已有目标会丢文件；执行时目标已存在一律跳过。
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
    if (name === ".trash" || name === "node_modules" || name === ".git" || name === "@eaDir") continue;
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
  // 用户原话：「你妈的说id就只根据json文件」
  // 【错法】用方括号长度/形态猜 id，[Genshin_Impact] 被当成视频 id，(1) 副本扫不到。
  // 【改法】只认 json/index 总表里的 id；文件名方括号内容必须能在 idSet 里命中。
  const base = String(filename || "").replace(/\.[^.]+$/, "").replace(/ \(\d+\)$/, "");
  const brackets = [];
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(base))) brackets.push(m[1]);
  for (const id of brackets) {
    if (idSet.has(id)) return id;
  }
  for (const id of idSet) {
    if (id && base.indexOf("[" + id + "]") >= 0) return id;
  }
  return "";
}

function qualityFromName(filename, id) {
  const base = String(filename || "").replace(/\.[^.]+$/, "").replace(/ \(\d+\)$/, "");
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
    let title = entry.title || "";
    let author = entry.username || "";
    let alias = entry.name || "";
    if (!title) {
      const stem = base.replace(/\.[^.]+$/, "").replace(/ \(\d+\)$/, "");
      const ii = stem.indexOf(id);
      const before = ii >= 0 ? stem.slice(0, ii) : stem;
      const after = ii >= 0 ? stem.slice(ii + id.length) : "";
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
      exists,
      copySuffix: / \(\d+\)\.[^.]+$/.test(base)
    });
  }
  const byTo = new Map();
  for (const row of plan) {
    const k = path.resolve(row.to);
    if (!byTo.has(k)) byTo.set(k, []);
    byTo.get(k).push(row.fromName);
  }
  const collisions = [];
  for (const [to, froms] of byTo) {
    if (froms.length < 2) continue;
    collisions.push({ to: path.relative(root, to) || to, n: froms.length, from: froms });
  }
  return {
    ok: true,
    root,
    template: c.fileNameTemplate || "",
    videoCount: files.length,
    indexCount: idSet.size,
    count: plan.length,
    skipped: skipped.length,
    plan,
    skippedSample: skipped.slice(0, 20),
    collisions,
    collisionCount: collisions.length,
    wouldLoseIfOverwrite: collisions.reduce((n, c) => n + c.n - 1, 0)
  };
}

function underRoot(root, full) {
  const a = path.resolve(root);
  const b = path.resolve(full);
  return b === a || b.startsWith(a + path.sep);
}

function executePlan(dryRun, opts) {
  const scanned = scanPlan();
  if (!scanned.ok) return scanned;
  if (dryRun !== false) {
    return Object.assign({ dryRun: true }, scanned);
  }
  opts = opts || {};
  const forceName = String(opts.forceFrom || "").trim();
  // 用户原话：「目标已存在时点确认执行，给失败的任务单个加个强制执行，专门用于覆盖重复」
  // 批量默认不覆盖；forceFrom 只改这一条，允许覆盖已有目标。
  const rows = forceName
    ? scanned.plan.filter((row) => row.fromName === forceName)
    : scanned.plan;
  if (forceName && !rows.length) {
    return { ok: false, error: "没有这条待改名文件（先预览，或 id 不在 json）" };
  }
  const renamed = [];
  const failed = [];
  const taken = new Set();
  for (const row of rows) {
    if (!underRoot(scanned.root, row.from) || !underRoot(scanned.root, row.to)) {
      failed.push({ from: row.fromName, to: row.toName, error: "路径超出下载目录", canForce: false });
      continue;
    }
    const dest = path.resolve(row.to);
    let destExists = false;
    try { destExists = fs.existsSync(row.to); } catch (_) { destExists = false; }
    const force = !!forceName;
    if (!force && (destExists || taken.has(dest))) {
      failed.push({ from: row.fromName, to: row.toName, error: "目标已存在", canForce: true });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(row.to), { recursive: true });
      fs.renameSync(row.from, row.to);
      taken.add(dest);
      renamed.push({ from: row.fromName, to: row.toName, id: row.id, forced: force });
    } catch (e) {
      failed.push({ from: row.fromName, to: row.toName, error: String(e.message || e), canForce: destExists });
    }
  }
  const after = scanPlan();
  return {
    ok: true,
    dryRun: false,
    renamed: renamed.length,
    failed: failed.length,
    items: renamed,
    errors: failed,
    videoCountBefore: scanned.videoCount,
    videoCountAfter: after.videoCount
  };
}

module.exports = { scanPlan, executePlan, extractId };
