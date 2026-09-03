// ============================================================
// data-backup.js —— 用户数据备份/恢复
//   导出：扫源码 //userdata-manifest.json 注释自动生成清单 → zip
//   导入：上传 zip → 按清单白名单校验路径 → 解压写回
// 用户原话：「两个项目userdata-manifest.json都有问题，没有维护过，希望改成自动维护。
//   方法就是生成读取json文件时代码旁注释//userdata-manifest.json，然后导出配置文件时自动生成userdata-manifest.json」
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const jsonDir = require("./json-dir");
const APP_ROOT = path.join(__dirname, "..", "..");
const APP_NAME = "iwara-downloader-server";
const MANIFEST_FILE = jsonDir.jsonFile("userdata-manifest.json");
const MARKER = "//userdata-manifest.json";

function findTool(name) {
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const e of exts) {
    const local = path.join(APP_ROOT, "tool", "bin", name + e);
    if (fs.existsSync(local)) return local;
  }
  return name;
}
const ZIP_BIN = () => findTool("zip");
const UNZIP_BIN = () => findTool("unzip");

function parseMarker(line) {
  const i = String(line || "").indexOf(MARKER);
  if (i < 0) return null;
  const rest = String(line).slice(i + MARKER.length).trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === "file" && parts[1]) {
    return { kind: "file", rel: parts[1], desc: parts.slice(2).join(" ") };
  }
  if (parts[0] === "dir" && parts[1]) {
    let suffix = "";
    let descParts = parts.slice(2);
    if (descParts[0] && descParts[0].charAt(0) === ".") {
      suffix = descParts[0];
      descParts = descParts.slice(1);
    }
    return { kind: "dir", rel: parts[1], suffix: suffix, desc: descParts.join(" ") };
  }
  return null;
}

function walkJs(dir, hits) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) {
    if (n === "node_modules" || n === "public" || n === "thumbs" || n.charAt(0) === ".") continue;
    const abs = path.join(dir, n);
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    if (st.isDirectory()) { walkJs(abs, hits); continue; }
    if (!/\.(js|cjs)$/.test(n)) continue;
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      const hit = parseMarker(line);
      if (hit) hits.push(hit);
    }
  }
}

function buildManifest() {
  const hits = [];
  walkJs(path.join(APP_ROOT, "server"), hits);
  const files = [];
  const dirs = [];
  const seenF = new Set();
  const seenD = new Set();
  for (const h of hits) {
    if (h.kind === "file") {
      if (!h.rel || seenF.has(h.rel) || h.rel === "json/userdata-manifest.json") continue;
      seenF.add(h.rel);
      files.push({ rel: h.rel, desc: h.desc || "" });
    } else if (h.kind === "dir") {
      const key = h.rel + "\0" + (h.suffix || "");
      if (!h.rel || seenD.has(key)) continue;
      seenD.add(key);
      const d = { rel: h.rel, desc: h.desc || "" };
      if (h.suffix) d.suffix = h.suffix;
      dirs.push(d);
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  dirs.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    schema: 1,
    app: APP_NAME,
    generatedAt: new Date().toISOString(),
    note: "导出时根据源码 //userdata-manifest.json 注释自动生成，不要手改。",
    files: files,
    dirs: dirs
  };
}

function writeManifest(m) {
  jsonDir.ensureJsonDir();
  const tmp = MANIFEST_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, MANIFEST_FILE);
  return m;
}

function generateManifest() {
  return writeManifest(buildManifest());
}

function readManifest() {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
      if (m && m.schema === 1) return m;
    }
  } catch (_) {}
  return generateManifest();
}

function collectFiles(mOpt) {
  const m = mOpt || readManifest();
  const files = [];
  for (const f of m.files || []) {
    const abs = path.join(APP_ROOT, f.rel);
    if (fs.existsSync(abs)) files.push(f.rel);
  }
  for (const d of m.dirs || []) {
    const dirAbs = path.join(APP_ROOT, d.rel);
    if (!fs.existsSync(dirAbs)) continue;
    let names;
    try { names = fs.readdirSync(dirAbs); } catch (_) { continue; }
    for (const n of names) {
      if (d.suffix && !n.endsWith(d.suffix)) continue;
      const abs = path.join(dirAbs, n);
      try {
        if (fs.statSync(abs).isFile()) files.push(d.rel + "/" + n);
      } catch (_) {}
    }
  }
  files.sort();
  return files;
}

function exportZip() {
  const m = generateManifest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iwara-backup-"));
  const zipPath = path.join(tmpDir, "iwara-userdata.zip");
  const files = collectFiles(m);
  fs.writeFileSync(path.join(tmpDir, "userdata-manifest.json"), JSON.stringify(m, null, 2) + "\n", "utf8");
  for (const rel of files) {
    const src = path.join(APP_ROOT, rel);
    const dst = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return new Promise((resolve, reject) => {
    execFile(ZIP_BIN(), ["-r", "-q", zipPath, "userdata-manifest.json"].concat(files), { cwd: tmpDir, maxBuffer: 1024 * 1024 * 512 }, (err) => {
      const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };
      if (err) { cleanup(); return reject(err); }
      try { const buf = fs.readFileSync(zipPath); cleanup(); resolve(buf); }
      catch (e) { cleanup(); reject(e); }
    });
  });
}

function importZip(zipPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iwara-restore-"));
  const outDir = path.join(tmpDir, "out");
  let manifest = null;
  try { manifest = readManifest(); } catch (_) {}
  return new Promise((resolve, reject) => {
    execFile(UNZIP_BIN(), ["-o", "-q", zipPath, "-d", outDir], { maxBuffer: 1024 * 1024 * 512 }, (err) => {
      const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };
      if (err) { cleanup(); return reject(err); }
      try { const r = restoreFromDir(outDir, manifest); cleanup(); resolve(r); }
      catch (e) { cleanup(); reject(e); }
    });
  });
}

function restoreFromDir(outDir, manifest) {
  let m = manifest;
  const zipManifestPath = path.join(outDir, "userdata-manifest.json");
  if (fs.existsSync(zipManifestPath)) {
    try { m = JSON.parse(fs.readFileSync(zipManifestPath, "utf8")); } catch (_) {}
  }
  if (!m || m.schema !== 1) throw new Error("未找到 userdata-manifest.json（无法校验白名单）");
  if (!m.files || !m.dirs) throw new Error("清单格式无效");

  const allowedExact = new Set(m.files.map((f) => f.rel));
  const allowedDirSuffix = (m.dirs || []).map((d) => ({ dir: d.rel, suffix: d.suffix || "" }));
  const isAllowed = (rel) => {
    if (allowedExact.has(rel)) return true;
    for (const { dir, suffix } of allowedDirSuffix) {
      const prefix = dir + "/";
      if (rel.startsWith(prefix) && (!suffix || rel.endsWith(suffix))) return true;
    }
    return false;
  };

  const restored = [];
  const skipped = [];
  const walk = (dir, prefix) => {
    for (const n of fs.readdirSync(dir)) {
      const abs = path.join(dir, n);
      const rel = prefix ? prefix + "/" + n : n;
      if (fs.statSync(abs).isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!isAllowed(rel)) { skipped.push(rel); continue; }
      const dst = path.join(APP_ROOT, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      restored.push(rel);
    }
  };
  walk(outDir, "");

  return {
    ok: true,
    restored,
    skipped,
    note: "导入完成。config / 下载任务如服务运行中，部分文件需重启服务后完全生效"
  };
}

module.exports = { readManifest, collectFiles, exportZip, importZip, generateManifest, buildManifest };
