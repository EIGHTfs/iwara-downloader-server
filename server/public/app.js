// ============================================================
// iwara-downloader-server 前端（骨架来自 gbmd docs/ui-template，接本项目 API）
// ============================================================
"use strict";

const $ = (sel) => document.querySelector(sel);

let settings = null;
let searchResults = [];
let followingLoaded = false;
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

// 2026-09-01 悬浮提示（右下角 toast，自动淡出；保存设置等操作反馈用）
let _toastTimer = null;
function showToast(msg, type) {
  let el = $("#gbmdToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "gbmdToast";
    el.className = "gbmd-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "gbmd-toast " + (type === "err" ? "err" : "ok") + " show";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove("show"); }, 3200);
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
      // 2026-09-01 保存设置悬浮按钮：仅设置页显示
      const fab = $("#saveSettingsFab");
      if (fab) fab.classList.toggle("show", tab.dataset.tab === "settings");
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
  const clearFailBtn = $("#clearFailBtn");
  if (clearFailBtn) {
    clearFailBtn.addEventListener("click", async () => {
      const r = await api("/api/task/clear-failed", "POST", {});
      if (r && r.ok) showFeedback("已清除失败 " + (r.removed || 0) + " 项（文件仍在）", "ok");
      else showFeedback((r && r.error) || "清除失败", "err");
    });
  }
  const clearDoneBtn = $("#clearDoneBtn");
  if (clearDoneBtn) {
    clearDoneBtn.addEventListener("click", async () => {
      const r = await api("/api/task/remove-completed", "POST", {});
      if (r && r.ok) showFeedback("已清除完成 " + (r.removed || 0) + " 项（文件仍在）", "ok");
      else showFeedback((r && r.error) || "清除失败", "err");
    });
  }
  const list = $("#taskList");
  if (list && !list._rmBound) {
    list._rmBound = true;
    list.addEventListener("click", async (ev) => {
      const retryBtn = ev.target && ev.target.closest && ev.target.closest("button.mm-retry-btn");
      if (retryBtn) {
        const id = retryBtn.getAttribute("data-id");
        if (!id) return;
        const r = await api("/api/task/retry", "POST", { id });
        if (r && r.ok) showFeedback("已重试", "ok");
        else showFeedback((r && r.error) || "重试失败", "err");
        return;
      }
      const skipBtn = ev.target && ev.target.closest && ev.target.closest("button.mm-skip-btn");
      if (!skipBtn) return;
      const id = skipBtn.getAttribute("data-id");
      if (!id) return;
      const r = await api("/api/task/remove-item", "POST", { id });
      if (r && r.ok) showFeedback("已跳过（文件仍在）", "ok");
      else showFeedback((r && r.error) || "跳过失败", "err");
    });
  }
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

// function renderTask(task) {
//   const stateText = { running: "下载中", idle: "空闲", paused: "已暂停" };
//   $("#taskState").textContent = task ? (stateText[task.status] || task.status) : "无任务";
//   if (!task || !(task.items || []).length) {
//     $("#progressFill").style.width = "0%";
//     $("#taskMeta").textContent = "尚未开始下载";
//     $("#taskList").innerHTML = '<div class="empty">暂无任务</div>';
//     $("#pauseBtn").disabled = true;
//     $("#resumeBtn").disabled = true;
//     $("#stopBtn").disabled = true;
//     $("#retryBtn").disabled = true;
//     if ($("#clearFailBtn")) $("#clearFailBtn").disabled = true;
//     if ($("#clearDoneBtn")) $("#clearDoneBtn").disabled = true;
//     return;
//   }
//   const items = task.items || [];
//   const doneN = items.filter((it) => it.state === "done" || it.state === "skipped" || it.state === "submitted").length;
//   const failN = items.filter((it) => it.state === "failed" || it.state === "error").length;
//   const runN = items.filter((it) => it.state === "downloading").length;
//   const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;
//   $("#progressFill").style.width = pct + "%";
//   $("#taskMeta").textContent = "完成 " + doneN + " / " + items.length + "，失败 " + failN + (task.backend ? " · 后端 " + task.backend : "");
//   $("#pauseBtn").disabled = task.status !== "running";
//   $("#resumeBtn").disabled = task.status !== "paused";
//   $("#stopBtn").disabled = task.status === "idle";
//   $("#retryBtn").disabled = failN === 0;
//   if ($("#clearFailBtn")) $("#clearFailBtn").disabled = failN === 0;
//   if ($("#clearDoneBtn")) $("#clearDoneBtn").disabled = doneN === 0;
// 
//   const now = Date.now();
//   const listHtml = [];
//   for (const it of items) {
//     const bytes = it.doneBytes || 0;
//     let speedStr = "";
//     if (it.state === "downloading") {
//       const prev = lastBytes.get(it.id);
//       if (prev && now > prev.t) {
//         const sp = (bytes - prev.bytes) / ((now - prev.t) / 1000);
//         speedStr = fmtSpeed(sp);
//       }
//       lastBytes.set(it.id, { t: now, bytes });
//     }
//     const icon = it.state === "done" || it.state === "skipped" || it.state === "submitted" ? "✅"
//       : (it.state === "failed" || it.state === "error" ? "❌" : (it.state === "downloading" ? "⬇" : "•"));
//     const cls = it.state === "failed" || it.state === "error" ? "fail" : (it.state === "downloading" ? "" : "ok");
//     const barCls = it.state === "failed" || it.state === "error" ? "row-bar-fail"
//       : (it.state === "downloading" ? "row-bar-active"
//         : (it.state === "done" || it.state === "skipped" || it.state === "submitted" ? "row-bar-ok" : "row-bar-pending"));
//     const p = Math.max(0, Math.min(100, it.progress || 0));
//     const displayName = it.file || it.title || it.id;
//     // 文件名模板已含标题，后面不再重复标题，只显示作者
//     const meta = [it.author, speedStr, it.error].filter(Boolean).join(" · ");
//     const thumb = it.id
//       ? `<img class="row-thumb" src="/api/thumb?id=${encodeURIComponent(it.id)}" alt="" loading="lazy" onerror="this.style.display='none'">`
//       : `<div class="row-thumb"></div>`;
//     let actBtns = "";
//     if (it.id) {
//       actBtns += `<a class="mm-play-btn" href="/play.html?id=${encodeURIComponent(it.id)}" target="_blank" rel="noopener" title="本地播放">▶ 播放</a>`;
//     }
//     if (it.id && (it.state === "failed" || it.state === "error")) {
//       actBtns += `<button type="button" class="mm-retry-btn" data-id="${esc(it.id)}" title="重试下载此视频">🔄 重试</button>` +
//         `<button type="button" class="mm-skip-btn" data-id="${esc(it.id)}" title="从列表拿掉（不删文件）">🚫 跳过</button>`;
//     } else if (it.id && (it.state === "done" || it.state === "skipped" || it.state === "submitted")) {
//       actBtns += `<button type="button" class="mm-skip-btn" data-id="${esc(it.id)}" title="从列表拿掉（不删文件）">🚫 跳过</button>`;
//     }
//     const row = `<div class="item ${cls}">
//       ${thumb}
//       <span class="icon">${icon}</span>
//       <span class="item-name">${esc(displayName)}
//         <span class="row-bar ${barCls}"><span class="row-bar-fill" style="width:${p}%"></span></span>
//       </span>
//       <span class="status-text">${esc(it.state || "")} ${p}% ${esc(speedStr)} ${fmtSize(it.doneBytes)}${it.total ? " / " + fmtSize(it.total) : ""}${actBtns}<br>${esc(meta)}</span>
//     </div>`;
//     listHtml.push(row);
//   }
//   $("#taskList").innerHTML = listHtml.join("") || '<div class="empty">暂无任务</div>';
// }

function rowDisplayName(it) {
  // 2026-09-03：列表闪名根因之一是 displayName = file || title || id，解析中途 title/file 轮换。
  // 用户原话「任务会在下载列表名字闪来闪去」。稳定优先级：已解析模板文件名 > 标题 > id。
  const id = String(it.id || "");
  const file = String(it.file || "");
  const title = String(it.title || "");
  if (file && id && file.indexOf(id) >= 0 && file !== id + ".mp4") return file;
  if (title && title !== id) return title;
  return file || title || id;
}

function ensureTaskRow(listEl, it) {
  let row = listEl.querySelector('[data-task-id="' + CSS.escape(it.id || "") + '"]');
  if (row) return row;
  row = document.createElement("div");
  row.className = "item";
  row.setAttribute("data-task-id", it.id || "");
  row.innerHTML =
    '<div class="row-thumb"></div>' +
    '<span class="icon"></span>' +
    '<span class="item-name"></span>' +
    '<span class="status-text"></span>';
  listEl.appendChild(row);
  return row;
}

function renderTask(task) {
  // 2026-09-03 修改：任务列表按行更新，不再每 1.5s innerHTML 整表重绘。
  // 【原代码】$("#taskList").innerHTML = listHtml.join("")
  // 【改为】用户原话「任务会在下载列表名字闪来闪去，对比 gamebanana-mods-downloader-server 找出原因」
  // 【思路】gbmd 有指纹缓存避免无变化重绘；iwara 这边名字闪是因为 applyParsedName 改 title/file 后整表销毁重建。
  //   按 data-task-id 复用行，只改进度/状态/稳定文件名。
  const stateText = { running: "下载中", idle: "空闲", paused: "已暂停" };
  $("#taskState").textContent = task ? (stateText[task.status] || task.status) : "无任务";
  if (!task || !(task.items || []).length) {
    $("#progressFill").style.width = "0%";
    $("#taskMeta").textContent = "尚未开始下载";
    $("#taskList").innerHTML = '<div class="empty">暂无任务</div>';
    $("#pauseBtn").disabled = true;
    $("#resumeBtn").disabled = true;
    $("#stopBtn").disabled = true;
    $("#retryBtn").disabled = true;
    if ($("#clearFailBtn")) $("#clearFailBtn").disabled = true;
    if ($("#clearDoneBtn")) $("#clearDoneBtn").disabled = true;
    return;
  }
  const items = task.items || [];
  const doneN = items.filter((it) => it.state === "done" || it.state === "skipped" || it.state === "submitted").length;
  const failN = items.filter((it) => it.state === "failed" || it.state === "error").length;
  const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;
  $("#progressFill").style.width = pct + "%";
  $("#taskMeta").textContent = "完成 " + doneN + " / " + items.length + "，失败 " + failN + (task.backend ? " · 后端 " + task.backend : "");
  $("#pauseBtn").disabled = task.status !== "running";
  $("#resumeBtn").disabled = task.status !== "paused";
  $("#stopBtn").disabled = task.status === "idle";
  $("#retryBtn").disabled = failN === 0;
  if ($("#clearFailBtn")) $("#clearFailBtn").disabled = failN === 0;
  if ($("#clearDoneBtn")) $("#clearDoneBtn").disabled = doneN === 0;

  const now = Date.now();
  const listEl = $("#taskList");
  if (listEl.querySelector(".empty")) listEl.innerHTML = "";
  const seen = new Set();
  for (const it of items) {
    if (!it.id) continue;
    seen.add(it.id);
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
    const displayName = rowDisplayName(it);
    const meta = [it.author, speedStr, it.error].filter(Boolean).join(" · ");
    const row = ensureTaskRow(listEl, it);
    row.className = "item " + cls;
    let thumb = row.querySelector(".row-thumb");
    if (thumb && thumb.tagName !== "IMG") {
      const img = document.createElement("img");
      img.className = "row-thumb";
      img.alt = "";
      img.loading = "lazy";
      img.onerror = function () { this.style.display = "none"; };
      img.src = "/api/thumb?id=" + encodeURIComponent(it.id);
      row.replaceChild(img, thumb);
      thumb = img;
    }
    const iconEl = row.querySelector(".icon");
    if (iconEl) iconEl.textContent = icon;
    let nameEl = row.querySelector(".item-name");
    if (nameEl) {
      let bar = nameEl.querySelector(".row-bar");
      if (!bar) {
        nameEl.textContent = displayName;
        bar = document.createElement("span");
        bar.innerHTML = '<span class="row-bar-fill" style="width:0%"></span>';
        nameEl.appendChild(bar);
      } else if (nameEl.firstChild && nameEl.firstChild.nodeType === 3) {
        if (nameEl.firstChild.textContent !== displayName) nameEl.firstChild.textContent = displayName;
      } else {
        nameEl.insertBefore(document.createTextNode(displayName), bar);
      }
      bar.className = "row-bar " + barCls;
      const fill = bar.querySelector(".row-bar-fill");
      if (fill) fill.style.width = p + "%";
    }
    let actBtns = "";
    if (it.id) {
      actBtns += '<a class="mm-play-btn" href="/play.html#id=' + encodeURIComponent(it.id) + '" target="_blank" rel="noopener" title="本地播放">▶ 播放</a>';
    }
    if (it.id && (it.state === "failed" || it.state === "error")) {
      actBtns += '<button type="button" class="mm-retry-btn" data-id="' + esc(it.id) + '" title="重试下载此视频">🔄 重试</button>' +
        '<button type="button" class="mm-skip-btn" data-id="' + esc(it.id) + '" title="从列表拿掉（不删文件）">🚫 跳过</button>';
    } else if (it.id && (it.state === "done" || it.state === "skipped" || it.state === "submitted")) {
      actBtns += '<button type="button" class="mm-skip-btn" data-id="' + esc(it.id) + '" title="从列表拿掉（不删文件）">🚫 跳过</button>';
    }
    const statusEl = row.querySelector(".status-text");
    if (statusEl) {
      const text = (it.state || "") + " " + p + "% " + speedStr + " " + fmtSize(it.doneBytes) + (it.total ? " / " + fmtSize(it.total) : "");
      if (statusEl.getAttribute("data-act") !== actBtns || statusEl.getAttribute("data-meta") !== meta) {
        statusEl.setAttribute("data-act", actBtns);
        statusEl.setAttribute("data-meta", meta);
        statusEl.innerHTML = esc(text) + actBtns + "<br>" + esc(meta);
      } else {
        const first = statusEl.childNodes[0];
        if (first && first.nodeType === 3) first.textContent = text + " ";
        else statusEl.innerHTML = esc(text) + actBtns + "<br>" + esc(meta);
      }
    }
  }
  Array.from(listEl.querySelectorAll("[data-task-id]")).forEach((el) => {
    if (!seen.has(el.getAttribute("data-task-id"))) el.remove();
  });
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
  // 开始和结束都默认今天（bindInputs 内部也会兜底，这里提前填好防闪烁）
  const today = (window.SearchDateRange && SearchDateRange.todayYmd()) || localDate(new Date());
  if ($("#searchStart") && !$("#searchStart").value) $("#searchStart").value = today;
  if ($("#searchEnd") && !$("#searchEnd").value) $("#searchEnd").value = today;
  if (window.SearchDateRange && $("#searchStart") && $("#searchEnd")) {
    SearchDateRange.bindInputs($("#searchStart"), $("#searchEnd"), function () {
      setStatus($("#searchStatus"), "已自动修正日期范围");
    });
  }

  $("#earliestBtn").addEventListener("click", () => {
    $("#searchStart").value = (window.SearchDateRange && SearchDateRange.EARLIEST) || "2000-01-01";
    if (window.SearchDateRange && $("#searchEnd")) {
      const r = SearchDateRange.enforceDateRules($("#searchStart").value, $("#searchEnd").value);
      $("#searchStart").value = r.startDate;
      $("#searchEnd").value = r.endDate;
    }
    setStatus($("#searchStatus"), "开始日期已设为最早（2000-01-01）");
  });

  $("#kwSearchBtn").addEventListener("click", runSearch);
  $("#kwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  bindFollowingCombo();
  if ($("#kwType")) {
    $("#kwType").addEventListener("change", onKwTypeChange);
    onKwTypeChange();
  }
  if ($("#filterNormal")) $("#filterNormal").addEventListener("change", () => { renderSearchResults(); });
  if ($("#filterNsfw")) $("#filterNsfw").addEventListener("change", () => { renderSearchResults(); });

  $("#searchBtn").addEventListener("click", async () => {
    const range = window.SearchDateRange
      ? SearchDateRange.enforceDateRules($("#searchStart").value, $("#searchEnd").value)
      : { startDate: $("#searchStart").value || "2000-01-01", endDate: $("#searchEnd").value };
    if ($("#searchStart")) $("#searchStart").value = range.startDate;
    if ($("#searchEnd")) $("#searchEnd").value = range.endDate;
    const startDate = range.startDate || "2000-01-01";
    const endDate = range.endDate;
    if (!endDate) { setStatus($("#searchStatus"), "请选择结束日期", "err"); return; }
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
        startDate, endDate, contentFilter
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

  function bindSelectAll(listSel, items) {
    const wantNormal = $("#filterNormal").checked;
    const wantNsfw = $("#filterNsfw").checked;
    document.querySelectorAll(listSel + " input[type=checkbox]").forEach((cb) => {
      const id = cb.dataset.id;
      const it = items.find((x) => videoId(x) === id);
      cb.checked = !!it && (videoNsfw(it) ? wantNsfw : wantNormal);
    });
  }
  $("#selectAllBtn").addEventListener("click", () => bindSelectAll("#searchResultList", searchResults));
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

  async function downloadFromList(listSel, items) {
    const ids = [...document.querySelectorAll(listSel + " input[type=checkbox]:checked")].map((c) => c.dataset.id);
    if (!ids.length) { showFeedback("请先勾选", "err"); return; }
    const payload = ids.map((id) => {
      const v = items.find((x) => videoId(x) === id) || { id };
      if (v && v._kind === "user") return null;
      return { id, title: v.title || v.name || "", author: videoAuthor(v) };
    }).filter(Boolean);
    if (!payload.length) { showFeedback("作者结果不能直接下载，请改搜视频", "err"); return; }
    try {
      const r = await api("/api/download", "POST", { items: payload });
      if (!r.ok) throw new Error(r.error || "启动失败");
      showFeedback("已加入下载（" + payload.length + "）", "ok");
      switchTab("progress");
    } catch (e) {
      showFeedback(e.message, "err");
    }
  }
  $("#downloadSelectedBtn").addEventListener("click", () => downloadFromList("#searchResultList", searchResults));
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

function kwType() {
  const el = $("#kwType");
  return (el && el.value) || "videos";
}

function onKwTypeChange() {
  const type = kwType();
  const input = $("#kwInput");
  const combo = $("#kwUserCombo");
  if (input) {
    input.placeholder = type === "users" ? "搜作者，或从关注列表里选" : "输入关键词";
  }
  if (combo && type !== "users") combo.style.display = "none";
  if (type === "users") loadFollowingUsers();
}

async function runUserVideos(username) {
  const user = String(username || "").trim();
  if (!user) return;
  setStatus($("#kwStatus"), "正在拉取 @" + user + " 的视频…");
  $("#kwSearchBtn").disabled = true;
  try {
    const qs = new URLSearchParams({ sort: "date", page: "0", limit: "48", user });
    const wantNormal = $("#filterNormal").checked;
    const wantNsfw = $("#filterNsfw").checked;
    if (wantNormal && !wantNsfw) qs.set("rating", "general");
    else if (!wantNormal && wantNsfw) qs.set("rating", "ecchi");
    const r = await api("/api/videos?" + qs.toString());
    if (!r.ok) throw new Error(r.error || "搜索失败");
    searchResults = applyRatingFilter(r.results || []);
    renderSearchResults();
    setStatus($("#kwStatus"), "@" + user + " 的视频（" + searchResults.length + " 条）", "ok");
  } catch (e) {
    setStatus($("#kwStatus"), "失败：" + e.message, "err");
  }
  $("#kwSearchBtn").disabled = false;
}

async function runSearch() {
  const kw = $("#kwInput").value.trim();
  const type = kwType();
  if (!kw) { setStatus($("#kwStatus"), type === "users" ? "请输入作者名" : "请输入关键词", "err"); return; }
  setStatus($("#kwStatus"), "搜索中…");
  $("#kwSearchBtn").disabled = true;
  try {
    const qs = new URLSearchParams({ type, page: "0", limit: "48", search: kw });
    if (type === "users") {
      qs.set("sort", "relevance");
    } else {
      qs.set("sort", "date");
      const wantNormal = $("#filterNormal").checked;
      const wantNsfw = $("#filterNsfw").checked;
      if (wantNormal && !wantNsfw) qs.set("rating", "general");
      else if (!wantNormal && wantNsfw) qs.set("rating", "ecchi");
    }
    const r = await api("/api/videos?" + qs.toString());
    if (!r.ok) throw new Error(r.error || "搜索失败");
    const rows = r.results || [];
    searchResults = type === "users" ? rows.map(normalizeUserRow).filter(Boolean) : applyRatingFilter(rows);
    renderSearchResults();
    setStatus($("#kwStatus"), "完成（" + searchResults.length + " 条）", "ok");
  } catch (e) {
    setStatus($("#kwStatus"), "失败：" + e.message, "err");
  }
  $("#kwSearchBtn").disabled = false;
}

function normalizeUserRow(u) {
  if (!u) return null;
  const user = u.user && (u.user.username || u.user.id) ? u.user : u;
  const username = String(user.username || u.username || "").trim();
  const id = String(user.id || u.id || username).trim();
  if (!username && !id) return null;
  return {
    _kind: "user",
    id,
    username,
    name: String(user.name || u.name || username),
    title: String(user.name || u.name || username),
    following: !!(user.following || u.following)
  };
}

function thumbSrc(v) {
  const id = videoId(v);
  const fileId = v && v.file && v.file.id;
  const n = Number.isFinite(Number(v.thumbnail)) ? Number(v.thumbnail) : 0;
  if (id) {
    let u = "/api/thumb?id=" + encodeURIComponent(id);
    if (fileId) u += "&file=" + encodeURIComponent(fileId) + "&n=" + n;
    return u;
  }
  if (fileId) return "/api/thumb?file=" + encodeURIComponent(fileId) + "&n=" + n;
  if (v && typeof v.thumbnailUrl === "string" && v.thumbnailUrl.indexOf("/api/thumb") === 0) return v.thumbnailUrl;
  return "";
}

function resultItemHtml(v) {
  if (v && v._kind === "user") {
    const username = v.username || v.id;
    const href = "https://www.iwara.tv/profile/" + encodeURIComponent(username);
    const follow = v.following ? '<span class="badge liked">已关注</span>' : "";
    return `<div class="result-item">
      <div class="row-thumb" style="background:var(--card2)"></div>
      <div class="name"><b><a href="${esc(href)}" target="_blank" rel="noopener">${esc(v.name || username)}</a></b> ${follow}
        <div class="meta">@${esc(username)}</div>
      </div>
      <button class="ghost" type="button" data-search-user="${esc(username)}">搜他的视频</button>
    </div>`;
  }
  const author = videoAuthor(v);
  const when = v.createdAt ? new Date(v.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
  const tag = videoNsfw(v) ? '<span class="badge nsfw">R18</span>' : '<span class="badge normal">普通</span>';
  const liked = (settings && settings.showLikedInSearch !== false && v.liked) ? '<span class="badge liked">❤️ 已赞</span>' : "";
  const id = videoId(v);
  const href = "https://www.iwara.tv/video/" + encodeURIComponent(id);
  const src = thumbSrc(v);
  const img = src
    ? `<img class="row-thumb" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="row-thumb" style="background:var(--card2)"></div>`;
  return `<div class="result-item">
    <input type="checkbox" data-id="${esc(id)}" onclick="event.stopPropagation()">
    <a href="${esc(href)}" target="_blank" rel="noopener">${img}</a>
    <div class="name"><b><a href="${esc(href)}" target="_blank" rel="noopener">${esc(v.title || v.name || id)}</a></b> ${tag} ${liked}
      <div class="meta">${esc(author)} · ${esc(id)} · ${esc(when)}</div>
    </div>
  </div>`;
}

function fillResultList(boxSel, countSel, list) {
  const box = $(boxSel);
  if (!box) return;
  const shown = applyRatingFilter(list);
  const countEl = $(countSel);
  if (countEl) countEl.textContent = shown.length ? ("共 " + shown.length + " 条") : "";
  if (!shown.length) { box.innerHTML = '<div class="empty">无结果</div>'; return; }
  box.innerHTML = shown.map(resultItemHtml).join("");
}

function renderSearchResults() {
  fillResultList("#searchResultList", "#resultCount", searchResults);
  const box = $("#searchResultList");
  if (!box || box.dataset.userClickBound) return;
  box.dataset.userClickBound = "1";
  box.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-search-user]");
    if (!btn) return;
    const username = btn.getAttribute("data-search-user");
    if (!username) return;
    if ($("#kwType")) $("#kwType").value = "videos";
    if ($("#kwInput")) $("#kwInput").value = "";
    onKwTypeChange();
    runUserVideos(username);
  });
}

let followingUsers = [];
function bindFollowingCombo() {
  const input = $("#kwInput");
  const combo = $("#kwUserCombo");
  if (!input || !combo) return;
  function renderCombo(filter) {
    if (kwType() !== "users") { combo.style.display = "none"; return; }
    const q = String(filter || "").trim().toLowerCase();
    const matched = q
      ? followingUsers.filter((u) => (u.name + " " + u.username).toLowerCase().includes(q))
      : followingUsers;
    const shown = matched.slice(0, 20);
    if (!shown.length) { combo.innerHTML = '<div class="combo-empty">无匹配关注</div>'; combo.style.display = "block"; return; }
    combo.innerHTML = shown.map((u) => {
      const label = u.name && u.username && u.name !== u.username ? (u.name + " · " + u.username) : (u.name || u.username);
      return `<div class="combo-item" data-v="${esc(u.username || u.id)}">${esc(label)}</div>`;
    }).join("");
    combo.style.display = "block";
  }
  function pickUser(username) {
    input.value = username;
    combo.style.display = "none";
    if ($("#kwType")) $("#kwType").value = "videos";
    onKwTypeChange();
    runUserVideos(username);
  }
  input.addEventListener("focus", () => { if (kwType() === "users" && followingUsers.length) renderCombo(input.value); });
  input.addEventListener("input", () => { if (kwType() === "users") renderCombo(input.value); });
  input.addEventListener("keydown", (e) => {
    if (kwType() !== "users") return;
    if (e.key === "ArrowDown") {
      const items = document.querySelectorAll("#kwUserCombo .combo-item");
      if (items.length) { e.preventDefault(); const cur = document.querySelector("#kwUserCombo .combo-item.hover") || items[0]; cur.classList.remove("hover"); (cur.nextElementSibling || items[0]).classList.add("hover"); }
    } else if (e.key === "ArrowUp") {
      const items = document.querySelectorAll("#kwUserCombo .combo-item");
      if (items.length) { e.preventDefault(); const cur = document.querySelector("#kwUserCombo .combo-item.hover") || items[0]; cur.classList.remove("hover"); (cur.previousElementSibling || items[items.length - 1]).classList.add("hover"); }
    } else if (e.key === "Enter") {
      const cur = document.querySelector("#kwUserCombo .combo-item.hover");
      if (cur) { e.preventDefault(); pickUser(cur.dataset.v); }
    } else if (e.key === "Escape") {
      combo.style.display = "none";
    }
  });
  document.addEventListener("click", (e) => {
    const item = e.target.closest && e.target.closest("#kwUserCombo .combo-item");
    if (item) { pickUser(item.dataset.v); return; }
    if (!e.target.closest("#kwInput") && !e.target.closest("#kwUserCombo")) combo.style.display = "none";
  });
}

async function loadFollowingUsers() {
  const input = $("#kwInput");
  if (!input) return;
  if (kwType() !== "users") return;
  if (followingLoaded && followingUsers.length) return;
  try {
    const r = await api("/api/following?limit=50");
    if (!r.ok) throw new Error(r.error || "失败");
    followingUsers = r.following || [];
    followingLoaded = true;
    const total = r.count || followingUsers.length;
    const st = $("#kwStatus");
    if (st && followingUsers.length) setStatus(st, "已加载关注 " + followingUsers.length + "/" + total + "，输入可过滤", "ok");
    if (total > followingUsers.length) {
      api("/api/following?all=1").then((full) => {
        if (full && full.ok && Array.isArray(full.following)) {
          followingUsers = full.following;
          if (st) setStatus(st, "关注列表 " + followingUsers.length + " / " + (full.count || followingUsers.length), "ok");
        }
      }).catch(() => {});
    }
  } catch (e) {
    followingLoaded = false;
  }
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

// 2026-09-01 aria2 与服务器是否同机（调用 /api/aria2-device，徽标显示）
async function checkAria2Device(pathStr) {
  const badge = $("#aria2SameBadge");
  if (!badge) return;
  const p = String(pathStr || "").trim();
  if (!p) { badge.style.display = "none"; badge.textContent = ""; return; }
  try {
    const r = await api("/api/aria2-device?path=" + encodeURIComponent(p));
    badge.style.display = "";
    if (r && r.same === true) { badge.textContent = "同一设备"; badge.className = "badge normal"; }
    else if (r && r.same === false) { badge.textContent = "跨设备"; badge.className = "badge nsfw"; }
    else { badge.textContent = "无法判断"; badge.className = "badge"; }
  } catch (_) {
    badge.style.display = "";
    badge.textContent = "判断失败"; badge.className = "badge nsfw";
  }
}

function fillSettings(s) {
  settings = s || {};
  $("#set-downloadPath").value = settings.downloadPath || "";
  $("#set-fileNameTemplate").value = (settings.fileNameTemplate || "Iwara_-_{TITLE}_[{ID}]_[{QUALITY}]").replace(/\.(mp4|webm|mov)$/i, "");
  $("#set-useAuthorSubdir").value = settings.useAuthorSubdir ? "true" : "false";
  if ($("#set-showLikedInSearch")) $("#set-showLikedInSearch").checked = settings.showLikedInSearch !== false;
  if ($("#set-autoLike")) $("#set-autoLike").checked = !!settings.autoLike;
  if ($("#set-autoFollow")) $("#set-autoFollow").checked = !!settings.autoFollow;
  // 2026-09-03 playPublic：默认 true（免登录播放）
  if ($("#set-playPublic")) $("#set-playPublic").checked = settings.playPublic !== false;
  $("#set-downloadBackend").value = settings.downloadBackend || "direct";
  $("#set-concurrency").value = settings.concurrency || 3;
  const tog = settings.downloadToggles || {};
  if ($("#set-dlVideo")) $("#set-dlVideo").checked = tog.video !== false;
  if ($("#set-dlJson")) $("#set-dlJson").checked = tog.json !== false;
  $("#set-aria2Path").value = settings.aria2Path || "";
  if (!$("#set-aria2Token").value) {
    $("#set-aria2Token").placeholder = settings.hasAria2Token ? "已保存则留空不改" : "RPC 密钥";
  }
  checkAria2Device($("#set-aria2Path").value);
  $("#set-iwaraCfgIp").value = settings.iwaraCfgIp || "104.26.12.12";
  $("#set-aria2Dns").value = settings.aria2Dns || "";
  // Cookie 框只在空着时回填一次：保存后不要把旧值盖回刚贴进去的新凭证
  const cookieEl = $("#set-iwaraCookie");
  if (cookieEl && !cookieEl.value.trim()) {
    cookieEl.placeholder = settings.hasCookie
      ? "已保存 Cookie（再贴新凭证才会覆盖；留空不改）"
      : "粘贴 Cookie 或油猴组合文本后点保存";
  }
}

let browseTargetInput = null;
function openBrowse(input) {
  browseTargetInput = input;
  $("#browseMask").style.display = "flex";
  if ($("#browseHint")) $("#browseHint").textContent = "";
  const start = (input && input.value && input.value.trim().startsWith("/")) ? input.value.trim() : "/";
  loadBrowse(start);
}
async function loadBrowse(p) {
  const el = $("#browsePath");
  if (!el) return;
  el.textContent = "读取中…";
  let r;
  try { r = await api("/api/browse?path=" + encodeURIComponent(p)); }
  catch (e) { el.textContent = "读取失败: " + e.message; return; }
  if (!r || !r.ok) { el.textContent = (r && r.error) || "读取失败"; return; }
  el.textContent = r.path;
  $("#browseSelect").dataset.path = r.path;
  let html = "";
  if (r.parent) html += `<div class="browse-item" data-path="${esc(r.parent)}">⬆ 上级目录</div>`;
  if (!r.dirs || !r.dirs.length) html += '<div class="hint">（无子目录）</div>';
  (r.dirs || []).forEach((d) => {
    const full = r.path === "/" ? "/" + d : r.path + "/" + d;
    html += `<div class="browse-item" data-path="${esc(full)}">📁 ${esc(d)}</div>`;
  });
  $("#browseList").innerHTML = html;
  $("#browseList").querySelectorAll(".browse-item").forEach((el2) => {
    el2.addEventListener("click", () => loadBrowse(el2.dataset.path));
  });
}
function bindBrowse() {
  if (!$("#browseMask")) return;
  $("#browsePathBtn").addEventListener("click", () => openBrowse($("#set-downloadPath")));
  $("#browseClose").addEventListener("click", () => { $("#browseMask").style.display = "none"; });
  $("#browseMask").addEventListener("click", (e) => { if (e.target === $("#browseMask")) $("#browseMask").style.display = "none"; });
  $("#browseSelect").addEventListener("click", () => {
    const p = $("#browseSelect").dataset.path || "";
    if (browseTargetInput && p) { browseTargetInput.value = p; $("#browseMask").style.display = "none"; }
  });
}

function bindSettings() {
  // 2026-09-01 aria2 同机判断：输入框改动后即时刷新徽标
  const aria2Input = $("#set-aria2Path");
  if (aria2Input) {
    aria2Input.addEventListener("blur", () => checkAria2Device(aria2Input.value));
    aria2Input.addEventListener("input", () => checkAria2Device(aria2Input.value));
  }
  const tplEl = $("#set-fileNameTemplate");
  if (tplEl) {
    tplEl.addEventListener("input", () => {
      const ok = tplEl.value.indexOf("{ID}") >= 0;
      tplEl.style.outline = ok ? "" : "2px solid var(--fail)";
    });
  }
  // 2026-09-01 保存设置改悬浮按钮（右下角 💾，仅设置页显示；反馈改 toast）
  const saveFab = $("#saveSettingsFab");
  if (saveFab) saveFab.addEventListener("click", async () => {
    try {
      const tpl = $("#set-fileNameTemplate").value.trim().replace(/\.(mp4|webm|mov|mkv|m4v)$/i, "");
      if (tpl.indexOf("{ID}") < 0) {
        showToast("文件名模板必须含 {ID}", "err");
        setStatus($("#settingsStatus"), "文件名模板必须含 {ID}，封面和 json 靠这个 id 对视频", "err");
        return;
      }
      const body = {
        downloadPath: $("#set-downloadPath").value.trim(),
        fileNameTemplate: tpl,
        useAuthorSubdir: $("#set-useAuthorSubdir").value === "true",
        showLikedInSearch: $("#set-showLikedInSearch") ? $("#set-showLikedInSearch").checked : true,
        autoLike: $("#set-autoLike") ? $("#set-autoLike").checked : false,
        autoFollow: $("#set-autoFollow") ? $("#set-autoFollow").checked : false,
        playPublic: $("#set-playPublic") ? $("#set-playPublic").checked : true,
        downloadBackend: $("#set-downloadBackend").value,
        concurrency: parseInt($("#set-concurrency").value, 10) || 3,
        downloadToggles: {
          video: $("#set-dlVideo") ? $("#set-dlVideo").checked : true,
          json: $("#set-dlJson") ? $("#set-dlJson").checked : true
        },
        aria2Path: $("#set-aria2Path").value.trim(),
        aria2Token: $("#set-aria2Token").value,
        iwaraCfgIp: $("#set-iwaraCfgIp").value.trim(),
        aria2Dns: $("#set-aria2Dns").value.trim()
      };
      const credText = $("#set-iwaraCookie").value;
      if (credText && credText.trim()) body.iwaraCookie = credText;
      const r = await api("/api/settings", "POST", body);
      if (!r.ok) throw new Error(r.error || "保存失败");
      const cookieEl = $("#set-iwaraCookie");
      if (cookieEl) {
        cookieEl.value = "";
        cookieEl.placeholder = "已保存（再贴新凭证才会覆盖；留空不改）";
        cookieEl.dataset.filled = "1";
      }
      fillSettings(r.settings);
      setStatus($("#settingsStatus"), "已保存凭证与设置", "ok");
      // 2026-09-01 保存反馈改悬浮窗
      showToast("✅ 已保存设置", "ok");
      if (kwType() === "users") loadFollowingUsers();
      refreshIwaraBadge();
    } catch (e) {
      setStatus($("#settingsStatus"), e.message, "err");
      showToast("❌ 保存失败：" + e.message, "err");
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
      const r = await api("/api/account-check");
      updateIwaraUserBadge(r);
      el.textContent = formatIwaraLoginBlock(r);
      el.className = "login-detect " + (r.warnLevel === "expired" || !r.loggedIn || !r.cookieSet ? "err" : (r.warnLevel === "warn" ? "warn" : "ok"));
      if (r.loggedIn && kwType() === "users") loadFollowingUsers();
    } catch (e) {
      el.textContent = e.message;
      el.className = "status err";
    }
  });

  $("#exportIndexBtn").addEventListener("click", async () => {
    const st = $("#indexStatus");
    setStatus(st, "正在导出索引…");
    try {
      const r = await fetch("/api/index/export", { credentials: "same-origin" });
      if (r.status === 401) { location.href = "/login.html"; return; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "导出失败"); }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "iwara-index-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(st, "已导出 iwara-index.json", "ok");
    } catch (e) {
      setStatus(st, "导出失败: " + (e && e.message || e), "err");
    }
  });
  $("#importIndexBtn").addEventListener("click", () => { $("#importIndexFile").click(); });
  $("#importIndexFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    const st = $("#indexStatus");
    if (!file) return;
    setStatus(st, "正在导入 " + file.name + " …");
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const r = await api("/api/index/import", "POST", json);
      if (!r.ok) throw new Error(r.error || "导入失败");
      setStatus(st, "导入完成：新增 " + r.added + "，更新 " + r.updated + "，合计 " + r.count, "ok");
    } catch (e) {
      setStatus(st, "导入失败: " + (e && e.message || e), "err");
    } finally {
      ev.target.value = "";
    }
  });
  $("#scanIndexBtn").addEventListener("click", async () => {
    const st = $("#indexStatus");
    setStatus(st, "正在扫描下载目录…");
    try {
      const r = await api("/api/index/scan", "POST", {});
      if (!r.ok) throw new Error(r.error || "扫描失败");
      setStatus(st, "扫描完成：读 " + r.filesRead + " 个 json，用 " + r.filesUsed + " 个；新增 " + r.added + "，更新 " + r.updated + "，合计 " + r.count, "ok");
    } catch (e) {
      setStatus(st, "扫描失败: " + (e && e.message || e), "err");
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
      const login = r.login || {};
      if (login.loggedIn) {
        setStatus(st, "导入完成：恢复 " + r.restored.length + " 个文件。Iwara 已登录 " + (login.username || login.user || "") + (login.remainingDays != null ? "，剩 " + Math.floor(login.remainingDays) + " 天" : ""), "ok");
      } else {
        setStatus(st, "导入完成：恢复 " + r.restored.length + " 个文件。Iwara 登录失败：" + (login.error || "未知") + "。" + (r.note || ""), login.error ? "err" : "ok");
      }
      refreshIwaraBadge();
    } catch (e) {
      setStatus(st, "导入失败: " + (e && e.message || e), "err");
    } finally {
      ev.target.value = "";
    }
  });
}

function formatIwaraRemain(r) {
  if (!r || r.remainingDays == null) return "";
  const d = r.remainingDays;
  if (d <= 0) return "已过期";
  if (d < 1) return "不足 1 天";
  return "剩 " + (d < 10 ? d.toFixed(1) : Math.floor(d)) + " 天";
}

function formatIwaraLoginText(r) {
  if (!r || !r.cookieSet) return "尚未配置 Cookie / Token";
  const name = r.username || r.user || "";
  const remain = formatIwaraRemain(r);
  if (r.warnLevel === "expired" || (!r.loggedIn && r.warnLevel === "expired")) return "❌ 登录已过期" + (remain ? "（" + remain + "）" : "");
  if (!r.loggedIn) return (r.error || "未登录") + (r.cfChallenge ? "（需含 cf_clearance）" : "");
  if (r.warnLevel === "warn") return "⚠️ 已登录：" + name + (remain ? "（" + remain + "，请尽快更新凭证）" : "");
  return "✅ 已登录：" + name + (remain ? "（" + remain + "）" : "");
}

function formatIwaraLoginBlock(r) {
  const L = [];
  const cred = (r && r.cred) || {};
  const name = (r && (r.username || r.user)) || "";
  const remain = formatIwaraRemain(r);
  if (!r || !r.cookieSet) {
    L.push("❌ 未配置 Cookie / Token");
  } else if (r.warnLevel === "expired") {
    L.push("❌ 登录已过期" + (remain ? "（" + remain + "）" : ""));
  } else if (r.loggedIn) {
    L.push((r.warnLevel === "warn" ? "⚠️ 已登录" : "✅ 已登录") + (remain ? "（" + remain + "）" : ""));
    L.push("👤 用户名: " + (name || "(未取到)"));
    if (r.userId) L.push("🆔 用户 id: " + r.userId);
    if (r.username) L.push("🔗 https://www.iwara.tv/profile/" + r.username);
    if (r.warnLevel === "warn") L.push("请尽快更新凭证");
  } else {
    L.push("❌ 未登录");
    if (r.error) L.push(r.error);
    if (r.cfChallenge) L.push("（需含 cf_clearance）");
  }
  L.push("───");
  L.push("完整 Cookie: " + (cred.cookieChars || 0) + " 字符 / " + (cred.cookieItems || 0) + " 项 ｜ 存于服务器（不回传明文）");
  L.push("含 cf_clearance: " + (cred.hasCfClearance ? "✅ 有" : "❌ 无"));
  L.push("refresh_token: " + (cred.hasToken ? "✅ 有" : "❌ 无"));
  L.push("access_token: " + (cred.hasAccessToken ? "✅ 有" : "❌ 无"));
  return L.join("\n");
}

function updateIwaraUserBadge(r) {
  const el = $("#iwaraUserBadge");
  const nameEl = $("#iwaraUserName");
  const remainEl = $("#iwaraUserRemain");
  if (!el) return;
  const setStack = (name, remain, cls) => {
    if (nameEl) nameEl.textContent = name;
    else el.textContent = name;
    if (remainEl) remainEl.textContent = remain || "";
    el.className = "sub header-stack " + cls;
  };
  if (!r || !r.cookieSet) {
    setStack("未配置凭证", "", "iwara-user-err");
    el.title = "设置页粘贴 Cookie / Token";
    return;
  }
  const name = r.username || r.user || "";
  const remain = formatIwaraRemain(r);
  if (r.warnLevel === "expired") {
    setStack("❌ 已过期", remain, "iwara-user-err");
  } else if (!r.loggedIn) {
    const short = r.cfChallenge ? "Cookie 需更新" : (r.error || "未登录");
    setStack("❌ " + short, "", "iwara-user-err");
  } else if (r.warnLevel === "warn") {
    setStack("⚠️ " + (name || "已登录"), remain, "iwara-user-warn");
  } else {
    setStack("👤 " + (name || "已登录"), remain, "iwara-user-ok");
  }
  el.title = formatIwaraLoginBlock(r);
}

async function refreshIwaraBadge() {
  try {
    const r = await api("/api/account-check");
    updateIwaraUserBadge(r);
  } catch (_) {}
}

function tickClock() {
  const dateEl = $("#serverDate");
  const clockEl = $("#serverClock");
  const el = $("#serverTime");
  if (!el && !dateEl && !clockEl) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  if (dateEl) dateEl.textContent = date;
  if (clockEl) clockEl.textContent = time;
  if (!dateEl && el) el.textContent = date + " " + time;
}

async function init() {
  bindTabs();
  bindTheme();
  bindBatch();
  bindProgress();
  bindSearch();
  bindSettings();
  bindBrowse();
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
  if (kwType() === "users") loadFollowingUsers();
  refreshIwaraBadge();
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
