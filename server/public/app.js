// ============================================================
// iwara-downloader-server 前端（骨架来自 gbmd docs/ui-template，接本项目 API）
// ============================================================
"use strict";

const $ = (sel) => document.querySelector(sel);

let settings = null;
let searchResults = [];
let taskPollTimer = null;
let searchPollTimer = null;
const lastBytes = new Map(); // id -> { t, bytes } 用于算速度

async function api(path, method = "GET", body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = "/login.html"; throw new Error("未登录"); }
  return r.json();
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(el, msg, type) {
  if (!el) return;
  el.textContent = msg;
  el.className = type && type !== "status" ? "status " + type : "status";
}

function fmtSize(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + u[i];
}

function fmtSpeed(s) {
  if (!s || s <= 0) return "";
  return s >= 1048576 ? (s / 1048576).toFixed(2) + " MB/s" : Math.round(s / 1024) + " KB/s";
}

function parseVideoIds(text) {
  return String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/(?:video|v)\/([\w-]+)/i);
      return m ? m[1] : s.replace(/^https?:\/\/[^/]+\//, "").split("?")[0].trim();
    })
    .filter((s) => /^[\w-]+$/.test(s));
}

function showFeedback(msg, type) {
  let el = $("#feedbackToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "feedbackToast";
    el.style.cssText = "position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 20px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = type === "ok" ? "#1e7d32" : "#c62828";
  el.style.color = "#fff";
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, 2500);
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("#panel-" + tab.dataset.tab).classList.add("active");
      try { history.replaceState(null, "", "#" + tab.dataset.tab); } catch (_) {}
    });
  });
  window.addEventListener("hashchange", () => {
    const name = location.hash.replace(/^#/, "");
    if (name && document.querySelector(`.tab[data-tab="${name}"]`)) switchTab(name);
  });
  const initial = location.hash.replace(/^#/, "");
  if (initial && document.querySelector(`.tab[data-tab="${initial}"]`)) switchTab(initial);
}

function switchTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

function bindBatch() {
  $("#batchBtn").addEventListener("click", async () => {
    const ids = parseVideoIds($("#batchInput").value);
    if (!ids.length) { setStatus($("#batchStatus"), "请输入链接或 ID", "err"); return; }
    $("#batchBtn").disabled = true;
    setStatus($("#batchStatus"), "启动中…");
    try {
      const items = ids.map((id) => ({ id }));
      const r = await api("/api/download", "POST", { items });
      if (!r.ok) throw new Error(r.error || "启动失败");
      setStatus($("#batchStatus"), "已启动后台下载（" + ids.length + " 个），进度见「下载进度」", "ok");
      switchTab("progress");
    } catch (e) {
      setStatus($("#batchStatus"), "失败：" + e.message, "err");
    }
    $("#batchBtn").disabled = false;
  });
  $("#clearBtn").addEventListener("click", () => {
    $("#batchInput").value = "";
    setStatus($("#batchStatus"), "");
  });
}

function bindProgress() {
  $("#pauseBtn").addEventListener("click", () => api("/api/task/pause", "POST", {}));
  $("#resumeBtn").addEventListener("click", () => api("/api/task/resume", "POST", {}));
  $("#stopBtn").addEventListener("click", () => api("/api/task/stop", "POST", {}));
  $("#retryBtn").addEventListener("click", async () => {
    const r = await api("/api/task/retry", "POST", {});
    if (r && r.ok) showFeedback("已重试失败项", "ok");
    else showFeedback((r && r.error) || "重试失败", "err");
  });
  $("#concurrencyBtn").addEventListener("click", async () => {
    const n = parseInt($("#concurrencyInput").value, 10);
    const r = await api("/api/task/concurrency", "POST", { n });
    if (r && r.ok) setStatus($("#concurrencyStatus"), "已设为 " + r.concurrency, "ok");
    else setStatus($("#concurrencyStatus"), (r && r.error) || "失败", "err");
  });
  startTaskPoll();
}

function startTaskPoll() {
  if (taskPollTimer) clearInterval(taskPollTimer);
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await api("/api/task");
      renderTask(r.task);
    } catch (_) {}
    finally { inFlight = false; }
  };
  tick();
  taskPollTimer = setInterval(tick, 1500);
}

