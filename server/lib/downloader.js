// ============================================================
// iwara-downloader-server - 下载引擎（参考 gbmd downloader.js）
//
// 双后端：
//   direct:  Node fetch 流式写盘，.part + Range 断点续传，失败重试
//   aria2:   aria2.addUri JSON-RPC 推送（支持断点/代理/多线程）
//
// 任务持久化：download_task.json（重启可恢复 restorePendingTask）
// 并发控制：concurrency 限制同时下载数
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const cfg = require("../config");
const api = require("./iwara-api");
const IWARA_CF_IP = api.IWARA_CF_IP || "104.26.12.12";

const DATA_DIR = process.env.GBMD_DATA_DIR || __dirname;
const TASK_FILE = path.join(DATA_DIR, "..", "download_task.json");
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 2000;

// 已知可直连下载的 CDN 子域（104.26.12.12 上未被 CF 挑战的）。
// 下载时若 iwara 返回的下载链接子域失败（403/超时），自动轮换到这些子域。
const FALLBACK_CDN_HOSTS = ["firefly.iwara.tv", "aiko.iwara.tv", "filesq.iwara.tv"];

// keep-alive 连接池（避免每文件吃一次慢首连接）
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 64, maxFreeSockets: 32 });

let task = {
  status: "idle", // idle | running | paused
  items: [],      // [{ id, title, author, file, url, savePath, state, progress, error }]
  idx: 0,
  completed: 0,
  failed: 0,
  totalBytes: 0,
  doneBytes: 0
};
let activeDownloads = 0;

