// ==UserScript==
// @name         Iwara 下载助手（Cookie + 一键发送到服务器）
// @namespace    iwara-cred
// @version      7.1.0
// @description  右下角 🎫 面板：显示当前 iwara 登录用户名、复制完整 Cookie（含 HttpOnly cf_clearance）/token；「📤 发送到服务器」把当前视频链接一键推给 iwara-downloader-server 下载（服务器自行解析；设了密码会自动用保存的密码登录）
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
 * v7.1.0
 * - 登录态展示对齐香蕉网脚本：✅ 已登录 / 👤 用户名 / 🆔 id / 🔗 主页
 * - 地址没写协议自动补 http://（10.10.10.4:28463 也能发）
 * - 发送走 POST /api/receive（服务器转发给 /api/download 自行解析）
 * - 设密码时用保存的服务器密码自动登录
 * ============================================================ */
(function () {
    "use strict";

    const VER = "7.1.0";
    const SRV_KEY = "iwcred_server";      // 服务器地址
    const SRV_PWD_KEY = "iwcred_server_pwd"; // 服务器访问密码

    /* ---------- 工具 ---------- */
    function $(sel) { return document.querySelector(sel); }
    function ls(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
    function log(...a) { try { console.log("[iwara-cred " + VER + "]", ...a); } catch (_) {} }

    /** 从 GM_cookie 读取完整 cookie（含 HttpOnly）。返回 { text, count, source } */
    function readCookieGM() {
        return new Promise((resolve) => {
            const fallback = () => resolve({ text: document.cookie || "", count: 0, source: "document.cookie" });
            try {
                if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.list === "function") {
                    GM_cookie.list({}, (cookies, error) => {
                        if (error) { log("GM_cookie.list error:", error); return fallback(); }
                        if (!Array.isArray(cookies) || cookies.length === 0) return fallback();
                        const iw = cookies.filter((c) => c && c.domain && String(c.domain).indexOf("iwara.tv") >= 0);
                        const list = (iw.length > 0 ? iw : cookies)
                            .map((c) => (c && c.name) ? c.name + "=" + (c.value || "") : "")
                            .filter(Boolean);
                        const text = list.join("; ");
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

    function unwrapUser(raw) {
        if (!raw) return null;
        if (raw.user && (raw.user.id || raw.user.username || raw.user.name)) return raw.user;
        if (raw.id || raw.username || raw.name) return raw;
        return null;
    }

    /** 当前 iwara 登录用户（调 api.iwara.tv/user；accessToken 失效则用 refresh_token 刷新后再取） */
    async function fetchIwaraUser() {
        const c = await readCookieGM();
        let accessToken = ls("accessToken");
        const refresh = ls("token");
        const headersOf = (acc) => {
            const h = {};
            if (c.text) h["Cookie"] = c.text;
            if (acc) h["Authorization"] = "Bearer " + acc;
            return h;
        };
        let r = await gmRequest("GET", "https://api.iwara.tv/user", undefined, 10000, headersOf(accessToken));
        if ((!r.ok || r.status === 401) && refresh) {
            const tok = await gmRequest("POST", "https://api.iwara.tv/user/token", {}, 8000, {
                Authorization: "Bearer " + refresh,
                Cookie: c.text || ""
            });
            const acc = tok.json && tok.json.accessToken;
            if (acc) {
                accessToken = acc;
                try { localStorage.setItem("accessToken", acc); } catch (_) {}
                r = await gmRequest("GET", "https://api.iwara.tv/user", undefined, 10000, headersOf(acc));
            }
        }
        if (r.ok && r.json) {
            const u = unwrapUser(r.json);
            const username = (u && (u.username || u.name)) || "";
            const id = (u && u.id) || "";
            const name = (u && (u.name || u.username)) || username;
            return { ok: true, loggedIn: true, username, name, id, profileUrl: username ? ("https://www.iwara.tv/profile/" + username) : "" };
        }
        if (refresh) return { ok: true, loggedIn: true, username: "", name: "", id: "", tokenOnly: true };
        return { ok: false, loggedIn: false };
    }

    /* ============================================================
     * 发送到服务器
     * ============================================================ */
    function gmRequest(method, url, body, timeout, extraHeaders) {
        return new Promise((resolve) => {
            try {
                if (typeof GM_xmlhttpRequest !== "function") {
                    return resolve({ ok: false, error: "无 GM_xmlhttpRequest 权限" });
                }
                GM_xmlhttpRequest({
                    method,
                    url,
                    timeout: timeout || 8000,
                    data: body !== undefined ? JSON.stringify(body) : undefined,
                    headers: Object.assign(body !== undefined ? { "Content-Type": "application/json" } : {}, extraHeaders || {}),
                    onload: (r) => {
                        let j = null;
                        try { j = JSON.parse(r.responseText); } catch (_) {}
                        let setCookie = "";
                        try {
                            const hdrs = r.responseHeaders || "";
                            const m = hdrs.match(/Set-Cookie:\s*session=([^;\s]+)/i);
                            if (m) setCookie = m[1];
                        } catch (_) {}
                        resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: j, text: r.responseText, error: "", setCookie });
                    },
                    onerror: (r) => resolve({ ok: false, status: r.status, json: null, text: "", error: r.error || "网络错误" }),
                    ontimeout: () => resolve({ ok: false, status: 0, json: null, text: "", error: "超时" })
                });
            } catch (e) {
                resolve({ ok: false, status: 0, json: null, text: "", error: String(e.message || e) });
            }
        });
    }

    /** 规范化服务器地址：没写协议就补 http://；去掉末尾 / */
    function normalizeServerBase(url) {
        let s = String(url || "").trim();
        if (!s) return "";
        s = s.replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(s)) s = "http://" + s;
        return s;
    }

    /** 探测服务器在线：GET /api/status（公开，返回 needsAuth/port） */
    async function probeServer(url) {
        const base = normalizeServerBase(url);
        if (!base) return { ok: false, error: "地址无效", base };
        const r = await gmRequest("GET", base + "/api/status", undefined, 4000);
        if (r.ok && r.json && r.json.ok) return { ok: true, status: r.json, base };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), base };
    }

    /** 服务器自动登录：POST /api/login，返回 session token */
    async function serverLogin(base, password) {
        const r = await gmRequest("POST", base + "/api/login", { password }, 8000);
        if (r.ok && r.setCookie) return { ok: true, session: r.setCookie };
        if (r.status === 401) return { ok: false, error: "密码错误（服务器访问密码不对）" };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
    }

    /** 发送视频链接到服务器 /api/receive（服务端自行解析下载；可携带 session） */
    async function sendVideoToServer(base, videoUrl, session) {
        const headers = session ? { "Cookie": "session=" + session } : {};
        const r = await gmRequest("POST", base + "/api/receive", { url: videoUrl }, 12000, headers);
        if (r.ok && r.json && r.json.ok) return { ok: true, total: r.json.received || r.json.total || 1, status: r.status };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), status: r.status };
    }

    /** 当前视频链接（非视频页返回 ""） */
    function currentVideoUrl() {
        try {
            const m = location.pathname.match(/\/(?:video|v)\/([\w-]+)/i);
            if (!m) return "";
            return location.origin + "/video/" + m[1];
        } catch (_) { return ""; }
    }

    /** 复制 */
    function copyText(text, okMsg) {
        return new Promise((resolve) => {
            function notify(msg) {
                try { if (typeof GM_notification === "function") GM_notification({ text: msg, title: "🎫 Iwara 凭证", timeout: 5000 }); } catch (_) {}
            }
            try {
                if (typeof GM_setClipboard === "function") {
                    GM_setClipboard(text, { type: "text", mimetype: "text/plain" });
                    notify(okMsg); resolve(true); return;
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
#iwcred-userbar{margin:10px 16px 0;padding:12px 16px;background:#f0f7ff;border-radius:10px;
  font-size:14px;color:#1a3d6d;white-space:pre-wrap;line-height:1.6}
#iwcred-userbar.ok{background:#e8f7ee;color:#1a7a3a}
#iwcred-userbar.err{background:#fdecea;color:#b3392b}
#iwcred-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;
  background:rgba(20,24,30,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;
  max-width:86vw;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);display:none}
#iwcred-server-row{display:flex;gap:6px;margin-top:4px}
#iwcred-server{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#iwcred-pwd-row{display:flex;gap:6px;margin-top:4px}
#iwcred-server-pwd{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#iwcred-send{background:#1a9d4b;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;
  font-weight:600;white-space:nowrap;font-size:13px}
#iwcred-send:disabled{background:#9cc9ac;cursor:wait}
#iwcred-srv-actions{display:flex;gap:8px;margin-top:8px}
#iwcred-srv-actions button{flex:1;padding:8px;border-radius:8px;cursor:pointer;font-size:13px}
#iwcred-save{background:#eef4ff;color:#2f6fed;border:1px solid #c9dcff}
#iwcred-srv-status{margin-top:8px;font-size:13px;min-height:18px;color:#5a6472}
#iwcred-srv-status.ok{color:#1a9d4b}
#iwcred-srv-status.err{color:#d0392f}
#iwcred-srv-status.info{color:#2f6fed}
`;
        document.head.appendChild(style);
    }

    let fabEl, panelEl, toastEl;

    function ensureUi() {
        if (!document.body) return false;
        if (!fabEl || !document.body.contains(fabEl)) {
            fabEl = document.createElement("button");
            fabEl.id = "iwcred-fab";
            fabEl.textContent = "🎫";
            fabEl.title = "Iwara 下载助手";
            document.body.appendChild(fabEl);
            fabEl.addEventListener("click", showPanel);
        }
        if (!panelEl || !document.body.contains(panelEl)) {
            panelEl = document.createElement("div");
            panelEl.id = "iwcred-panel";
            panelEl.innerHTML = `
<div id="iwcred-head"><b>🎫 Iwara 下载助手</b><span id="iwcred-close">✕</span></div>
<div id="iwcred-userbar" class="err">正在检测…</div>
<div id="iwcred-body">
  <label>📤 发送到服务器（当前视频链接 → 服务器自行解析下载）</label>
  <div id="iwcred-server-row">
    <input id="iwcred-server" placeholder="http://IP:端口（如 http://10.10.10.4:28463）" spellcheck="false">
    <button id="iwcred-send">📤 发送</button>
  </div>
  <label style="margin-top:6px">服务器访问密码（可选；设了密码的服务器自动登录用，记在本地）</label>
  <div id="iwcred-pwd-row">
    <input id="iwcred-server-pwd" type="password" placeholder="服务器访问密码（留空则尝试免登录）" autocomplete="off">
  </div>
  <div id="iwcred-srv-actions">
    <button id="iwcred-save">💾 记住地址</button>
  </div>
  <div id="iwcred-srv-status"></div>
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
            panelEl.style.display = "none";
            panelEl.querySelector("#iwcred-close").addEventListener("click", () => { panelEl.style.display = "none"; });
            panelEl.querySelector("#iwcred-copy-all").addEventListener("click", async () => {
                const p = await buildPayload();
                copyText(p, "✅ 已复制全部凭证").then((ok) => setStatus(ok ? "✅ 已复制全部（Cookie+Token）" : "❌ 复制失败", ok ? "ok" : "err"));
            });
            panelEl.querySelector("#iwcred-copy-cookie").addEventListener("click", async () => {
                const c = await readCookieGM();
                copyText(c.text, "✅ 已复制 Cookie").then((ok) => setStatus(ok ? "✅ 已复制 Cookie" : "❌ 复制失败", ok ? "ok" : "err"));
            });
            panelEl.querySelector("#iwcred-send").addEventListener("click", srvSendFlow);
            panelEl.querySelector("#iwcred-save").addEventListener("click", srvSaveFlow);
            panelEl.querySelector("#iwcred-server").addEventListener("keydown", (e) => { if (e.key === "Enter") srvSendFlow(); });
            panelEl.querySelector("#iwcred-server-pwd").addEventListener("keydown", (e) => { if (e.key === "Enter") srvSendFlow(); });
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
    function srvSetStatus(msg, cls) {
        if (!panelEl) return;
        const el = panelEl.querySelector("#iwcred-srv-status");
        if (!el) return;
        el.textContent = msg;
        el.className = "srv" + (cls ? " " + cls : "");
        if (cls !== "info") setTimeout(() => { el.textContent = ""; el.className = ""; }, 6000);
    }
    function srvInput() { return panelEl ? panelEl.querySelector("#iwcred-server") : null; }

    /* ---------- 发送到服务器 ---------- */
    async function srvSendFlow() {
        if (!ensureUi()) return;
        const videoUrl = currentVideoUrl();
        const inp = srvInput();
        if (!videoUrl) {
            srvSetStatus("当前不是视频页（未匹配 /video/xxx），请打开视频页再发", "err");
            return;
        }
        let base = normalizeServerBase((inp && inp.value.trim()) || GM_getValue(SRV_KEY, "") || "");
        if (!base) {
            srvSetStatus("没有服务器地址：请手动输入（如 10.10.10.4:28463 或 http://10.10.10.4:28463）", "err");
            return;
        }
        if (inp) inp.value = base;
        const sendBtn = panelEl.querySelector("#iwcred-send");
        if (sendBtn) sendBtn.disabled = true;
        try {
            srvSetStatus(`正在探测 ${base} 是否在线…`, "info");
            const probe = await probeServer(base);
            if (!probe.ok) {
                srvSetStatus(`服务器离线：${probe.error}`, "err");
                if (inp) inp.value = base;
                return;
            }
            let session = "";
            if (probe.status && probe.status.needsAuth) {
                const pwdInput = panelEl.querySelector("#iwcred-server-pwd");
                let pwd = (pwdInput && pwdInput.value) || GM_getValue(SRV_PWD_KEY, "") || "";
                pwd = String(pwd || "");
                if (!pwd) {
                    srvSetStatus("⚠️ 服务器设有访问密码：请在下方输入服务器访问密码（仅存本地，用于自动登录）", "err");
                    if (inp) inp.value = base;
                    return;
                }
                srvSetStatus("服务器设有密码，正在自动登录…", "info");
                const lg = await serverLogin(base, pwd);
                if (!lg.ok) {
                    srvSetStatus("自动登录失败：" + lg.error, "err");
                    if (inp) inp.value = base;
                    return;
                }
                session = lg.session;
                if (pwdInput) { pwdInput.value = pwd; GM_setValue(SRV_PWD_KEY, pwd); }
            }
            srvSetStatus(`服务器在线（端口 ${probe.status.port || "?"}），正在发送视频…`, "info");
            const r = await sendVideoToServer(base, videoUrl, session);
            if (r.ok) {
                srvSetStatus(`✅ 已发送，服务器已添加 ${r.total} 个下载任务`, "ok");
                GM_setValue(SRV_KEY, base);
                showToast("✅ 已发送到服务器");
            } else if (r.status === 401) {
                srvSetStatus("发送失败：未登录（401）。请检查服务器访问密码", "err");
            } else {
                srvSetStatus(`发送失败：${r.error}`, "err");
            }
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    function srvSaveFlow() {
        if (!ensureUi()) return;
        const inp = srvInput();
        const base = normalizeServerBase((inp && inp.value.trim()) || "");
        if (!base) { srvSetStatus("请输入服务器地址", "err"); return; }
        if (inp) inp.value = base;
        GM_setValue(SRV_KEY, base);
        const pwdInput = panelEl.querySelector("#iwcred-server-pwd");
        if (pwdInput && pwdInput.value.trim()) GM_setValue(SRV_PWD_KEY, pwdInput.value.trim());
        srvSetStatus(`已记住：${base}${(pwdInput && pwdInput.value.trim()) ? "（含密码）" : ""}`, "ok");
    }

    /* ---------- 面板刷新 ---------- */
    async function refreshPanel() {
        if (!ensureUi()) return;
        const c = await readCookieGM();
        panelEl.querySelector("#iwcred-cookie").value = c.text;
        panelEl.querySelector("#iwcred-token").value = ls("token");
        panelEl.querySelector("#iwcred-atoken").value = ls("accessToken");

        const userbar = panelEl.querySelector("#iwcred-userbar");
        const u = await fetchIwaraUser().catch(() => null);
        const L = [];
        if (u && u.loggedIn) {
            L.push("✅ 已登录");
            L.push("👤 用户名: " + (u.username || u.name || "(未取到)"));
            if (u.id) L.push("🆔 用户 id: " + u.id);
            if (u.profileUrl) L.push("🔗 " + u.profileUrl);
            if (u.tokenOnly && !u.username) L.push("（access_token 刷新后仍未取到用户名）");
            userbar.className = "ok";
        } else {
            L.push("❌ 未登录");
            L.push("登录 iwara 后可用完整凭证");
            userbar.className = "err";
        }
        L.push("───");
        L.push("GM_cookie 诊断: " + (c.source === "GM_cookie" ? ("GM_cookie 读取 " + (c.count || 0) + " 项") : (c.source === "document.cookie" ? "GM_cookie 未定义（请用 Violentmonkey 或 Firefox Tampermonkey）" : String(c.source || "?"))));
        L.push("完整 Cookie: " + c.text.length + " 字符 / " + (c.count || 0) + " 项 ｜ 来源: " + c.source);
        L.push("含 cf_clearance: " + (c.text.indexOf("cf_clearance") >= 0 ? "✅ 有" : "❌ 无"));
        L.push("refresh_token: " + (ls("token") ? "✅ 有" : "❌ 无"));
        L.push("access_token: " + (ls("accessToken") ? "✅ 有" : "❌ 无"));
        userbar.textContent = L.join("\n");
        panelEl.querySelector("#iwcred-info").textContent = "如果 GM_cookie 诊断显示『未定义/0 个』：请用 Violentmonkey 或 Firefox 的 Tampermonkey，并给脚本开启 cookie 权限后重试。";

        // 回填服务器地址/密码 + 探测
        const saved = normalizeServerBase(GM_getValue(SRV_KEY, "") || "");
        const inp = srvInput();
        if (inp && !inp.value.trim() && saved) inp.value = saved;
        const pwdInput = panelEl.querySelector("#iwcred-server-pwd");
        const savedPwd = GM_getValue(SRV_PWD_KEY, "") || "";
        if (pwdInput && !pwdInput.value.trim() && savedPwd) pwdInput.value = savedPwd;
        if (saved) {
            const srvEl = panelEl.querySelector("#iwcred-srv-status");
            if (srvEl && !srvEl.textContent) srvEl.textContent = "正在探测已保存服务器…";
            probeServer(saved).then((p) => {
                if (p.ok && p.status && p.status.needsAuth) {
                    srvSetStatus(savedPwd ? `已保存服务器在线（设有密码，已存密码，发送时自动登录）：${p.base}` : "已保存服务器在线，但设有密码：请填写服务器访问密码后发送", savedPwd ? "ok" : "err");
                } else {
                    srvSetStatus(p.ok ? `✅ 已保存服务器在线：${p.base}` : `已保存服务器离线：${p.error}`, p.ok ? "ok" : "err");
                }
            });
        }
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[ch]));
    }

    /* ---------- 启动 ---------- */
    try {
        injectStyle();
        ensureUi();
        log("已加载（v7 按钮模式）");
        setInterval(() => { ensureUi(); }, 3000);
    } catch (e) {
        log("启动异常:", e);
    }
})();