function renderTask(task) {
  const stateText = { running: "下载中", idle: "空闲", paused: "已暂停" };
  $("#taskState").textContent = task ? (stateText[task.status] || task.status) : "无任务";
  if (!task || !(task.items || []).length) {
    $("#progressFill").style.width = "0%";
    $("#taskMeta").textContent = "尚未开始下载";
    $("#activeList").innerHTML = "";
    $("#taskList").innerHTML = '<div class="empty">暂无任务</div>';
    $("#pauseBtn").disabled = true;
    $("#resumeBtn").disabled = true;
    $("#stopBtn").disabled = true;
    $("#retryBtn").disabled = true;
    return;
  }
  const items = task.items || [];
  const doneN = items.filter((it) => it.state === "done" || it.state === "skipped" || it.state === "submitted").length;
  const failN = items.filter((it) => it.state === "failed" || it.state === "error").length;
  const runN = items.filter((it) => it.state === "downloading").length;
  const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;
  $("#progressFill").style.width = pct + "%";
  $("#taskMeta").textContent = "完成 " + doneN + " / " + items.length + "，失败 " + failN + (task.backend ? " · 后端 " + task.backend : "");
  $("#pauseBtn").disabled = task.status !== "running";
  $("#resumeBtn").disabled = task.status !== "paused";
  $("#stopBtn").disabled = task.status === "idle";
  $("#retryBtn").disabled = failN === 0;

  const now = Date.now();
  const activeHtml = [];
  const listHtml = [];
  for (const it of items) {
    const bytes = it.doneBytes || 0;
    let speedStr = "";
    if (it.state === "downloading") {
      const prev = lastBytes.get(it.id);
      if (prev && now > prev.t) {
        const sp = (bytes - prev.bytes) / ((now - prev.t) / 1000);
        speedStr = fmtSpeed(sp);
      }
      lastBytes.set(it.id, { t: now, bytes });
    }
    const icon = it.state === "done" || it.state === "skipped" || it.state === "submitted" ? "✅"
      : (it.state === "failed" || it.state === "error" ? "❌" : (it.state === "downloading" ? "⬇" : "•"));
    const cls = it.state === "failed" || it.state === "error" ? "fail" : (it.state === "downloading" ? "" : "ok");
    const barCls = it.state === "failed" || it.state === "error" ? "row-bar-fail"
      : (it.state === "downloading" ? "row-bar-active"
        : (it.state === "done" || it.state === "skipped" || it.state === "submitted" ? "row-bar-ok" : "row-bar-pending"));
    const p = Math.max(0, Math.min(100, it.progress || 0));
    const meta = [it.author, it.file, speedStr, it.error].filter(Boolean).join(" · ");
    const row = `<div class="item ${cls}">
      <span class="icon">${icon}</span>
      <span class="item-name">${esc(it.title || it.id)}
        <span class="row-bar ${barCls}"><span class="row-bar-fill" style="width:${p}%"></span></span>
      </span>
      <span class="status-text">${esc(it.state || "")} ${p}% ${esc(speedStr)} ${fmtSize(it.doneBytes)}${it.total ? " / " + fmtSize(it.total) : ""}<br>${esc(meta)}</span>
    </div>`;
    listHtml.push(row);
    if (it.state === "downloading") activeHtml.push(row);
  }
  $("#activeList").innerHTML = activeHtml.join("");
  $("#taskList").innerHTML = listHtml.join("") || '<div class="empty">暂无任务</div>';
}

function videoId(v) {
  return String((v && (v.id || v.modId)) || "");
}