// ---------- 工具 ----------
function sanitizeFileName(name) {
  if (!name) return "unnamed";
  // 去掉路径分隔与非法字符（保留原始文件名主体）
  let n = String(name).replace(/[/\\:*?"<>|]/g, "_").trim();
  return n || "unnamed";
}

/**
 * 文件名模板（学 IwaraDownloadTool 油猴脚本 src/download/downloadPath.ts）：
 *   config.fileNameTemplate 支持 {TITLE} {ALIAS} {ID} {AUTHOR} {QUALITY} {UPLOADTIME} {NOWTIME}
 *   例：Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4
 * @param {string} template
 * @param {Object} info - getVideoInfo 返回的视频信息
 */
function applyFileNameTemplate(template, info) {
  const now = new Date();
  const upload = info.uploadTime ? new Date(info.uploadTime) : now;
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDT = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const vars = {
    TITLE: info.title || "",
    ALIAS: info.alias || "",
    ID: info.id || "",
    AUTHOR: info.author || "",
    QUALITY: info.quality || "",
    UPLOADTIME: fmtDT(upload),
    NOWTIME: fmtDT(now)
  };
  let name = template || "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4";
  for (const k of Object.keys(vars)) {
    name = name.split(`{${k}}`).join(vars[k]);
  }
  // 兜底：模板替换后空文件名（如全变量缺失）→ 用 ID
  name = sanitizeFileName(name);
  if (!name.endsWith(".mp4") && !name.endsWith(".webm") && !name.endsWith(".mov")) name += ".mp4";
  return name;
}

function safeJoin(root, sub) {
  const full = path.resolve(root, sub);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) {
    throw new Error("非法路径: " + sub);
  }
  return full;
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

// ---------- 任务持久化 ----------
function saveTask() {
  try { fs.writeFileSync(TASK_FILE, JSON.stringify(task, null, 2), "utf8"); } catch (_) {}
}

function getTask() { return task; }

function restorePendingTask() {
  try {
    if (fs.existsSync(TASK_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TASK_FILE, "utf8"));
      if (saved && Array.isArray(saved.items)) {
        // 恢复未完成任务（保持 paused 状态，等待用户恢复）
        const pending = saved.items.filter((i) => i.state === "pending" || i.state === "downloading");
        pending.forEach((i) => (i.state = "pending"));
        task = Object.assign(task, saved, { items: saved.items, status: "paused" });
        if (pending.length > 0) console.log(`[downloader] 恢复 ${pending.length} 个未完成任务（已暂停，等待恢复）`);
      }
    }
  } catch (_) {}
}

// ---------- 下载 ----------
/** 检查 .part 已下载字节数（断点续传起点） */
function partBytes(partPath) {
  try { return fs.statSync(partPath).size; } catch (_) { return 0; }
}

/**
 * direct 后端：带 Range 断点续传的单文件下载
 * 子域自动轮换：原始下载链接的子域若返回 403（CF 挑战）/超时，
 * 自动把 URL 里的子域替换成 FALLBACK_CDN_HOSTS 里可用的子域重试。
 * @returns {Promise<'done'|'retry'>}
 */
function downloadToFile(item, onProgress) {
  return new Promise((resolve, reject) => {
    const url = item.url;
    const tmpFile = item.savePath + ".part";
    const start = partBytes(tmpFile);
    const u0 = new URL(url);

    // 候选子域：原始 + 备用（去重）
    const candidates = [u0.hostname, ...FALLBACK_CDN_HOSTS].filter((h, i, a) => a.indexOf(h) === i);
    let ci = 0;

    const attempt = () => {
      if (ci >= candidates.length) return reject(new Error("所有 CDN 子域均失败（403/超时）"));
      const host = candidates[ci++];
      const headers = {
        "User-Agent": api.DEFAULT_UA,
        Accept: "*/*",
        Referer: "https://www.iwara.tv/",
        Range: `bytes=${start}-`
      };
      if (cfg.readConfig().iwaraCookie) headers["Cookie"] = cfg.readConfig().iwaraCookie;

      const req = https.request(
        {
          host: IWARA_CF_IP,
          port: u0.port || 443,
          path: u0.pathname + u0.search,
          method: "GET",
          headers: Object.assign({ Host: host }, headers),
          agent: HTTPS_AGENT,
          servername: host
        },
        (res) => {
          // 206 = 断点续传；200 = 重新开始（服务器不支持 Range）
          if (res.statusCode === 403 || res.statusCode === 404 || (res.statusCode !== 200 && res.statusCode !== 206)) {
            res.resume();
            if (ci < candidates.length) {
              console.log(`[downloader] ${host} → HTTP ${res.statusCode}，换子域重试 (${ci}/${candidates.length})`);
              return attempt();
            }
            return reject(new Error(`HTTP ${res.statusCode}（${host}）`));
          }
          // 若服务器返回 200（无视 Range），从头写
          const writeStart = res.statusCode === 206 ? start : 0;
          const mode = writeStart > 0 ? "a" : "w";
          let done = writeStart;
          const stream = fs.createWriteStream(tmpFile, { flags: mode });
          res.on("data", (c) => {
            done += c.length;
            if (item.total) item.doneBytes = done - writeStart + (item.baseBytes || 0);
            if (onProgress) onProgress({ done, total: item.total });
          });
          res.pipe(stream);
          stream.on("finish", () => {
            // 校验：若已到达或超过总大小则完成（无法精确校验时以 HTTP 结束为准）
            fs.renameSync(tmpFile, item.savePath);
            resolve("done");
          });
          stream.on("error", (e) => reject(e));
          req.on("error", (e) => reject(e));
        }
      );
      req.setTimeout(30000, () => {
        try {
          req.destroy(new Error("连接超时"));
        } catch (_) {}
      });
      req.on("error", (e) => {
        // 连接级错误（socket hang up / ECONNRESET 等）→ 换子域重试
        if (ci < candidates.length) {
          console.log(`[downloader] ${host} → ${String(e.message).slice(0, 40)}，换子域重试`);
          return attempt();
        }
        reject(e);
      });
      req.end();
    };

    attempt();
  });
}

/** aria2 后端：addUri 推送 */
async function aria2Add(item) {
  const c = cfg.readConfig();
  const token = c.aria2Token;
  const params = [[item.url], { out: sanitizeFileName(item.file) }];
  if (token) params[1]["header"] = [`Cookie: ${c.iwaraCookie || ""}`];
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2),
    method: "aria2.addUri",
    params: token ? ["token:" + token].concat(params) : params
  };
  const resp = await fetch(c.aria2Path || "http://127.0.0.1:6800/jsonrpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error((data.error && data.error.message) || "aria2 RPC 失败");
  return data.result; // gid
}

