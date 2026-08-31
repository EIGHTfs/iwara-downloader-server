/* iwara-downloader-server 前端逻辑（原生 JS，无依赖） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const api = {
  async get(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
    return r.json();
  }
};

// ---------- 选项卡 ----------
function switchTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// ---------- 通用 ----------
function fb(el, msg, ok) {
  el.textContent = msg || "";
  el.style.color = ok ? "#1a9d4b" : "#d0392f";
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtSize(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + u[i];
}

// ---------- 解析输入：ID 或链接 → 数组 ----------
function parseInput() {
  return $("#dl-input").value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/(?:video|v)\/([\w-]+)/i);
      return m ? m[1] : s.replace(/^https?:\/\/[^/]+\//, "").split("?")[0].trim();
    })
    .filter((s) => /^[\w-]+$/.test(s));
}

// ---------- 预解析 ----------
let previewData = [];
$("#btn-preview").addEventListener("click", async () => {
  const ids = parseInput();
  const tbody = $("#preview-table tbody");
  const fbEl = $("#dl-feedback");
  if (ids.length === 0) return fb(fbEl, "请输入视频 ID 或链接", false);
  $("#preview-table").classList.remove("hidden");
  tbody.innerHTML = "";
  previewData = [];
  fb(fbEl, "正在解析 " + ids.length + " 个视频…");

  for (const id of ids) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>…</td><td class="id">${esc(id)}</td><td colspan="4">解析中…</td>`;
    tbody.appendChild(tr);
    const r = await api.get(`/api/video-info?id=${encodeURIComponent(id)}`);
    if (r.ok && r.type === "full") {
      previewData.push({ id, title: r.title, author: r.author, file: r.file && r.file.name, size: r.file && r.file.size, quality: r.quality });
      tr.innerHTML = `
        <td><input type="checkbox" checked data-id="${esc(id)}"></td>
        <td class="id">${esc(id)}</td>
        <td>${esc(r.title)}</td>
        <td>${esc(r.author)}</td>
        <td>${esc(r.quality)}</td>
        <td>${esc(r.file && r.file.name)} (${fmtSize(r.file && r.file.size)})</td>
        <td class="state-done">✓</td>`;
    } else if (r.ok && r.type === "external") {
      tr.innerHTML = `<td></td><td class="id">${esc(id)}</td><td>${esc(r.title)}</td><td>${esc(r.author)}</td><td colspan="2">外链视频（无直链）</td><td class="state-failed">✗</td>`;
    } else {
      tr.innerHTML = `<td></td><td class="id">${esc(id)}</td><td colspan="4">${esc(r.error || "解析失败")}${r.hint ? " — " + esc(r.hint) : ""}</td><td class="state-failed">✗</td>`;
    }
  }
  fb(fbEl, "解析完成：" + ids.length + " 个");
});

// ---------- 开始下载 ----------
function startDownload(items) {
  return api.post("/api/download", { items });
}
$("#btn-dl").addEventListener("click", async () => {
  const fbEl = $("#dl-feedback");
  if (previewData.length === 0) {
    // 未预解析：直接用 ID
    const ids = parseInput();
    if (ids.length === 0) return fb(fbEl, "请输入视频 ID 或链接", false);
    const r = await startDownload(ids.map((id) => ({ id })));
    fb(fbEl, r.ok ? `已加入 ${r.total} 个任务` : "失败：" + (r.error || ""), r.ok);
    return;
  }
  const checked = previewData.filter((p) => {
    const cb = document.querySelector(`#preview-table tbody input[data-id="${CSS.escape(p.id)}"]`);
    return cb && cb.checked;
  });
  if (checked.length === 0) return fb(fbEl, "请先勾选要下载的视频", false);
  const r = await startDownload(checked.map((p) => ({ id: p.id, title: p.title, author: p.author, file: p.file, size: p.size })));
  fb(fbEl, r.ok ? `已加入 ${r.total} 个任务` : "失败：" + (r.error || ""), r.ok);
});

// ---------- 进度 ----------
function renderTask(t) {
  const box = $("#task-list");
  const sum = $("#task-summary");
  if (!t || !t.items || t.items.length === 0) {
    sum.innerHTML = "暂无任务";
    box.innerHTML = "";
    return;
  }
  const done = t.items.filter((i) => i.state === "done" || i.state === "skipped" || i.state === "submitted").length;
  const failed = t.items.filter((i) => i.state === "failed").length;
  const dl = t.items.filter((i) => i.state === "downloading").length;
  sum.innerHTML = `状态：<b>${t.status}</b> ｜ 完成 ${done} ｜ 下载中 ${dl} ｜ 失败 ${failed} ｜ 共 ${t.items.length} (后端: ${t.backend || "-"})`;

  box.innerHTML = t.items.map((it) => `
    <div style="padding:6px 0;border-bottom:1px solid #edf0f4">
      <div style="font-size:13px">${esc(it.title || it.id)} <span class="id" style="font-size:12px">(${esc(it.id)})</span>
        <span class="state-${esc(it.state)}" style="float:right">${STATE_CN[it.state] || it.state}</span></div>
      <div style="font-size:12px;color:#7a8494">
        ${esc(it.author || "")} ｜ ${esc(it.file || "")} ｜ ${fmtSize(it.total || 0)}
        <span class="prog" style="margin-left:8px"><i style="width:${it.progress || 0}%"></i></span> ${it.progress || 0}%
        ${it.error ? `<span style="color:#d0392f">｜ ${esc(it.error)}</span>` : ""}
      </div>
    </div>`).join("");
}
const STATE_CN = {
  pending: "等待", downloading: "下载中", done: "完成", skipped: "跳过",
  failed: "失败", submitted: "已提交Aria2", error: "错误"
};
let taskTimer = null;
function startTaskPoll() {
  if (taskTimer) clearInterval(taskTimer);
  taskTimer = setInterval(async () => {
    const r = await api.get("/api/task");
    if (r.ok) renderTask(r.task);
  }, 1500);
}
startTaskPoll();

$("#btn-pause").addEventListener("click", async () => { await api.post("/api/task/pause"); renderTask((await api.get("/api/task")).task); });
$("#btn-resume").addEventListener("click", async () => { await api.post("/api/task/resume"); renderTask((await api.get("/api/task")).task); });
$("#btn-stop").addEventListener("click", async () => { await api.post("/api/task/stop"); renderTask((await api.get("/api/task")).task); });
$("#btn-retry").addEventListener("click", async () => {
  const r = await api.post("/api/task/retry");
  fb($("#dl-feedback"), r.ok ? `重试 ${r.retried} 个失败任务` : "失败", r.ok);
});
$("#btn-setconc").addEventListener("click", async () => {
  const r = await api.post("/api/task/concurrency", { n: parseInt($("#concurrency").value, 10) });
  if (r.ok) fb($("#dl-feedback"), "并发已设为 " + r.concurrency, true);
});

// ---------- 搜索 ----------
async function loadSearch() {
  const type = $("#search-type").value;
  const user = $("#search-user").value.trim();
  const keyword = $("#search-keyword").value.trim();
  const qs = new URLSearchParams({ sort: type, page: "0", limit: "30" });
  if (user) qs.set("user", user);
  if (keyword) qs.set("search", keyword);
  const r = await api.get("/api/videos?" + qs.toString());
  const tbody = $("#search-table tbody");
  if (!r.ok) {
    tbody.innerHTML = `<tr><td colspan="5" class="state-failed">${esc(r.error || "拉取失败")} ${r.hint ? esc("(" + r.hint + ")") : ""}</td></tr>`;
    return;
  }
  tbody.innerHTML = (r.results || []).map((v) => `
    <tr>
      <td><input type="checkbox" class="sel" data-id="${esc(v.id)}" data-title="${esc(v.title)}" data-author="${esc(v.user && v.user.name)}"></td>
      <td class="id">${esc(v.id)}</td>
      <td>${esc(v.title)}</td>
      <td>${esc(v.user && v.user.name)}</td>
      <td>${new Date(v.createdAt).toLocaleString()}</td>
    </tr>`).join("") || `<tr><td colspan="5">无结果</td></tr>`;
}
$("#btn-search").addEventListener("click", loadSearch);
$("#btn-sel-all").addEventListener("click", () => {
  $$("#search-table tbody input.sel").forEach((c) => (c.checked = true));
});
$("#btn-dl-sel").addEventListener("click", async () => {
  const items = Array.from($$("#search-table tbody input.sel:checked")).map((c) => ({
    id: c.dataset.id, title: c.dataset.title, author: c.dataset.author
  }));
  if (items.length === 0) return alert("请先勾选视频");
  const r = await startDownload(items);
  fb($("#dl-feedback"), r.ok ? `已加入 ${r.total} 个任务` : "失败：" + (r.error || ""), r.ok);
});

// ---------- 设置 ----------
async function loadSettings() {
  const r = await api.get("/api/settings");
  if (!r.ok) return;
  const s = r.settings;
  $("#set-downloadPath").value = s.downloadPath || "";
  $("#set-useAuthorSubdir").value = String(!!s.useAuthorSubdir);
  $("#set-downloadBackend").value = s.downloadBackend || "direct";
  $("#set-concurrency").value = s.concurrency || 3;
  $("#set-aria2Path").value = s.aria2Path || "";
  $("#set-aria2Token").value = s.aria2Token || "";
  $("#set-iwaraCookie").value = s.iwaraCookie || "";
}
$("#btn-save-settings").addEventListener("click", async () => {
  const body = {
    downloadPath: $("#set-downloadPath").value.trim(),
    useAuthorSubdir: $("#set-useAuthorSubdir").value === "true",
    downloadBackend: $("#set-downloadBackend").value,
    concurrency: parseInt($("#set-concurrency").value, 10) || 3,
    aria2Path: $("#set-aria2Path").value.trim(),
    aria2Token: $("#set-aria2Token").value.trim(),
    iwaraCookie: $("#set-iwaraCookie").value.trim()
  };
  const r = await api.post("/api/settings", body);
  fb($("#settings-feedback"), r.ok ? "已保存" : "保存失败：" + (r.error || ""), r.ok);
});
$("#btn-setpwd").addEventListener("click", async () => {
  const pwd = $("#set-password").value;
  if (!pwd || pwd.length < 4) return alert("密码至少 4 位");
  const r = await api.post("/api/change-password", { password: pwd });
  fb($("#settings-feedback"), r.ok ? "密码已设置" : "失败：" + (r.error || ""), r.ok);
  $("#set-password").value = "";
});
$("#btn-iwara-check").addEventListener("click", async () => {
  const el = $("#iwara-check-result");
  el.classList.remove("hidden");
  el.textContent = "检测中…";
  el.className = "result";
  const r = await api.get("/api/iwara-check");
  if (!r.cookieSet) {
    el.textContent = "尚未配置 Cookie，请在下方填入 iwara Cookie（含 cf_clearance）后保存再检测。";
    el.className = "result err";
    return;
  }
  el.textContent = r.loggedIn
    ? `✅ 已登录：${r.user || ""}`
    : `❌ ${r.error || "未登录"}\n${r.cfChallenge ? "提示：Cookie 需含 cf_clearance 且与当前出口 IP/UA 匹配，请重新复制浏览器最新 Cookie。" : ""}`;
  el.className = "result " + (r.loggedIn ? "ok" : "err");
});

// ---------- 启动 ----------
(async function init() {
  loadSettings();
  const r = await api.get("/api/task");
  renderTask(r.task);
  const st = await api.get("/api/status");
  $("#conn").textContent = st.needsAuth ? "🔒 已设密码" : "⚠️ 未设密码";
})();