function videoNsfw(v) {
  if (!v) return false;
  if (v.isNsfw != null) return !!v.isNsfw;
  const r = String(v.rating || "").toLowerCase();
  return r === "ecchi" || r === "erotica" || r === "nsfw" || r === "explicit";
}

function videoAuthor(v) {
  const u = (v && v.user) || {};
  return u.name || u.username || v.author || "";
}

function localDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function applyRatingFilter(list) {
  const wantNormal = $("#filterNormal") ? $("#filterNormal").checked : true;
  const wantNsfw = $("#filterNsfw") ? $("#filterNsfw").checked : true;
  if (wantNormal && wantNsfw) return list;
  return list.filter((it) => (videoNsfw(it) ? wantNsfw : wantNormal));
}

function bindSearch() {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 86400000);
  if ($("#searchEnd")) $("#searchEnd").value = localDate(now);
  if ($("#searchStart")) $("#searchStart").value = localDate(d30);

  $("#earliestBtn").addEventListener("click", () => {
    $("#searchStart").value = "2000-01-01";
    setStatus($("#searchStatus"), "开始日期已设为最早（2000-01-01）");
  });

  $("#kwSearchBtn").addEventListener("click", runSearch);
  $("#kwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

  $("#searchBtn").addEventListener("click", async () => {
    const startDate = $("#searchStart").value;
    const endDate = $("#searchEnd").value;
    if (!startDate || !endDate) { setStatus($("#searchStatus"), "请选择日期范围", "err"); return; }
    const contentFilter = [];
    if ($("#filterNormal").checked) contentFilter.push("normal");
    if ($("#filterNsfw").checked) contentFilter.push("nsfw");
    if (!contentFilter.length) { setStatus($("#searchStatus"), "请至少选择一个内容分级", "err"); return; }
    $("#searchBtn").disabled = true;
    setStatus($("#searchStatus"), "启动搜索…");
    try {
      try { await api("/api/search/stop", "POST", {}); } catch (_) {}
      searchResults = [];
      renderSearchResults();
      const r = await api("/api/search", "POST", {
        startDate, endDate, contentFilter,
        user: $("#searchUser").value.trim(),
        search: $("#kwInput").value.trim()
      });
      if (!r.ok) throw new Error(r.error || "启动失败");
      setStatus($("#searchStatus"), "搜索中…（后台运行，可切换标签）");
      $("#stopSearchBtn").style.display = "inline-block";
      startSearchPoll();
    } catch (e) {
      setStatus($("#searchStatus"), "搜索失败：" + e.message, "err");
      $("#searchBtn").disabled = false;
    }
  });

  $("#stopSearchBtn").addEventListener("click", async () => {
    await api("/api/search/stop", "POST", {});
    $("#stopSearchBtn").style.display = "none";
    $("#searchBtn").disabled = false;
    setStatus($("#searchStatus"), "已停止搜索（保留已找到的结果）");
  });

  $("#clearSearchBtn").addEventListener("click", async () => {
    searchResults = [];
    renderSearchResults();
    await api("/api/search/clear", "POST", {});
    setStatus($("#searchStatus"), "列表已清空");
  });

  $("#exportSearchBtn").addEventListener("click", async () => {
    try {
      const r = await fetch("/api/search/export", { credentials: "same-origin" });
      if (r.status === 401) { location.href = "/login.html"; return; }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "iwara-search-records-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus($("#searchStatus"), "已导出搜索记录 JSON", "ok");
    } catch (e) {
      setStatus($("#searchStatus"), "导出失败: " + e.message, "err");
    }
  });

  $("#importSearchBtn").addEventListener("click", () => { $("#importSearchFile").click(); });
  $("#importSearchFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    setStatus($("#searchStatus"), "正在导入 " + file.name + " …");
    try {
      const text = await file.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      let records = null;
      if (Array.isArray(json)) records = json;
      else if (json && Array.isArray(json.results)) records = json.results;
      else if (json && Array.isArray(json.records)) records = json.records;
      if (!records) { setStatus($("#searchStatus"), "导入失败: 文件里找不到记录数组（需为 JSON 数组或 {results:[...]}）", "err"); ev.target.value = ""; return; }
      const r = await api("/api/search/import", "POST", { records });
      if (!r.ok) throw new Error(r.error || "导入失败");
      const c = await api("/api/search/cache");
      if (c.cache && c.cache.results) { searchResults = c.cache.results; renderSearchResults(); }
      setStatus($("#searchStatus"), "导入完成：新增 " + r.added + " 条，覆盖 " + r.replaced + " 条，当前共 " + r.total + " 条", "ok");
    } catch (e) {
      setStatus($("#searchStatus"), "导入失败: " + e.message, "err");
    } finally {
      ev.target.value = "";
    }
  });

  $("#selectAllBtn").addEventListener("click", () => {
    const wantNormal = $("#filterNormal").checked;
    const wantNsfw = $("#filterNsfw").checked;
    document.querySelectorAll("#searchResultList input[type=checkbox]").forEach((cb) => {
      const id = cb.dataset.id;
      const it = searchResults.find((x) => videoId(x) === id);
      cb.checked = !!it && (videoNsfw(it) ? wantNsfw : wantNormal);
    });
  });
  $("#selectNoneBtn").addEventListener("click", () => {
    document.querySelectorAll("#searchResultList input[type=checkbox]").forEach((c) => { c.checked = false; });
  });

  $("#saveSearchBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/search/save", "POST", { results: searchResults });
      if (!r.ok) throw new Error(r.error || "保存失败");
      setStatus($("#searchStatus"), "已保存 " + r.total + " 条到 search_cache.json", "ok");
    } catch (e) {
      setStatus($("#searchStatus"), "保存失败: " + e.message, "err");
    }
  });

  $("#downloadSelectedBtn").addEventListener("click", async () => {
    const ids = [...document.querySelectorAll("#searchResultList input[type=checkbox]:checked")].map((c) => c.dataset.id);
    if (!ids.length) { showFeedback("请先勾选", "err"); return; }
    const items = ids.map((id) => {
      const v = searchResults.find((x) => videoId(x) === id) || { id };
      return { id, title: v.title || v.name || "", author: videoAuthor(v) };
    });
    try {
      const r = await api("/api/download", "POST", { items });
      if (!r.ok) throw new Error(r.error || "启动失败");
      showFeedback("已加入下载（" + items.length + "）", "ok");
      switchTab("progress");
    } catch (e) {
      showFeedback(e.message, "err");
    }
  });
}