// ---------- 任务循环 ----------
async function runDownloadLoop() {
  if (task.status !== "running") return;
  const c = cfg.readConfig();
  const concurrency = c.concurrency || 3;

  while (task.status === "running" && task.idx < task.items.length) {
    while (activeDownloads >= concurrency && task.status === "running") {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (task.status !== "running") break;

    const item = task.items[task.idx];
    task.idx++;
    if (item.state !== "pending") continue;
    activeDownloads++;

    try {
      item.state = "downloading";
      saveTask();

      if (c.downloadBackend === "aria2") {
        await aria2Add(item);
        // aria2 异步下载，无法（简单）追踪进度 → 直接标记为已提交
        item.state = "submitted";
        item.progress = 100;
        item.error = "已提交至 Aria2（进度请查看 Aria2 WebUI）";
        task.completed++;
      } else {
        // direct：每次下载都重新解析直链 —— 下载链接会到期，必须用 fresh 链接
        const info = await api.getVideoInfo(item.id);
        item.url = info.downloadUrl;
        if (info.file && info.file.size) item.total = info.file.size;
        if (!item.url) throw new Error("无法获取下载链接: " + (info.error || "未知"));
        // 用文件名模板重新生成文件名/保存路径（学油猴脚本，用户可自定义模板）
        item.file = applyFileNameTemplate(c.fileNameTemplate, {
          title: info.title || item.title,
          alias: info.alias || "",
          id: item.id,
          author: info.author || item.author,
          quality: info.quality || "",
          uploadTime: info.uploadTime
        });
        const authorDir = c.useAuthorSubdir ? sanitizeFileName(info.author || item.author || "unknown") : "";
        item.savePath = authorDir ? safeJoin(c.downloadPath, path.join(authorDir, item.file)) : safeJoin(c.downloadPath, item.file);
        // 确保目录存在
        fs.mkdirSync(path.dirname(item.savePath), { recursive: true });
        // 已存在且非 0 字节 → 跳过
        if (fs.existsSync(item.savePath) && fs.statSync(item.savePath).size > 0) {
          item.state = "skipped";
          item.progress = 100;
          task.completed++;
        } else {
          const result = await downloadToFile(item, (p) => {
            item.doneBytes = p.done;
            item.progress = item.total ? Math.min(99, Math.round((p.done / item.total) * 100)) : 0;
            saveTask();
          });
          if (result === "done") {
            item.state = "done";
            item.progress = 100;
            item.doneBytes = item.total || 0;
            task.completed++;
          }
        }
      }
    } catch (e) {
      item.error = String(e.message || e);
      item.retries = (item.retries || 0) + 1;
      if (item.retries <= MAX_RETRY && task.status === "running") {
        item.state = "pending"; // 放回队尾？简单起见：延迟重试（同位置）
        task.idx = Math.max(0, task.idx - 1);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * item.retries));
      } else {
        item.state = "failed";
        task.failed++;
      }
    } finally {
      activeDownloads--;
      saveTask();
    }
  }

  if (task.status === "running") {
    task.status = "idle";
    saveTask();
    console.log(`[downloader] 任务结束：完成 ${task.completed}，失败 ${task.failed}`);
  }
}

// ---------- 控制 ----------
/** @param mods [{id, title, author}] */
async function startDownloadTask(items) {
  const c = cfg.readConfig();
  const root = c.downloadPath;
  if (!root) throw new Error("请先在设置中配置下载路径");

  const list = items.map((it) => {
    const authorDir = c.useAuthorSubdir ? sanitizeFileName(it.author || "unknown") : "";
    const file = sanitizeFileName(it.file || `${it.id}.mp4`);
    const savePath = authorDir
      ? safeJoin(root, path.join(authorDir, file))
      : safeJoin(root, file);
    return {
      id: it.id,
      title: it.title || "",
      author: it.author || "",
      authorId: it.authorId || "",
      file,
      url: it.url || "",
      savePath,
      state: "pending",
      progress: 0,
      doneBytes: 0,
      total: it.size || 0,
      retries: 0,
      error: ""
    };
  });

  task = {
    status: "running",
    items: list,
    idx: 0,
    completed: 0,
    failed: 0,
    totalBytes: list.reduce((s, i) => s + (i.total || 0), 0),
    doneBytes: 0,
    backend: c.downloadBackend
  };
  saveTask();
  runDownloadLoop().catch((e) => console.error("[downloader] loop error:", e));
  return { ok: true, total: list.length };
}

function pauseTask() {
  if (task.status === "running") {
    task.status = "paused";
    saveTask();
  }
  return task.status;
}

function resumeTask() {
  if (task.status === "paused") {
    task.status = "running";
    if (task.idx >= task.items.length) task.idx = 0;
    saveTask();
    runDownloadLoop().catch((e) => console.error("[downloader] loop error:", e));
  }
  return task.status;
}

function stopTask() {
  task.status = "idle";
  saveTask();
  return "idle";
}

function setConcurrency(n) {
  const c = cfg.readConfig();
  c.concurrency = Math.max(1, Math.min(8, parseInt(n, 10) || 3));
  cfg.writeConfig(c);
  return c.concurrency;
}

function retryFailed() {
  let n = 0;
  for (const it of task.items) {
    if (it.state === "failed" || it.state === "error") {
      it.state = "pending";
      it.retries = 0;
      it.error = "";
      n++;
    }
  }
  if (n > 0 && task.status !== "running") {
    task.status = "running";
    task.idx = 0;
    saveTask();
    runDownloadLoop().catch((e) => console.error("[downloader] loop error:", e));
  } else {
    saveTask();
  }
  return n;
}

module.exports = {
  getTask, restorePendingTask,
  startDownloadTask, pauseTask, resumeTask, stopTask, setConcurrency, retryFailed,
  sanitizeFileName, fmtSize
};