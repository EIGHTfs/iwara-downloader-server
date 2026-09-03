// ============================================================
// 搜索记录缓存 + 按时间翻页搜索（对照 gbmd search.js 的 cache/import/export/save）
// Iwara 没有香蕉网那种按游戏翻页接口：关键词走 /search；按时间走 /videos?sort=date 翻页，
// 用 createdAt 过滤日期范围，R18 用 rating 字段（ecchi vs general）筛。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const api = require("./iwara-api");
const thumbCache = require("./thumb-cache.cjs");

const jsonDir = require("./json-dir");
const profileIndex = require("./profile-index");
const QUERY_FILE = jsonDir.migrateRuntimeJson("search_task.json"); //userdata-manifest.json file json/search_task.json 搜索任务状态
const CACHE_FILE = jsonDir.migrateRuntimeJson("search_cache.json"); //userdata-manifest.json file json/search_cache.json 搜索记录缓存

const MAX_PAGES = 80;
const MAX_RESULTS = 2000;
const PAGE_INTERVAL_MS = 2000; // 用户原话：搜索加上 2 秒一页的限制

let queryTask = null;
let queryRunning = false;

function authorOf(v) {
  const u = (v && v.user) || {};
  return String(u.name || u.username || "");
}

function isNsfw(v) {
  if (!v) return false;
  if (v.isNsfw != null) return !!v.isNsfw;
  const r = String(v.rating || "").toLowerCase();
  return r === "ecchi" || r === "erotica" || r === "nsfw" || r === "explicit";
}

function createdMs(v) {
  if (!v) return 0;
  if (v.dateAdded) return Number(v.dateAdded) * 1000 || 0;
  const t = Date.parse(v.createdAt || v.publishedAt || "");
  return Number.isNaN(t) ? 0 : t;
}

function normalizeVideo(v) {
  if (!v) return null;
  const id = String(v.id || v.modId || "").trim();
  if (!id) return null;
  const nsfw = isNsfw(v);
  return {
    id,
    modId: id,
    title: String(v.title || v.name || ""),
    name: String(v.title || v.name || ""),
    author: authorOf(v) || String(v.author || ""),
    user: v.user || { name: v.author || "" },
    createdAt: v.createdAt || v.publishedAt || "",
    dateAdded: v.dateAdded || Math.floor(createdMs(v) / 1000) || 0,
    rating: v.rating || (nsfw ? "ecchi" : "general"),
    isNsfw: nsfw,
    liked: !!v.liked,
    following: !!(v.user && v.user.following),
    authorId: String((v.user && v.user.id) || v.authorId || ""),
    numLikes: Number(v.numLikes) || 0,
    thumbnail: v.thumbnail,
    file: v.file ? { id: v.file.id, name: v.file.name, size: v.file.size } : undefined,
    thumbnailUrl: api.thumbnailUrl(v)
  };
}

function saveQueryTask() {
  try {
    const t = queryTask ? Object.assign({}, queryTask) : null;
    if (t) delete t.abortCtl;
    jsonDir.ensureJsonDir();
    fs.writeFileSync(QUERY_FILE, JSON.stringify(t, null, 2), "utf8");
  } catch (_) {}
}

function saveCache(explicit) {
  try {
    const data = explicit || {
      results: (queryTask && queryTask.results) || [],
      startDate: queryTask ? queryTask.startDate : "",
      endDate: queryTask ? queryTask.endDate : "",
      contentFilter: (queryTask && queryTask.contentFilter) || ["normal", "nsfw"],
      queryTime: Date.now()
    };
    jsonDir.ensureJsonDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
  } catch (_) {}
}

function loadQueryTaskFromDisk() {
  try {
    if (fs.existsSync(QUERY_FILE)) queryTask = JSON.parse(fs.readFileSync(QUERY_FILE, "utf8"));
  } catch (_) {}
  return queryTask;
}

function getQueryTask() { return queryTask; }

function getCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (_) {}
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function inDateRange(v, startTs, endTs) {
  const t = createdMs(v);
  if (!t) return false;
  const sec = Math.floor(t / 1000);
  return sec >= startTs && sec < endTs;
}

function passRating(v, contentFilter) {
  const wantNormal = contentFilter.includes("normal");
  const wantNsfw = contentFilter.includes("nsfw");
  if (wantNormal && wantNsfw) return true;
  return isNsfw(v) ? wantNsfw : wantNormal;
}