function startSearchPoll() {
  if (searchPollTimer) clearInterval(searchPollTimer);
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await api("/api/search-status");
      const t = r.task;
      if (!t) return;
      searchResults = t.results || [];
      renderSearchResults();
      setStatus($("#searchStatus"), t.message || t.status || "");
      if (t.status !== "running") {
        $("#stopSearchBtn").style.display = "none";
        $("#searchBtn").disabled = false;
        if (searchPollTimer) { clearInterval(searchPollTimer); searchPollTimer = null; }
      }
    } catch (_) {}
    finally { inFlight = false; }
  };
  tick();
  searchPollTimer = setInterval(tick, 1500);
}

async function runSearch() {
  const kw = $("#kwInput").value.trim();
  const sort = $("#searchSort").value;
  const user = $("#searchUser").value.trim();
  setStatus($("#kwStatus"), "搜索中…");
  $("#kwSearchBtn").disabled = true;
  try {
    const qs = new URLSearchParams({ sort, page: "0", limit: "48" });
    if (kw) qs.set("search", kw);
    if (user) qs.set("user", user);
    const wantNormal = $("#filterNormal").checked;
    const wantNsfw = $("#filterNsfw").checked;
    if (wantNormal && !wantNsfw) qs.set("rating", "general");
    else if (!wantNormal && wantNsfw) qs.set("rating", "ecchi");
    const r = await api("/api/videos?" + qs.toString());
    if (!r.ok) throw new Error(r.error || "搜索失败");
    searchResults = applyRatingFilter(r.results || []);
    renderSearchResults();
    setStatus($("#kwStatus"), "完成（" + searchResults.length + " 条）", "ok");
  } catch (e) {
    setStatus($("#kwStatus"), "失败：" + e.message, "err");
  }
  $("#kwSearchBtn").disabled = false;
}

