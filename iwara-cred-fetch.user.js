// ==UserScript==
// @name         Iwara Cookie/Token 获取器 + 发送到服务器（按钮版）
// @namespace    iwara-cred
// @version      6.0.0
// @description  点右下角 🎫 复制完整 Cookie（含 HttpOnly cf_clearance）/token；新增「发送到服务器」：把当前视频链接一键推给局域网内的 iwara-downloader-server 添加下载任务（自动在线探测 + 局域网扫描）
// @author       fnOS
// @match        https://www.iwara.tv/*
// @match        https://iwara.tv/*
// @match        https://ecchi.iwara.tv/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_cookie.list
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/* ============================================================
 * v6.0.0：按钮获取模式 + 发送到服务器
 * - 保留 v5 全部凭证采集/复制能力
 * - 新增「📤 发送到服务器」：把当前视频链接推给 iwara-downloader-server
 *     · 已保存服务器 → 先探测 /api/status 判断是否在线，在线则直接发送
 *     · 未保存 → 局域网扫描（WebRTC 取本机 IP 推导 /24 网段，探测候选端口
 *       /api/status），列出可用服务器供选择，选中后保存并发送
 *     · 服务端 /api/download 兼容完整 iwara.tv URL（自动提取视频 ID）
 * - 服务器地址 / 最近在线状态存 GM 存储（iwcred_server / iwcred_server_online）
 * ============================================================ */