async function startSearchTask({ startDate, endDate, contentFilter, startTs, endTs, user }) {
  if (queryRunning && queryTask && queryTask.status === "running") {
    throw new Error("已有搜索任务在进行中");
  }
  queryTask = {
    status: "running",
    page: 0,
    startDate, endDate,
    contentFilter: contentFilter || ["normal", "nsfw"],
    startTs, endTs,
    user: user || "",
    search: "",
    results: [],
    message: "开始按时间搜索…",
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  saveQueryTask();
  runQueryLoop();
  return queryTask;
}

async function runQueryLoop() {
  if (queryRunning) return;
  queryRunning = true;
  try { await doQueryLoop(); }
  finally { queryRunning = false; }
}

async function doQueryLoop() {
  if (!queryTask || queryTask.status !== "running") return;
  const seen = new Set((queryTask.results || []).map((r) => r && r.id).filter(Boolean));
  try {
    while (queryTask.status === "running") {
      const page = queryTask.page;
      queryTask.message = "正在拉取第 " + (page + 1) + " 页…";
      queryTask.updatedAt = Date.now();
      saveQueryTask();

      const wantNormal = queryTask.contentFilter.includes("normal");
      const wantNsfw = queryTask.contentFilter.includes("nsfw");
      const rating = wantNormal && wantNsfw ? "all" : (wantNsfw ? "ecchi" : "general");
      const data = await api.listVideos({
        sort: "date",
        page,
        limit: 48,
        user: queryTask.user || "",
        rating
      });
      const list = (data && data.results) || [];
      if (!list.length) {
        queryTask.status = "done";
        queryTask.message = "搜索完成（无更多结果）";
        break;
      }

      let olderThanStart = 0;
      for (const raw of list) {
        const v = normalizeVideo(raw);
        if (!v) continue;
        const t = createdMs(raw);
        const sec = Math.floor(t / 1000);
        if (sec && sec < queryTask.startTs) { olderThanStart++; continue; }
        if (!inDateRange(raw, queryTask.startTs, queryTask.endTs)) continue;
        if (!passRating(raw, queryTask.contentFilter)) continue;
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        queryTask.results.push(v);
        profileIndex.upsertFromVideo(v);
        // 2026-09-04：搜索时拉官方封面落到 thumbs/<id>.jpg。
        // 用户原话：「搜索时，下载时从官方获取封面并按本地规范保存」
        // 【思路】入队即 enqueue，不阻塞翻页；列表只读本地，封面到了刷新即可显示。
        thumbCache.enqueueOfficialThumb(v.id, v.file && v.file.id, v.thumbnail);
        if (queryTask.results.length >= MAX_RESULTS) break;
      }

      queryTask.message = "已找到 " + queryTask.results.length + " 条（第 " + (page + 1) + " 页）";
      queryTask.updatedAt = Date.now();
      saveQueryTask();
      saveCache();

      const allOlder = olderThanStart === list.length;
      const noMore = data && data.hasNext === false;
      if (allOlder || noMore || list.length < 48 || queryTask.results.length >= MAX_RESULTS || page + 1 >= MAX_PAGES) {
        queryTask.status = "done";
        queryTask.message = queryTask.results.length >= MAX_RESULTS
          ? "已达上限 " + MAX_RESULTS + " 条"
          : "搜索完成，共 " + queryTask.results.length + " 条";
        break;
      }
      queryTask.page = page + 1;
      // 用户原话：「iwara 搜索加上 2 秒一页的限制」
      // 【原代码】await sleep(PAGE_INTERVAL_MS) 且 PAGE_INTERVAL_MS=400
      // 【改为】翻页间隔改到 listVideos 统一 2 秒，这里不再另睡，避免 2+2=4 秒

    }
  } catch (e) {
    queryTask.status = "error";
    queryTask.message = "搜索失败：" + (e.message || e);
  }
  queryTask.updatedAt = Date.now();
  saveQueryTask();
  saveCache();
}

function stopSearch() {
  if (queryTask && queryTask.status === "running") {
    queryTask.status = "done";
    queryTask.message = "已手动停止（保留已找到的结果）";
    queryTask.updatedAt = Date.now();
    saveQueryTask();
    saveCache();
  }
  return { ok: true };
}

function exportCache() {
  return getCache() || { results: [], startDate: "", endDate: "", contentFilter: ["normal", "nsfw"], queryTime: 0 };
}

function importCache(records) {
  if (!Array.isArray(records) || !records.length) {
    return { ok: false, error: "没有有效的搜索记录（需为 JSON 数组）" };
  }
  const norm = [];
  const seen = new Set();
  for (const r of records) {
    const v = normalizeVideo(r);
    if (!v) continue;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    norm.push(v);
    profileIndex.upsertFromVideo(v);
  }
  if (!norm.length) return { ok: false, error: "导入文件中没有带 id 的有效记录" };

  const cache = getCache() || { results: [], startDate: "", endDate: "", contentFilter: ["normal", "nsfw"], queryTime: 0 };
  const existing = (cache.results || []).slice();
  const idxMap = new Map();
  existing.forEach((r, i) => { if (r && (r.id || r.modId)) idxMap.set(String(r.id || r.modId), i); });
  let replaced = 0, added = 0;
  for (const r of norm) {
    const i = idxMap.get(r.id);
    if (i !== undefined) { existing[i] = r; replaced++; }
    else { idxMap.set(r.id, existing.length); existing.push(r); added++; }
  }
  cache.results = existing;
  cache.queryTime = Date.now();
  cache.importedAt = Date.now();
  saveCache(cache);
  thumbCache.prefetchOfficialFromList(existing);
  return { ok: true, added, replaced, total: existing.length };
}

function clearCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch (_) {}
  queryTask = null;
  try { fs.unlinkSync(QUERY_FILE); } catch (_) {}
  return { ok: true };
}

function saveRecords(results) {
  const list = Array.isArray(results) ? results : [];
  const norm = [];
  const seen = new Set();
  for (const r of list) {
    const v = normalizeVideo(r);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    norm.push(v);
    profileIndex.upsertFromVideo(v);
  }
  const cache = getCache() || { results: [], startDate: "", endDate: "", contentFilter: ["normal", "nsfw"], queryTime: 0 };
  cache.results = norm;
  cache.queryTime = Date.now();
  saveCache(cache);
  thumbCache.prefetchOfficialFromList(norm);
  return { ok: true, total: norm.length };
}

function restorePendingQuery() {
  loadQueryTaskFromDisk();
  if (queryTask && queryTask.status === "running") runQueryLoop();
}

module.exports = {
  startSearchTask,
  getQueryTask,
  getCache,
  stopSearch,
  clearCache,
  importCache,
  exportCache,
  saveRecords,
  restorePendingQuery,
  normalizeVideo,
  isNsfw
};