function renderSearchResults() {
  const box = $("#searchResultList");
  const shown = applyRatingFilter(searchResults);
  $("#resultCount").textContent = shown.length ? ("共 " + shown.length + " 条") : "";
  if (!shown.length) { box.innerHTML = '<div class="empty">无结果</div>'; return; }
  box.innerHTML = shown.map((v) => {
    const author = videoAuthor(v);
    const when = v.createdAt ? new Date(v.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
    const tag = videoNsfw(v) ? '<span class="badge nsfw">R18</span>' : '<span class="badge normal">普通</span>';
    return `<div class="result-item">
      <input type="checkbox" data-id="${esc(videoId(v))}">
      <div class="name"><b>${esc(v.title || v.name || v.id)}</b> ${tag}
        <div class="meta">${esc(author)} · ${esc(videoId(v))} · ${esc(when)}</div>
      </div>
    </div>`;
  }).join("");
}

function bindTheme() {
  const btn = $("#themeBtn");
  const apply = (th) => {
    if (th === "night") document.documentElement.setAttribute("data-theme", "night");
    else document.documentElement.removeAttribute("data-theme");
    btn.textContent = th === "night" ? "☀ 白天" : "🌙 夜间";
  };
  let th = "day";
  try { th = localStorage.getItem("gbmd-theme") || "day"; } catch (_) {}
  apply(th);
  btn.addEventListener("click", () => {
    th = th === "night" ? "day" : "night";
    try { localStorage.setItem("gbmd-theme", th); } catch (_) {}
    apply(th);
  });
}

function bindLogout() {
  $("#logoutBtn").addEventListener("click", async () => {
    try { await api("/api/logout", "POST", {}); } catch (_) {}
    location.href = "/login.html";
  });
}

function fillSettings(s) {
  settings = s || {};
  $("#set-downloadPath").value = settings.downloadPath || "";
  $("#set-fileNameTemplate").value = settings.fileNameTemplate || "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}].mp4";
  $("#set-useAuthorSubdir").value = settings.useAuthorSubdir ? "true" : "false";
  $("#set-downloadBackend").value = settings.downloadBackend || "direct";
  $("#set-concurrency").value = settings.concurrency || 3;
  $("#concurrencyInput").value = settings.concurrency || 3;
  $("#set-aria2Path").value = settings.aria2Path || "";
  $("#set-aria2Token").value = settings.aria2Token || "";
  $("#set-iwaraCookie").value = settings.iwaraCookie || "";
}

function bindSettings() {
  $("#saveSettingsBtn").addEventListener("click", async () => {
    setStatus($("#settingsStatus"), "保存中…");
    try {
      const body = {
        downloadPath: $("#set-downloadPath").value.trim(),
        fileNameTemplate: $("#set-fileNameTemplate").value.trim(),
        useAuthorSubdir: $("#set-useAuthorSubdir").value === "true",
        downloadBackend: $("#set-downloadBackend").value,
        concurrency: parseInt($("#set-concurrency").value, 10) || 3,
        aria2Path: $("#set-aria2Path").value.trim(),
        aria2Token: $("#set-aria2Token").value,
        iwaraCookie: $("#set-iwaraCookie").value
      };
      const r = await api("/api/settings", "POST", body);
      if (!r.ok) throw new Error(r.error || "保存失败");
      fillSettings(r.settings);
      setStatus($("#settingsStatus"), "已保存", "ok");
    } catch (e) {
      setStatus($("#settingsStatus"), e.message, "err");
    }
  });
  $("#changePwdBtn").addEventListener("click", async () => {
    const pwd = $("#newPwd").value;
    if (!pwd || pwd.length < 4) { setStatus($("#pwdStatus"), "密码至少 4 位", "err"); return; }
    try {
      const r = await api("/api/change-password", "POST", { password: pwd });
      if (!r.ok) throw new Error(r.error || "失败");
      setStatus($("#pwdStatus"), "已修改", "ok");
      $("#newPwd").value = "";
    } catch (e) {
      setStatus($("#pwdStatus"), e.message, "err");
    }
  });
  $("#gbLoginCheckBtn").addEventListener("click", async () => {
    const el = $("#gbLoginStatus");
    el.textContent = "检测中…";
    try {
      const r = await api("/api/iwara-check");
      if (!r.cookieSet) { el.textContent = "尚未配置 Cookie"; el.className = "status err"; return; }
      el.textContent = r.loggedIn ? ("已登录：" + (r.user || "")) : ((r.error || "未登录") + (r.cfChallenge ? "（需含 cf_clearance）" : ""));
      el.className = "status " + (r.loggedIn ? "ok" : "err");
    } catch (e) {
      el.textContent = e.message;
      el.className = "status err";
    }
  });

  $("#exportDataBtn").addEventListener("click", async () => {
    const st = $("#dataStatus");
    setStatus(st, "正在导出…");
    try {
      const r = await fetch("/api/data/export", { credentials: "same-origin" });
      if (r.status === 401) { location.href = "/login.html"; return; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "导出失败"); }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "iwara-userdata-" + new Date().toISOString().slice(0, 10) + ".zip";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(st, "已导出用户数据 zip（含全部清单文件）", "ok");
    } catch (e) {
      setStatus(st, "导出失败: " + (e && e.message || e), "err");
    }
  });
  $("#importDataBtn").addEventListener("click", () => { $("#importDataFile").click(); });
  $("#importDataFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    const st = $("#dataStatus");
    if (!file) return;
    setStatus(st, "正在导入 " + file.name + " …");
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      if (!b64) throw new Error("读取文件失败");
      const r = await api("/api/data/import", "POST", { data: b64 });
      if (!r.ok) throw new Error(r.error || "导入失败");
      setStatus(st, "导入完成：恢复 " + r.restored.length + " 个文件，跳过 " + r.skipped.length + " 个" + (r.note ? "。" + r.note : ""), "ok");
    } catch (e) {
      setStatus(st, "导入失败: " + (e && e.message || e), "err");
    } finally {
      ev.target.value = "";
    }
  });
}

function tickClock() {
  const el = $("#serverTime");
  if (!el) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  el.textContent = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

async function init() {
  bindTabs();
  bindTheme();
  bindBatch();
  bindProgress();
  bindSearch();
  bindSettings();
  bindLogout();
  tickClock();
  setInterval(tickClock, 1000);
  try {
    const st = await api("/api/status");
    const w = $("#noPwdWarn");
    if (w && st.needsSetup) w.style.display = "block";
  } catch (_) {}
  try {
    const s = await api("/api/settings");
    if (s.ok) fillSettings(s.settings);
  } catch (_) {}
  try {
    const c = await api("/api/search/cache");
    if (c.cache && Array.isArray(c.cache.results) && c.cache.results.length) {
      searchResults = c.cache.results;
      renderSearchResults();
    }
  } catch (_) {}
  try {
    const st = await api("/api/search-status");
    if (st.task && st.task.status === "running") {
      searchResults = st.task.results || searchResults;
      renderSearchResults();
      $("#stopSearchBtn").style.display = "inline-block";
      $("#searchBtn").disabled = true;
      startSearchPoll();
    }
  } catch (_) {}
}

init();