(function () {
    "use strict";

    const VER = "6.0.0";

    /* ---------- 工具 ---------- */
    function $(sel) { return document.querySelector(sel); }
    function ls(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
    function log(...a) { try { console.log("[iwara-cred " + VER + "]", ...a); } catch (_) {} }

    /** 从 GM_cookie 读取完整 cookie（含 HttpOnly），返回 { text, count, source } */
    function readCookieGM() {
        return new Promise((resolve) => {
            const fallback = () => resolve({ text: document.cookie || "", count: 0, source: "document.cookie" });
            try {
                if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.list === "function") {
                    // 全量列出（不传 url/domain 过滤），再筛 iwara.tv 域，避免漏掉 api 子域的 cookie
                    GM_cookie.list({}, (cookies, error) => {
                        if (error) { log("GM_cookie.list error:", error); return fallback(); }
                        if (!Array.isArray(cookies) || cookies.length === 0) return fallback();
                        const iw = cookies.filter((c) => c && c.domain && String(c.domain).indexOf("iwara.tv") >= 0);
                        const list = (iw.length > 0 ? iw : cookies)
                            .map((c) => (c && c.name) ? c.name + "=" + (c.value || "") : "")
                            .filter(Boolean);
                        const text = list.join("; ");
                        log("GM_cookie 全量:", cookies.length, "个, iwara 域:", iw.length, "个");
                        resolve({ text, count: text ? text.split("; ").length : 0, source: "GM_cookie" });
                    });
                    return;
                }
            } catch (e) { log("GM_cookie exception:", e); }
            fallback();
        });
    }

    /** 完整凭证文本 */
    async function buildPayload() {
        const c = await readCookieGM();
        return [
            "Cookie=" + c.text,
            "Token=" + ls("token"),
            "AccessToken=" + ls("accessToken")
        ].join("\n");
    }

    function parseJwt(token) {
        if (!token) return null;
        try {
            const part = token.split(".")[1];
            if (!part) return null;
            const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
            const json = decodeURIComponent(
                atob(b64).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
            );
            return JSON.parse(json);
        } catch (_) { return null; }
    }

    /* ============================================================
     * 发送到服务器：GM 请求封装 / 在线探测 / 局域网扫描 / 发送
     * ============================================================ */

    const SRV_KEY = "iwcred_server";        // 最近选中的服务器地址
    const SCAN_PORTS = [8643, 28463, 8080, 3000]; // 候选端口（默认 8643）

    /** 跨域 GM_xmlhttpRequest 封装，返回 { ok, status, json, text, error } */
    function gmRequest(method, url, body, timeout) {
        return new Promise((resolve) => {
            try {
                if (typeof GM_xmlhttpRequest !== "function") {
                    return resolve({ ok: false, error: "无 GM_xmlhttpRequest 权限" });
                }
                GM_xmlhttpRequest({
                    method: method,
                    url: url,
                    timeout: timeout || 8000,
                    data: body !== undefined ? JSON.stringify(body) : undefined,
                    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
                    onload: (r) => {
                        let j = null;
                        try { j = JSON.parse(r.responseText); } catch (_) {}
                        resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: j, text: r.responseText, error: "" });
                    },
                    onerror: (r) => resolve({ ok: false, status: r.status, json: null, text: "", error: r.error || "网络错误" }),
                    ontimeout: () => resolve({ ok: false, status: 0, json: null, text: "", error: "超时" })
                });
            } catch (e) {
                resolve({ ok: false, status: 0, json: null, text: "", error: String(e.message || e) });
            }
        });
    }

    /** 探测服务器在线：GET /api/status（公开接口，无需登录） */
    async function probeServer(url) {
        const base = String(url || "").trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(base)) return { ok: false, error: "地址无效" };
        const r = await gmRequest("GET", base + "/api/status", undefined, 4000);
        if (r.ok && r.json && r.json.ok) return { ok: true, status: r.json, base };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), base };
    }

    /** 通过 WebRTC 获取本机局域网 IPv4 列表（探测网段用） */
    function getLocalIPs() {
        return new Promise((resolve) => {
            const ips = new Set();
            let done = false;
            const finish = () => { if (!done) { done = true; resolve([...ips]); } };
            try {
                const pc = new (window.RTCPeerConnection || window.webkitRTCPeerConnection)({ iceServers: [] });
                pc.createDataChannel("");
                pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
                pc.onicecandidate = (e) => {
                    if (!e.candidate) { try { pc.close(); } catch (_) {} finish(); return; }
                    const m = (e.candidate.candidate || "").match(/(\d+\.\d+\.\d+\.\d+)/);
                    if (m) ips.add(m[1]);
                };
                setTimeout(() => { try { pc.close(); } catch (_) {} finish(); }, 1500);
            } catch (_) { finish(); }
        });
    }

    function isPrivateIP(ip) {
        const p = (ip || "").split(".").map(Number);
        if (p.length !== 4) return false;
        if (p[0] === 10) return true;
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        return false;
    }

    /** 局域网扫描：本机 IP 推导 /24 网段 → 候选端口 → 探测 /api/status */
    async function scanLan(onProgress) {
        const localIPs = await getLocalIPs();
        const subnets = [...new Set(localIPs.filter(isPrivateIP).map((ip) => ip.split(".").slice(0, 3).join(".")))];
        if (subnets.length === 0) subnets.push("10.10.10", "192.168.1", "192.168.0", "10.0.0"); // 兜底常见网段
        const candidates = [];
        for (const sub of subnets) {
            for (let i = 1; i <= 254; i++) {
                for (const p of SCAN_PORTS) candidates.push(`http://${sub}.${i}:${p}`);
            }
        }
        const found = [];
        const CONC = 16;
        let idx = 0;
        const worker = async () => {
            while (idx < candidates.length) {
                const url = candidates[idx++];
                const r = await probeServer(url);
                if (r.ok) found.push({ base: url, status: r.status });
                if (onProgress) onProgress({ scanned: idx, total: candidates.length, found: found.length });
            }
        };
        await Promise.all(Array.from({ length: CONC }, worker));
        return { found, scanned: candidates.length };
    }

    /** 当前视频完整链接（无则返回 ""） */
    function currentVideoUrl() {
        try {
            const m = location.pathname.match(/\/(?:video|v)\/([\w-]+)/i);
            if (!m) return "";
            return location.origin + "/video/" + m[1];
        } catch (_) { return ""; }
    }

    /** 发送视频链接到服务器 /api/download（服务端自动提取 ID 并加入下载任务） */
    async function sendVideoToServer(serverBase, videoUrl) {
        const r = await gmRequest("POST", serverBase + "/api/download", { items: [videoUrl] }, 12000);
        if (r.ok && r.json && r.json.ok) return { ok: true, total: r.json.total || 1 };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
    }

    /** 复制（GM_setClipboard 优先，降级 navigator.clipboard） */
    function copyText(text, okMsg) {
        return new Promise((resolve) => {
            function notify(msg) {
                try { if (typeof GM_notification === "function") GM_notification({ text: msg, title: "🎫 Iwara 凭证", timeout: 5000 }); } catch (_) {}
            }
            try {
                if (typeof GM_setClipboard === "function") {
                    GM_setClipboard(text, { type: "text", mimetype: "text/plain" });
                    notify(okMsg);
                    resolve(true);
                    return;
                }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(() => { notify(okMsg); resolve(true); }, () => resolve(false));
                    return;
                }
            } catch (_) {}
            resolve(false);
        });
    }

    /* ---------- UI ---------- */
    function injectStyle() {
        const style = document.createElement("style");
        style.textContent = `
#iwcred-badge{position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(47,111,237,.92);color:#fff;
  font:11px/1 system-ui,sans-serif;padding:5px 8px;border-radius:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
#iwcred-fab{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:56px;height:56px;border-radius:50%;
  background:#2f6fed;color:#fff;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);
  -webkit-tap-highlight-color:transparent}
#iwcred-panel{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:80vh;overflow:auto;
  background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.3);
  font:14px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#222;padding:0 0 16px}
#iwcred-head{position:sticky;top:0;background:#fff;padding:12px 16px;border-bottom:1px solid #eef1f5;
  display:flex;align-items:center;justify-content:space-between}
#iwcred-close{font-size:20px;color:#8a94a3;cursor:pointer;padding:0 6px}
#iwcred-body{padding:12px 16px}
#iwcred-body label{display:block;font-size:12px;color:#5a6472;margin:10px 0 4px}
#iwcred-body textarea{width:100%;box-sizing:border-box;resize:none;padding:8px;border:1px solid #c9cfd8;
  border-radius:8px;font:11px/1.5 ui-monospace,Consolas,monospace;background:#fafbfc;color:#222;overflow:auto}
#iwcred-cookie{height:80px}
#iwcred-token,#iwcred-atoken{height:48px}
#iwcred-btns{display:flex;flex-direction:column;gap:8px;margin-top:12px}
#iwcred-btns button{width:100%;padding:12px;border:none;border-radius:10px;cursor:pointer;font-size:15px;font-weight:600}
#iwcred-copy-all{background:#2f6fed;color:#fff}
#iwcred-copy-cookie{background:#eef4ff;color:#2f6fed;border:1px solid #c9dcff!important}
#iwcred-status{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
#iwcred-status.ok{color:#1a9d4b}
#iwcred-status.err{color:#d0392f}
#iwcred-info{margin-top:6px;padding:10px;background:#f7f9fc;border-radius:8px;font-size:13px;color:#5a6472}
#iwcred-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;
  background:rgba(20,24,30,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;
  max-width:86vw;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);display:none}
/* ---- 发送到服务器 ---- */
#iwcred-server-row{display:flex;gap:6px;margin-top:4px}
#iwcred-server{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#iwcred-send{background:#1a9d4b;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;
  font-weight:600;white-space:nowrap;font-size:13px}
#iwcred-send:disabled{background:#9cc9ac;cursor:wait}
#iwcred-srv-actions{display:flex;gap:8px;margin-top:8px}
#iwcred-srv-actions button{flex:1;padding:8px;border-radius:8px;cursor:pointer;font-size:13px}
#iwcred-scan{background:#f4f1de;color:#7a6a1f;border:1px solid #d9cd8a}
#iwcred-save{background:#eef4ff;color:#2f6fed;border:1px solid #c9dcff}
#iwcred-srv-status{margin-top:8px;font-size:13px;min-height:18px;color:#5a6472}
#iwcred-srv-status.ok{color:#1a9d4b}
#iwcred-srv-status.err{color:#d0392f}
#iwcred-srv-status.info{color:#2f6fed}
#iwcred-srv-list{margin-top:8px}
.iwcred-srv-item{display:flex;align-items:center;justify-content:space-between;gap:8px;
  background:#f7f9fc;border:1px solid #e3e8ef;border-radius:8px;padding:8px 10px;margin-bottom:6px}
.iwcred-srv-item b{font-size:13px;color:#222;word-break:break-all}
.iwcred-srv-item button{background:#1a9d4b;color:#fff;border:none;border-radius:6px;padding:6px 10px;
  cursor:pointer;font-size:12px;white-space:nowrap}
`;
        document.head.appendChild(style);
    }

    let fabEl, panelEl, badgeEl, toastEl;

    function ensureUi() {
        if (!document.body) return false;
        if (!badgeEl || !document.body.contains(badgeEl)) {
            badgeEl = document.createElement("div");
            badgeEl.id = "iwcred-badge";
            badgeEl.textContent = "🎫 v" + VER;
            badgeEl.title = "点我打开凭证面板";
            document.body.appendChild(badgeEl);
            badgeEl.addEventListener("click", showPanel);
        }
        if (!fabEl || !document.body.contains(fabEl)) {
            fabEl = document.createElement("button");
            fabEl.id = "iwcred-fab";
            fabEl.textContent = "🎫";
            fabEl.title = "获取 iwara Cookie/Token";
            document.body.appendChild(fabEl);
            fabEl.addEventListener("click", showPanel);
        }
        if (!panelEl || !document.body.contains(panelEl)) {
            panelEl = document.createElement("div");
            panelEl.id = "iwcred-panel";
            panelEl.innerHTML = `
<div id="iwcred-head"><b>🎫 Iwara 凭证 + 发送到服务器</b><span id="iwcred-close">✕</span></div>
<div id="iwcred-body">
  <label>服务器（📤 把当前视频推给服务器下载）</label>
  <div id="iwcred-server-row">
    <input id="iwcred-server" placeholder="http://IP:端口（如 http://192.168.1.8:8643）" spellcheck="false">
    <button id="iwcred-send">📤 发送</button>
  </div>
  <div id="iwcred-srv-actions">
    <button id="iwcred-scan">🔍 扫描局域网</button>
    <button id="iwcred-save">💾 记住地址</button>
  </div>
  <div id="iwcred-srv-status"></div>
  <div id="iwcred-srv-list"></div>
  <label>完整 Cookie（含 cf_clearance，GM_cookie 读取）</label>
  <textarea id="iwcred-cookie" readonly spellcheck="false"></textarea>
  <label>refresh_token</label>
  <textarea id="iwcred-token" readonly spellcheck="false"></textarea>
  <label>access_token</label>
  <textarea id="iwcred-atoken" readonly spellcheck="false"></textarea>
  <div id="iwcred-btns">
    <button id="iwcred-copy-all">📋 复制全部（粘贴到服务器设置页即可）</button>
    <button id="iwcred-copy-cookie">📋 仅复制 Cookie</button>
  </div>
  <div id="iwcred-status"></div>
  <div id="iwcred-info"></div>
</div>`;
            document.body.appendChild(panelEl);
            panelEl.querySelector("#iwcred-close").addEventListener("click", () => { panelEl.style.display = "none"; });
            panelEl.querySelector("#iwcred-copy-all").addEventListener("click", async () => {
                const p = await buildPayload();
                copyText(p, "✅ 已复制全部凭证").then((ok) => setStatus(ok ? "✅ 已复制全部（Cookie+Token）" : "❌ 复制失败", ok ? "ok" : "err"));
            });
            panelEl.querySelector("#iwcred-copy-cookie").addEventListener("click", async () => {
                const c = await readCookieGM();
                copyText(c.text, "✅ 已复制 Cookie").then((ok) => setStatus(ok ? "✅ 已复制 Cookie" : "❌ 复制失败", ok ? "ok" : "err"));
            });
            // ---- 发送到服务器 ----
            panelEl.querySelector("#iwcred-send").addEventListener("click", srvSendFlow);
            panelEl.querySelector("#iwcred-scan").addEventListener("click", srvScanFlow);
            panelEl.querySelector("#iwcred-save").addEventListener("click", srvSaveFlow);
            panelEl.querySelector("#iwcred-server").addEventListener("keydown", (e) => {
                if (e.key === "Enter") srvSendFlow();
            });
        }
        if (!toastEl || !document.body.contains(toastEl)) {
            toastEl = document.createElement("div");
            toastEl.id = "iwcred-toast";
            document.body.appendChild(toastEl);
        }
        return true;
    }

    function showPanel() {
        if (!ensureUi()) return;
        refreshPanel().then(() => { panelEl.style.display = "block"; });
    }
    function showToast(msg) {
        if (!ensureUi()) return;
        toastEl.textContent = msg;
        toastEl.style.display = "block";
        setTimeout(() => { toastEl.style.display = "none"; }, 4000);
    }
    function setStatus(msg, cls) {
        if (!panelEl) return;
        const el = panelEl.querySelector("#iwcred-status");
        el.textContent = msg;
        el.className = cls || "";
        setTimeout(() => { el.textContent = ""; el.className = ""; }, 3500);
    }

    /* ---------- 发送到服务器：UI 辅助 ---------- */
    function srvSetStatus(msg, cls) {
        if (!panelEl) return;
        const el = panelEl.querySelector("#iwcred-srv-status");
        if (!el) return;
        el.textContent = msg;
        el.className = "srv" + (cls ? " " + cls : "");
        if (cls !== "info") setTimeout(() => { el.textContent = ""; el.className = ""; }, 6000);
    }
    function srvInput() { return panelEl ? panelEl.querySelector("#iwcred-server") : null; }
    function srvListEl() { return panelEl ? panelEl.querySelector("#iwcred-srv-list") : null; }
    function srvRenderFound(list) {
        const box = srvListEl();
        if (!box) return;
        box.innerHTML = "";
        if (!list.length) {
            box.innerHTML = '<div class="iwcred-srv-item"><b>未发现服务器</b></div>';
            return;
        }
        list.forEach((f) => {
            const row = document.createElement("div");
            row.className = "iwcred-srv-item";
            const b = document.createElement("b");
            b.textContent = f.base;
            const btn = document.createElement("button");
            btn.textContent = "使用并发送";
            btn.addEventListener("click", () => {
                const inp = srvInput();
                if (inp) inp.value = f.base;
                GM_setValue(SRV_KEY, f.base);
                srvSendFlow();
            });
            row.appendChild(b);
            row.appendChild(btn);
            box.appendChild(row);
        });
    }

    /* ---------- 发送到服务器：核心流程 ---------- */
    async function srvSendFlow() {
        if (!ensureUi()) return;
        const videoUrl = currentVideoUrl();
        const inp = srvInput();
        if (!videoUrl) {
            srvSetStatus("当前不是视频页（未匹配 /video/xxx），请打开视频页再发", "err");
            return;
        }
        let base = (inp && inp.value.trim()) || GM_getValue(SRV_KEY, "") || "";
        base = String(base).trim().replace(/\/+$/, "");
        if (!base) {
            srvSetStatus("没有服务器地址：请「扫描局域网」或手动输入", "err");
            return;
        }
        const sendBtn = panelEl.querySelector("#iwcred-send");
        if (sendBtn) sendBtn.disabled = true;
        try {
            srvSetStatus(`正在探测 ${base} 是否在线…`, "info");
            const probe = await probeServer(base);
            if (!probe.ok) {
                srvSetStatus(`服务器离线：${probe.error}。可点「扫描局域网」查找`, "err");
                if (inp) inp.value = base;
                return;
            }
            srvSetStatus(`服务器在线，正在发送视频…`, "info");
            const r = await sendVideoToServer(base, videoUrl);
            if (r.ok) {
                srvSetStatus(`✅ 已发送，服务器已添加 ${r.total} 个下载任务`, "ok");
                GM_setValue(SRV_KEY, base);
                showToast("✅ 已发送到服务器");
            } else {
                srvSetStatus(`发送失败：${r.error}`, "err");
            }
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    async function srvScanFlow() {
        if (!ensureUi()) return;
        const scanBtn = panelEl.querySelector("#iwcred-scan");
        if (scanBtn) scanBtn.disabled = true;
        try {
            srvSetStatus("正在扫描局域网（本机 IP 推导网段 + 候选端口）…", "info");
            const { found, scanned } = await scanLan((p) => {
                srvSetStatus(`扫描中… ${p.scanned}/${p.total} ｜ 已发现 ${p.found} 台`, "info");
            });
            if (found.length) {
                srvSetStatus(`扫描完成：${scanned} 个候选，发现 ${found.length} 台服务器`, "ok");
            } else {
                srvSetStatus("扫描完成，未发现可用服务器（可手动输入地址）", "err");
            }
            srvRenderFound(found);
        } finally {
            if (scanBtn) scanBtn.disabled = false;
        }
    }

    function srvSaveFlow() {
        if (!ensureUi()) return;
        const inp = srvInput();
        const base = (inp && inp.value.trim()) || "";
        if (!base) { srvSetStatus("请输入服务器地址", "err"); return; }
        GM_setValue(SRV_KEY, base);
        srvSetStatus(`已记住：${base}`, "ok");
    }

    async function refreshPanel() {
        if (!ensureUi()) return;
        const c = await readCookieGM();
        panelEl.querySelector("#iwcred-cookie").value = c.text;
        panelEl.querySelector("#iwcred-token").value = ls("token");
        panelEl.querySelector("#iwcred-atoken").value = ls("accessToken");
        const payload = parseJwt(ls("token"));
        const lines = [
            `Cookie: ${c.text.length} 字符 / ${c.count || 0} 项 ｜ 来源: ${c.source} ｜ cf_clearance: ${c.text.includes("cf_clearance") ? "✅ 有" : "❌ 无"}`,
            `refresh_token: ${ls("token") ? "✅ 有" : "未获取（可能未登录）"}`,
            `access_token: ${ls("accessToken") ? "✅ 有" : "未获取"}`
        ];
        if (payload) lines.push(`账号: ${payload.username || payload.sub || payload.id || "?"} ｜ 过期: ${payload.exp ? new Date(payload.exp * 1000).toLocaleString() : "?"}`);
        panelEl.querySelector("#iwcred-info").innerHTML = lines.join("<br>");
        // 发送到服务器：回填已保存地址并自动探测在线状态
        const saved = GM_getValue(SRV_KEY, "") || "";
        const inp = srvInput();
        if (inp && !inp.value.trim() && saved) inp.value = saved;
        if (saved) {
            const srvEl = panelEl.querySelector("#iwcred-srv-status");
            if (srvEl && !srvEl.textContent) srvEl.textContent = "正在探测已保存服务器…";
            probeServer(saved).then((p) => {
                srvSetStatus(p.ok ? `✅ 已保存服务器在线：${p.base}` : `已保存服务器离线：${p.error}`, p.ok ? "ok" : "err");
            });
        }
    }

    /* ---------- 启动 ---------- */
    try {
        injectStyle();
        ensureUi();
        log("已加载（按钮模式）");
        // 防 SPA 剥离
        setInterval(() => { ensureUi(); }, 3000);
    } catch (e) {
        log("启动异常:", e);
    }
})();