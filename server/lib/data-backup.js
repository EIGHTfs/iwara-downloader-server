// ============================================================
// data-backup.js —— 用户数据备份/恢复（对照 gbmd）
//   导出：按 userdata-manifest.json 收集全部用户数据 → zip
//   导入：上传 zip → 按清单白名单校验路径 → 解压写回
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const APP_ROOT = path.join(__dirname, "..", "..");
const MANIFEST_FILE = path.join(APP_ROOT, "userdata-manifest.json");

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

function readManifest() {
  const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  if (m.schema !== 1) throw new Error("不支持的清单版本 schema=" + m.schema);
  return m;
}

function collectFiles() {
  const m = readManifest();
  const files = [];
  for (const f of m.files || []) {
    const abs = path.join(APP_ROOT, f.rel);
    if (fs.existsSync(abs)) files.push(f.rel);
  }
  for (const d of m.dirs || []) {
    const dirAbs = path.join(APP_ROOT, d.rel);
    if (!fs.existsSync(dirAbs)) continue;
    for (const n of fs.readdirSync(dirAbs)) {
      if (d.suffix && !n.endsWith(d.suffix)) continue;
      const abs = path.join(dirAbs, n);
      if (fs.statSync(abs).isFile()) files.push(d.rel + "/" + n);
    }
  }
  files.sort();
  return files;
}

function exportZip() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iwara-backup-"));
  const zipPath = path.join(tmpDir, "iwara-userdata.zip");
  const files = collectFiles();
  fs.copyFileSync(MANIFEST_FILE, path.join(tmpDir, "userdata-manifest.json"));
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
      if (rel.startsWith(prefix) && rel.endsWith(suffix)) return true;
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
    note: "导入完成。config / 下载任务如服务运行中，部分文件需重启服务后完全生效（./restart.sh）"
  };
}

module.exports = { readManifest, collectFiles, exportZip, importZip };
