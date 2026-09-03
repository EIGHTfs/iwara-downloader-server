// ==UserScript==
// @name         Iwara 下载助手（Cookie + 一键发送到服务器）
// @namespace    iwara-cred
// @version      7.6.0
// @description  SPA 换页不重载；服务器地址 GM+localStorage 双写，打开必回填。
// @author       fnOS
// @match        https://www.iwara.tv/*
// @match        https://iwara.tv/*
// @match        https://ecchi.iwara.tv/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_cookie.list
// @grant        GM_cookie.set
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

/* ============================================================
 * Iwara 下载助手（油猴）
 *
 * 职责分工：
 *   0. Iwara 是 SPA：脚本只在整页刷新时注入一次。UI 挂在 <html> 上，
 *      换视频/换页不重建、不重拉账号（账号缓存 5 分钟）
 *   1. 点右下角图标立刻弹出面板（同步，不读 Cookie、不发请求）
 *   2. 后台 GET {服务器}/api/account-check
 *      - 能读到 = 服务器在线
 *      - 返回的用户名/id/到期提醒就是网页「检测登录状态」那串
 *   3. 服务器已登录：面板只留「发送视频 + 账号信息」，不展示本机 Cookie/Token
 *   4. 服务器没有凭证：才 GM_cookie 采集，POST /api/settings 回传保存
 *   5. 发送视频：只 POST /api/receive { url }，服务器自己解析下载，不读 Cookie
 *
 * Chrome Tampermonkey 没有 GM_cookie，读不到 HttpOnly 的 cf_clearance。
 * 需要完整 Cookie 时请用 Violentmonkey 或 Firefox Tampermonkey。
 * ============================================================ */
(function () {
    "use strict";

    const VER = "7.6.0";
    const ACCOUNT_TTL_MS = 5 * 60 * 1000; // 换页不重复打 /api/account-check
    const SRV_SESSION_KEY = "iwcred_server_session";
    const IWARA_ICON = "data:image/png;base64,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";
    const LOGIN_WARN_DAYS = 7;
    const SRV_KEY = "iwcred_server";
    const SRV_PWD_KEY = "iwcred_server_pwd";
    // 用户原话「填写和读取分离…添加后的服务端用下拉列表展示选择，不能被修改只能删除」
    const SRV_LIST_KEY = "iwcred_server_list";
    const COOKIE_CACHE_KEY = "iwcred_cookie_cache";
    const USER_CACHE_KEY = "iwcred_user_cache";
    const SKEW_MS = 60 * 1000; // 提前 1 分钟视为过期

    function ls(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
    function log(...a) { try { console.log("[iwara-cred " + VER + "]", ...a); } catch (_) {} }

    /** 解析 JWT exp（秒）→ 毫秒时间戳。access_token 只有约 1 小时，登录到期看 refresh_token。 */
    function jwtExpMs(token) {
        try {
            const p = JSON.parse(atob(String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
            return p && p.exp ? p.exp * 1000 : 0;
        } catch (_) { return 0; }
    }

    function toMs(n) {
        n = Number(n) || 0;
        if (n <= 0) return 0;
        return n < 1e12 ? n * 1000 : n;
    }

    function cacheGet(key) {
        try { return GM_getValue(key, null) || null; } catch (_) { return null; }
    }
    function cacheSet(key, val) {
        try { GM_setValue(key, val); } catch (_) {}
    }

    /** 服务器地址/密码：GM 存储 + localStorage 双写。重装油猴或 GM 读失败时还能从本站 localStorage 回填。 */
    function storeGet(key) {
        try {
            if (typeof GM_getValue === "function") {
                const v = GM_getValue(key, "");
                if (v !== undefined && v !== null && String(v).trim()) return String(v);
            }
        } catch (_) {}
        try {
            const v = localStorage.getItem("iwcred:" + key);
            if (v && String(v).trim()) return String(v);
        } catch (_) {}
        return "";
    }
    function storeSet(key, val) {
        const s = String(val || "");
        try { if (typeof GM_setValue === "function") GM_setValue(key, s); } catch (_) {}
        try {
            if (s) localStorage.setItem("iwcred:" + key, s);
            else localStorage.removeItem("iwcred:" + key);
        } catch (_) {}
    }

    function normalizeServerBase(url) {
        let s = String(url || "").trim();
        if (!s) return "";
        s = s.replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(s)) s = "http://" + s;
        return s;
    }
    function loadServerList() {
        let list = [];
        try { list = JSON.parse(storeGet(SRV_LIST_KEY) || "[]"); } catch (_) { list = []; }
        if (!Array.isArray(list)) list = [];
        list = list.map((it) => ({ url: normalizeServerBase(it && it.url), password: String((it && it.password) || "") })).filter((it) => it.url);
        const seen = new Set();
        const uniq = [];
        for (const it of list) { if (seen.has(it.url)) continue; seen.add(it.url); uniq.push(it); }
        const legacy = normalizeServerBase(storeGet(SRV_KEY));
        if (legacy && !uniq.some((it) => it.url === legacy)) {
            uniq.unshift({ url: legacy, password: storeGet(SRV_PWD_KEY) });
            saveServerList(uniq);
        }
        return uniq;
    }
    function saveServerList(list) { storeSet(SRV_LIST_KEY, JSON.stringify(list || [])); }
    function currentServer() {
        const list = loadServerList();
        const sel = normalizeServerBase(storeGet(SRV_KEY));
        return list.find((it) => it.url === sel) || list[0] || null;
    }
    function fillServerSelect() {
        const sel = panelEl && panelEl.querySelector("#iwcred-server");
        if (!sel) return;
        const list = loadServerList();
        const cur = currentServer();
        sel.innerHTML = "";
        if (!list.length) {
            const o = document.createElement("option");
            o.value = ""; o.textContent = "尚未添加服务端";
            sel.appendChild(o); return;
        }
        for (const it of list) {
            const o = document.createElement("option");
            o.value = it.url; o.textContent = it.url;
            sel.appendChild(o);
        }
        sel.value = cur ? cur.url : list[0].url;
        if (cur) { storeSet(SRV_KEY, cur.url); storeSet(SRV_PWD_KEY, cur.password); }
    }
    function addServerFromForm() {
        const url = normalizeServerBase(panelEl.querySelector("#iwcred-url-new").value);
        const password = panelEl.querySelector("#iwcred-pwd-new").value || "";
        if (!url) { srvSetStatus("请填写服务器地址", "err"); return; }
        const list = loadServerList();
        if (list.some((it) => it.url === url)) { srvSetStatus("已存在该地址", "err"); return; }
        list.push({ url, password });
        saveServerList(list);
        storeSet(SRV_KEY, url);
        storeSet(SRV_PWD_KEY, password);
        panelEl.querySelector("#iwcred-add-form").style.display = "none";
        fillServerSelect();
        srvSetStatus("已添加 " + url, "ok");
        showPanel();
    }
    function deleteSelectedServer() {
        const sel = panelEl.querySelector("#iwcred-server");
        const url = sel && sel.value;
        if (!url) { srvSetStatus("没有可删除的服务端", "err"); return; }
        const list = loadServerList().filter((it) => it.url !== url);
        saveServerList(list);
        const next = list[0] || { url: "", password: "" };
        storeSet(SRV_KEY, next.url);
        storeSet(SRV_PWD_KEY, next.password);
        fillServerSelect();
        srvSetStatus("已删除 " + url, "ok");
        showPanel();
    }

    /** Cookie 缓存是否仍有效（提前 SKEW_MS 视为过期）。打开面板不走这里。 */
    function cookieCacheValid() {
        const c = cacheGet(COOKIE_CACHE_KEY);
        if (!c || !c.text) return false;
        const exp = Number(c.expiresAt) || 0;
        if (!exp) return false;
        return Date.now() < exp - SKEW_MS;
    }

    /** 从 GM_cookie 读取完整 cookie（含 HttpOnly）。仅在缓存过期 / 强制刷新时调用。 */
    function readCookieGM() {
        return new Promise((resolve) => {
            const fallback = () => {
                const text = document.cookie || "";
                const tokenExp = jwtExpMs(ls("token"));
                resolve({
                    text,
                    count: text ? text.split(";").filter(Boolean).length : 0,
                    source: "document.cookie",
                    expiresAt: tokenExp || (Date.now() + 6 * 3600 * 1000),
                    fetchedAt: Date.now()
                });
            };
            try {
                if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.list === "function") {
                    GM_cookie.list({}, (cookies, error) => {
                        if (error) { log("GM_cookie.list error:", error); return fallback(); }
                        if (!Array.isArray(cookies) || cookies.length === 0) return fallback();
                        const iw = cookies.filter((c) => c && c.domain && String(c.domain).indexOf("iwara.tv") >= 0);
                        const listSrc = iw.length > 0 ? iw : cookies;
                        const list = listSrc
                            .map((c) => (c && c.name) ? c.name + "=" + (c.value || "") : "")
                            .filter(Boolean);
                        const text = list.join("; ");
                        const exps = listSrc.map((c) => toMs(c && c.expirationDate)).filter((n) => n > Date.now());
                        const cf = listSrc.find((c) => c && c.name === "cf_clearance");
                        const cfExp = toMs(cf && cf.expirationDate);
                        const tokenExp = jwtExpMs(ls("token"));
                        let expiresAt = 0;
                        if (cfExp) expiresAt = cfExp;
                        else if (exps.length) expiresAt = Math.min.apply(null, exps);
                        else if (tokenExp) expiresAt = tokenExp;
                        else expiresAt = Date.now() + 6 * 3600 * 1000;
                        resolve({
                            text,
                            count: text ? text.split("; ").length : 0,
                            source: "GM_cookie",
                            expiresAt,
                            fetchedAt: Date.now()
                        });
                    });
                    return;
                }
            } catch (e) { log("GM_cookie exception:", e); }
            fallback();
        });
    }

    /** 仅复制/回传/服务器没凭证时调用。force=true 无视缓存。 */
    async function getCookieCached(force) {
        if (!force && cookieCacheValid()) return cacheGet(COOKIE_CACHE_KEY);
        const fresh = await readCookieGM();
        cacheSet(COOKIE_CACHE_KEY, fresh);
        return fresh;
    }

    async function buildPayload() {
        let c = cacheGet(COOKIE_CACHE_KEY);
        if (!c || !c.text) c = await getCookieCached(true);
        return [
            "Cookie=" + (c && c.text || ""),
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

    async function fetchIwaraUser(cookieText) {
        let accessToken = ls("accessToken");
        const refresh = ls("token");
        const headersOf = (acc) => {
            const h = {};
            if (cookieText) h["Cookie"] = cookieText;
            if (acc) h["Authorization"] = "Bearer " + acc;
            return h;
        };
        let r = await gmRequest("GET", "https://api.iwara.tv/user", undefined, 10000, headersOf(accessToken));
        if ((!r.ok || r.status === 401) && refresh) {
            const tok = await gmRequest("POST", "https://api.iwara.tv/user/token", {}, 8000, {
                Authorization: "Bearer " + refresh,
                Cookie: cookieText || ""
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

    /** GET /api/status，不需要登录。用来判断 needsAuth。 */
    async function probeServer(url) {
        const base = normalizeServerBase(url);
        if (!base) return { ok: false, error: "地址无效", base };
        const r = await gmRequest("GET", base + "/api/status", undefined, 4000);
        if (r.ok && r.json && r.json.ok) return { ok: true, status: r.json, base };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), base };
    }

    async function serverLogin(base, password) {
        const r = await gmRequest("POST", base + "/api/login", { password }, 8000);
        if (r.ok && r.setCookie) return { ok: true, session: r.setCookie };
        if (r.status === 401) return { ok: false, error: "密码错误（服务器访问密码不对）" };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
    }

    function sessionHeaders(session) {
        return session ? { Cookie: "session=" + session } : {};
    }

    /** 拿服务器 session cookie。有密码则 POST /api/login，session 缓存约 70 小时。 */
    async function ensureServerSession(base) {
        base = normalizeServerBase(base);
        if (!base) return { ok: false, error: "没有服务器地址", base: "" };
        const cached = cacheGet(SRV_SESSION_KEY);
        if (cached && cached.base === base && cached.session && Date.now() < (cached.expiresAt || 0)) {
            return { ok: true, session: cached.session, base, cached: true };
        }
        const probe = await probeServer(base);
        if (!probe.ok) return { ok: false, error: probe.error, base };
        let session = "";
        if (probe.status && probe.status.needsAuth) {
            const pwd = String((currentServer() && currentServer().password) || storeGet(SRV_PWD_KEY) || "");
            if (!pwd) return { ok: false, error: "服务器设有密码，请填写服务器访问密码", base, needsPwd: true };
            const lg = await serverLogin(base, pwd);
            if (!lg.ok) return { ok: false, error: lg.error, base };
            session = lg.session;
            cacheSet(SRV_SESSION_KEY, { base, session, expiresAt: Date.now() + 70 * 3600 * 1000 });
        }
        return { ok: true, session, base };
    }

    /** GET /api/account-check：用户信息 + 脱敏 cred。成功即证明服务器在线。 */
    async function getServerAccountCheck(base, session) {
        const r = await gmRequest("GET", base + "/api/account-check", undefined, 12000, sessionHeaders(session));
        if (r.status === 401) {
            cacheSet(SRV_SESSION_KEY, null);
            return { ok: false, status: 401, error: "服务器会话失效" };
        }
        if (r.ok && r.json) return { ok: true, data: r.json };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), status: r.status };
    }

    /** 本机 Cookie+Token 组合成设置页同款文本，POST /api/settings 存到服务器。 */
    async function pushLocalCreds(base, session) {
        const c = await getCookieCached(true);
        const body = {
            iwaraCookie: [
                "Cookie=" + (c && c.text || ""),
                "Token=" + ls("token"),
                "AccessToken=" + ls("accessToken")
            ].join("\n")
        };
        const r = await gmRequest("POST", base + "/api/settings", body, 12000, sessionHeaders(session));
        return { ok: !!(r.ok && r.json && r.json.ok), error: (r.json && r.json.error) || r.error, cookie: c };
    }

    /** 只推当前视频 URL。服务器走 /api/receive → 同一套 /api/download 解析。不读 Cookie。 */
    async function sendVideoToServer(base, videoUrl, session) {
        const headers = session ? { "Cookie": "session=" + session } : {};
        const r = await gmRequest("POST", base + "/api/receive", { url: videoUrl }, 12000, headers);
        if (r.ok && r.json && r.json.ok) return { ok: true, total: r.json.received || r.json.total || 1, status: r.status };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), status: r.status };
    }

    function currentVideoUrl() {
        try {
            const m = location.pathname.match(/\/(?:video|v)\/([\w-]+)/i);
            if (!m) return "";
            return location.origin + "/video/" + m[1];
        } catch (_) { return ""; }
    }

    function copyText(text, okMsg) {
        return new Promise((resolve) => {
            function notify(msg) {
                try { if (typeof GM_notification === "function") GM_notification({ text: msg, title: "Iwara 凭证", timeout: 5000 }); } catch (_) {}
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

    function injectStyle() {
        if (document.getElementById("iwcred-style")) return;
        const style = document.createElement("style");
        style.id = "iwcred-style";
        style.textContent = `
#iwcred-fab{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:56px;height:56px;border-radius:50%;
  padding:0;border:none;cursor:pointer;overflow:hidden;background:#fff;
  box-shadow:0 4px 16px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;pointer-events:auto}
#iwcred-fab img{width:100%;height:100%;display:block;object-fit:cover}
#iwcred-panel{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:80vh;overflow:auto;
  background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.3);
  font:14px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#222;padding:0 0 16px}
#iwcred-head{position:sticky;top:0;background:#fff;padding:12px 16px;border-bottom:1px solid #eef1f5;
  display:flex;align-items:center;justify-content:space-between;z-index:1}
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
#iwcred-refresh-cred{background:#fff;color:#5a6472;border:1px solid #c9cfd8!important;font-weight:500!important}
#iwcred-panel.server-ok #iwcred-local{display:none}
#iwcred-status{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
#iwcred-status.ok{color:#1a9d4b}
#iwcred-status.err{color:#d0392f}
#iwcred-info{margin-top:6px;padding:10px;background:#f7f9fc;border-radius:8px;font-size:13px;color:#5a6472}
#iwcred-userbar{margin:10px 16px 0;padding:12px 16px;background:#f0f7ff;border-radius:10px;
  font-size:14px;color:#1a3d6d;white-space:pre-wrap;line-height:1.6}
#iwcred-userbar.ok{background:#e8f7ee;color:#1a7a3a}
#iwcred-userbar.warn{background:#fff8e1;color:#8a5a00}
#iwcred-userbar.err{background:#fdecea;color:#b3392b}
#iwcred-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;
  background:rgba(20,24,30,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;
  max-width:86vw;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);display:none}
#iwcred-server-row{display:flex;gap:6px;margin-top:4px;align-items:center}
#iwcred-server{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#iwcred-pwd-row{display:flex;gap:6px;margin-top:4px}
#iwcred-add-form{display:none;margin-top:8px;padding:8px;background:#f7f9fc;border-radius:8px}
#iwcred-add-form input{width:100%;box-sizing:border-box;margin:4px 0;padding:8px;border:1px solid #c9cfd8;border-radius:8px}
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
        (document.head || document.documentElement).appendChild(style);
    }

    let fabEl, panelEl, toastEl;
    let credRefreshing = false;
    let lastAccount = { at: 0, data: null };
    let lastHref = "";
    let spaHooked = false;

    /** 挂到 <html>，避开 SPA 替换 <body> 把按钮带走。 */
    function uiHost() { return document.documentElement; }

    function mountUi(el) {
        const host = uiHost();
        if (!host || !el) return;
        if (el.parentNode !== host) host.appendChild(el);
    }

    function ensureUi() {
        if (!document.documentElement) return false;
        injectStyle();
        if (!fabEl || !document.documentElement.contains(fabEl)) {
            if (!fabEl) {
                fabEl = document.createElement("button");
                fabEl.id = "iwcred-fab";
                fabEl.title = "Iwara 下载助手";
                const img = document.createElement("img");
                img.src = IWARA_ICON;
                img.alt = "Iwara";
                fabEl.appendChild(img);
                fabEl.addEventListener("click", showPanel);
            }
            mountUi(fabEl);
        }
        if (!panelEl || !document.documentElement.contains(panelEl)) {
            if (!panelEl) {
                panelEl = document.createElement("div");
                panelEl.id = "iwcred-panel";
                panelEl.innerHTML = `
<div id="iwcred-head"><b>Iwara 下载助手</b><span id="iwcred-close">✕</span></div>
<div id="iwcred-userbar">打开即可发送；凭证按失效时间缓存</div>
<div id="iwcred-body">
  <label>📤 发送到服务器（当前视频链接 → 服务器自行解析下载，不读 Cookie）</label>
  <div id="iwcred-server-row">
    <select id="iwcred-server"></select>
    <button id="iwcred-send">📤 发送</button>
  </div>
  <div id="iwcred-srv-actions">
    <button id="iwcred-add">➕ 添加</button>
    <button id="iwcred-del">🗑 删除</button>
    <button id="iwcred-inject">🔄 注入登录态到浏览器</button>
  </div>
  <div id="iwcred-add-form">
    <input id="iwcred-url-new" placeholder="http://IP:端口" spellcheck="false">
    <input id="iwcred-pwd-new" type="password" placeholder="访问密码（可空）" autocomplete="off">
    <div id="iwcred-srv-actions">
      <button id="iwcred-add-ok">确认添加</button>
      <button id="iwcred-add-cancel">取消</button>
    </div>
  </div>
  <div id="iwcred-srv-status"></div>
  <div id="iwcred-local">
    <label>完整 Cookie（仅服务器没有凭证时采集；含 cf_clearance 需 GM_cookie）</label>
    <textarea id="iwcred-cookie" readonly spellcheck="false"></textarea>
    <label>refresh_token</label>
    <textarea id="iwcred-token" readonly spellcheck="false"></textarea>
    <label>access_token</label>
    <textarea id="iwcred-atoken" readonly spellcheck="false"></textarea>
    <div id="iwcred-btns">
      <button id="iwcred-copy-all">📋 复制全部（粘贴到服务器设置页即可）</button>
      <button id="iwcred-copy-cookie">📋 仅复制 Cookie</button>
      <button id="iwcred-refresh-cred">🔄 强制刷新凭证并回传</button>
    </div>
  </div>
  <div id="iwcred-status"></div>
  <div id="iwcred-info"></div>
</div>`;
                panelEl.style.display = "none";
                panelEl.classList.add("server-ok");
                panelEl.querySelector("#iwcred-close").addEventListener("click", () => { panelEl.style.display = "none"; });
                panelEl.querySelector("#iwcred-copy-all").addEventListener("click", async () => {
                    const p = await buildPayload();
                    copyText(p, "✅ 已复制全部凭证").then((ok) => setStatus(ok ? "✅ 已复制全部（Cookie+Token）" : "❌ 复制失败", ok ? "ok" : "err"));
                });
                panelEl.querySelector("#iwcred-copy-cookie").addEventListener("click", async () => {
                    let c = cacheGet(COOKIE_CACHE_KEY);
                    if (!c || !c.text) c = await getCookieCached(true);
                    copyText(c && c.text || "", "✅ 已复制 Cookie").then((ok) => setStatus(ok ? "✅ 已复制 Cookie" : "❌ 复制失败", ok ? "ok" : "err"));
                });
                panelEl.querySelector("#iwcred-refresh-cred").addEventListener("click", () => syncFromServer(true));
                panelEl.querySelector("#iwcred-send").addEventListener("click", srvSendFlow);
                panelEl.querySelector("#iwcred-add").addEventListener("click", () => {
                    panelEl.querySelector("#iwcred-add-form").style.display = "block";
                    panelEl.querySelector("#iwcred-url-new").value = "";
                    panelEl.querySelector("#iwcred-pwd-new").value = "";
                });
                panelEl.querySelector("#iwcred-add-cancel").addEventListener("click", () => {
                    panelEl.querySelector("#iwcred-add-form").style.display = "none";
                });
                panelEl.querySelector("#iwcred-add-ok").addEventListener("click", addServerFromForm);
                panelEl.querySelector("#iwcred-del").addEventListener("click", deleteSelectedServer);
                panelEl.querySelector("#iwcred-server").addEventListener("change", () => {
                    const url = panelEl.querySelector("#iwcred-server").value;
                    const hit = loadServerList().find((it) => it.url === url);
                    if (!hit) return;
                    storeSet(SRV_KEY, hit.url);
                    storeSet(SRV_PWD_KEY, hit.password);
                    showPanel();
                });
                panelEl.querySelector("#iwcred-inject").addEventListener("click", srvInjectFlow);
            }
            mountUi(panelEl);
        }
        if (!toastEl || !document.documentElement.contains(toastEl)) {
            if (!toastEl) {
                toastEl = document.createElement("div");
                toastEl.id = "iwcred-toast";
            }
            mountUi(toastEl);
        }
        return true;
    }

    function accountCacheFresh() {
        return !!(lastAccount.data && Date.now() - lastAccount.at < ACCOUNT_TTL_MS);
    }

    /** 同步弹出。网络/Cookie 全部丢到下一拍，避免点击无反馈。 */
    function showPanel() {
        if (!ensureUi()) return;
        panelEl.style.display = "block";
        try { fillInstant(); } catch (e) { log("fillInstant", e); }
        if (accountCacheFresh()) {
            renderServerAccount(lastAccount.data);
            return;
        }
        setTimeout(() => { syncFromServer(false).catch((e) => log("syncFromServer", e)); }, 0);
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

    function fmtExp(ms) {
        const n = Number(ms) || 0;
        if (!n) return "未知";
        const d = new Date(n);
        const pad = (x) => String(x).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function loginWarn(c) {
        const cookieExp = Number(c && c.expiresAt) || 0;
        const refreshExp = jwtExpMs(ls("token")) || 0;
        const expiresAt = [cookieExp, refreshExp].filter(Boolean).sort((a, b) => a - b)[0] || refreshExp || cookieExp || 0;
        if (!expiresAt) return { level: "unknown", expiresAt: 0, remainingDays: null, remainText: "" };
        const remainingMs = expiresAt - Date.now();
        const remainingDays = remainingMs / 86400000;
        let remainText = "";
        if (remainingDays <= 0) remainText = "已过期";
        else if (remainingDays < 1) remainText = "不足 1 天";
        else remainText = "剩 " + (remainingDays < 10 ? remainingDays.toFixed(1) : Math.floor(remainingDays)) + " 天";
        let level = "ok";
        if (remainingMs <= 0) level = "expired";
        else if (remainingDays <= LOGIN_WARN_DAYS) level = "warn";
        return { level, expiresAt, remainingDays, remainText };
    }

    function remainTextOf(r) {
        if (!r || r.remainingDays == null) return "";
        const d = r.remainingDays;
        if (d <= 0) return "已过期";
        if (d < 1) return "不足 1 天";
        return "剩 " + (d < 10 ? d.toFixed(1) : Math.floor(d)) + " 天";
    }

    /** 服务器已登录：隐藏本机 Cookie/Token/复制区。未登录才展开采集区。 */
    function setLocalCredVisible(show) {
        if (!panelEl) return;
        if (show) panelEl.classList.remove("server-ok");
        else panelEl.classList.add("server-ok");
    }

    function renderServerAccount(r, extra) {
        const userbar = panelEl.querySelector("#iwcred-userbar");
        const L = [];
        const cred = (r && r.cred) || {};
        const name = (r && (r.username || r.user)) || "";
        const remain = remainTextOf(r);
        const serverLoggedIn = !!(r && r.loggedIn && r.warnLevel !== "expired");
        setLocalCredVisible(!serverLoggedIn);
        if (!r) {
            L.push("❌ 未能读取服务器账号");
            userbar.className = "err";
        } else if (!r.cookieSet) {
            L.push("❌ 服务器未配置 Cookie / Token");
            userbar.className = "err";
        } else if (r.warnLevel === "expired") {
            L.push("❌ 登录已过期" + (remain ? "（" + remain + "）" : ""));
            userbar.className = "err";
        } else if (r.loggedIn) {
            L.push((r.warnLevel === "warn" ? "⚠️ 已登录" : "✅ 已登录") + (remain ? "（" + remain + "）" : ""));
            L.push("👤 用户名: " + (name || "(未取到)"));
            if (r.userId) L.push("🆔 用户 id: " + r.userId);
            if (r.username) L.push("🔗 https://www.iwara.tv/profile/" + r.username);
            if (r.warnLevel === "warn") L.push("请尽快更新凭证");
            userbar.className = r.warnLevel === "warn" ? "warn" : "ok";
        } else {
            L.push("❌ 未登录");
            if (r.error) L.push(r.error);
            if (r.cfChallenge) L.push("（需含 cf_clearance）");
            userbar.className = "err";
        }
        if (!serverLoggedIn) {
            L.push("───");
            L.push("来源: 服务器 GET /api/account-check（能读到 = 服务器在线）");
            L.push("完整 Cookie: " + (cred.cookieChars || 0) + " 字符 / " + (cred.cookieItems || 0) + " 项 ｜ 存于服务器（不回传明文）");
            L.push("含 cf_clearance: " + (cred.hasCfClearance ? "✅ 有" : "❌ 无"));
            L.push("refresh_token: " + (cred.hasToken ? "✅ 有" : "❌ 无"));
            L.push("access_token: " + (cred.hasAccessToken ? "✅ 有" : "❌ 无"));
        }
        if (extra) L.push(extra);
        userbar.textContent = L.join("\n");
        panelEl.querySelector("#iwcred-info").textContent = serverLoggedIn
            ? "服务器已登录。点发送只推当前视频链接，不读本机 Cookie。"
            : "服务器没有可用登录。下面采集本机 Cookie/Token 并回传保存。Chrome Tampermonkey 读不到 cf_clearance。";
    }

    /** 立刻填地址/密码/本机 token 框。不发请求、不读 GM_cookie。 */
    function fillInstant() {
        if (!ensureUi()) return;
        const c = cacheGet(COOKIE_CACHE_KEY);
        if (panelEl.querySelector("#iwcred-cookie")) panelEl.querySelector("#iwcred-cookie").value = (c && c.text) || "";
        panelEl.querySelector("#iwcred-token").value = ls("token");
        panelEl.querySelector("#iwcred-atoken").value = ls("accessToken");
        const userbar = panelEl.querySelector("#iwcred-userbar");
        if (userbar && !userbar.textContent) userbar.textContent = "正在从服务器读取账号…";

        fillServerSelect();
        const cur = currentServer();
        const saved = cur ? cur.url : "";
        if (saved) {
            const srvEl = panelEl.querySelector("#iwcred-srv-status");
            if (srvEl && !srvEl.textContent) srvEl.textContent = "正在从服务器读取账号…";
        }
    }

    /** 从服务器拉账号。没凭证或 forcePush=true 才本机采集并回传。 */
    async function syncFromServer(forcePush) {
        if (!ensureUi()) return;
        if (credRefreshing) return;
        if (!forcePush && accountCacheFresh()) {
            renderServerAccount(lastAccount.data);
            return;
        }
        credRefreshing = true;
        const userbar = panelEl.querySelector("#iwcred-userbar");
        try {
            const cur = currentServer();
            const base = cur ? cur.url : "";
            if (!base) {
                userbar.textContent = "没有服务器地址：点「添加」写入后再从 /api/account-check 读取登录信息";
                userbar.className = "err";
                srvSetStatus("请先添加并选择服务器", "err");
                return;
            }
            userbar.textContent = "正在从服务器读取账号（GET /api/account-check）…";
            userbar.className = "";
            const sess = await ensureServerSession(base);
            if (!sess.ok) {
                userbar.textContent = "服务器离线或无法登录：\n" + sess.error;
                userbar.className = "err";
                srvSetStatus(sess.error, "err");
                return;
            }
            srvSetStatus("✅ 服务器在线：" + sess.base, "ok");
            let chk = await getServerAccountCheck(sess.base, sess.session);
            if (!chk.ok && chk.status === 401) {
                cacheSet(SRV_SESSION_KEY, null);
                const again = await ensureServerSession(base);
                if (again.ok) chk = await getServerAccountCheck(again.base, again.session);
            }
            if (!chk.ok) {
                userbar.textContent = "读取 /api/account-check 失败：\n" + chk.error;
                userbar.className = "err";
                srvSetStatus(chk.error, "err");
                return;
            }
            const data = chk.data;
            lastAccount = { at: Date.now(), data };
            const cred = data.cred || {};
            const serverHasCred = !!(data.cookieSet || cred.hasCookie || cred.hasToken);
            if (!serverHasCred || forcePush) {
                renderServerAccount(data, forcePush ? "正在强制采集本机凭证并回传…" : "服务器没有 Cookie，正在本机采集并回传…");
                const pushed = await pushLocalCreds(sess.base, sess.session);
                if (!pushed.ok) {
                    renderServerAccount(data, "回传失败：" + (pushed.error || "未知错误"));
                    if (forcePush) setStatus("回传失败: " + (pushed.error || ""), "err");
                    return;
                }
                const chk2 = await getServerAccountCheck(sess.base, sess.session);
                if (chk2.ok) {
                    lastAccount = { at: Date.now(), data: chk2.data };
                    renderServerAccount(chk2.data, "✅ 已回传并保存到服务器");
                } else renderServerAccount(data, "✅ 已回传（再次检测失败：" + chk2.error + "）");
                if (forcePush) setStatus("✅ 已强制刷新并回传", "ok");
                return;
            }
            renderServerAccount(data);
            if (forcePush) setStatus("✅ 已从服务器刷新账号信息", "ok");
        } catch (e) {
            userbar.textContent = "同步失败: " + (e && e.message || e);
            userbar.className = "err";
            if (forcePush) setStatus("刷新失败: " + (e && e.message || e), "err");
        } finally {
            credRefreshing = false;
        }
    }

    async function srvSendFlow() {
        if (!ensureUi()) return;
        const videoUrl = currentVideoUrl();
        if (!videoUrl) {
            srvSetStatus("当前不是视频页（未匹配 /video/xxx），请打开视频页再发", "err");
            return;
        }
        const cur = currentServer();
        let base = cur ? cur.url : "";
        if (!base) {
            srvSetStatus("没有服务器地址：请先点「添加」写入服务端", "err");
            return;
        }
        const sendBtn = panelEl.querySelector("#iwcred-send");
        if (sendBtn) sendBtn.disabled = true;
        try {
            srvSetStatus(`正在探测 ${base} 是否在线…`, "info");
            const probe = await probeServer(base);
            if (!probe.ok) {
                srvSetStatus(`服务器离线：${probe.error}`, "err");
                return;
            }
            let session = "";
            if (probe.status && probe.status.needsAuth) {
                let pwd = String((cur && cur.password) || storeGet(SRV_PWD_KEY) || "");
                if (!pwd) {
                    srvSetStatus("⚠️ 服务器设有访问密码：请删除后重新添加并填写密码", "err");
                    return;
                }
                srvSetStatus("服务器设有密码，正在自动登录…", "info");
                const lg = await serverLogin(base, pwd);
                if (!lg.ok) {
                    srvSetStatus("自动登录失败：" + lg.error, "err");
                    return;
                }
                session = lg.session;
            }
            srvSetStatus(`服务器在线（端口 ${probe.status.port || "?"}），正在发送视频…`, "info");
            const r = await sendVideoToServer(base, videoUrl, session);
            if (r.ok) {
                srvSetStatus(`✅ 已发送，服务器已添加 ${r.total} 个下载任务`, "ok");
                storeSet(SRV_KEY, base);
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
        fillServerSelect();
    }

    /** 从服务器拉明文凭证（GET /api/cred，需登录会话）。 */
    async function fetchServerCreds(base, session) {
        const r = await gmRequest("GET", base + "/api/cred", undefined, 12000, sessionHeaders(session));
        if (!r.ok || !r.json || !r.json.ok) return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
        return { ok: true, cred: r.json };
    }

    /** 把 Cookie 项逐个写进当前域（document.cookie；HttpOnly 项 GM_cookie.set 兜底）。 */
    function applyCookieToBrowser(cookieText) {
        const items = String(cookieText || "").split(";").map((s) => s.trim()).filter((p) => p && !/^=/.test(p) && !/deleted/i.test(p));
        let written = 0;
        for (const item of items) {
            const eq = item.indexOf("=");
            if (eq <= 0) continue;
            const name = item.slice(0, eq).trim();
            const value = item.slice(eq + 1).trim();
            if (!name || !value) continue;
            try { document.cookie = name + "=" + value + "; path=/"; written++; } catch (_) {}
            // HttpOnly（如 cf_clearance）document.cookie 写不进，用 GM_cookie.set 兜底
            if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.set === "function") {
                try {
                    GM_cookie.set({ url: location.origin + "/", name, value, path: "/" }, () => {});
                } catch (_) {}
            }
        }
        return written;
    }

    /** 注入主流程：GET /api/cred → 写 cookie + localStorage，提示刷新。 */
    async function srvInjectFlow() {
        if (!ensureUi()) return;
        const cur = currentServer();
        const base = cur ? cur.url : "";
        if (!base) { srvSetStatus("没有服务器地址：先添加并选择服务端", "err"); return; }
        const btn = panelEl.querySelector("#iwcred-inject");
        if (btn) btn.disabled = true;
        try {
            srvSetStatus("正在连接服务器…", "info");
            const sess = await ensureServerSession(base);
            if (!sess.ok) { srvSetStatus(sess.error, "err"); return; }
            srvSetStatus("正在读取服务器凭证…", "info");
            const got = await fetchServerCreds(sess.base, sess.session);
            if (!got.ok) { srvSetStatus("读取凭证失败：" + got.error, "err"); return; }
            const cred = got.cred || {};
            const n = applyCookieToBrowser(cred.cookie);
            if (cred.token) { try { localStorage.setItem("token", cred.token); } catch (_) {} }
            if (cred.accessToken) { try { localStorage.setItem("accessToken", cred.accessToken); } catch (_) {} }
            const hasCf = /(?:^|;\s*)cf_clearance=/i.test(String(cred.cookie || ""));
            const log = [];
            log.push(`已写入 ${n} 个 Cookie 项` + (hasCf ? "（含 cf_clearance）" : ""));
            if (cred.token) log.push("refresh_token 已注入");
            if (cred.accessToken) log.push("access_token 已注入");
            const ok = n > 0 || cred.token || cred.accessToken;
            if (ok) {
                srvSetStatus("✅ " + log.join("；") + " —— 请刷新页面生效", "ok");
                showToast("✅ 登录态已注入，请刷新页面");
            } else {
                srvSetStatus("服务器没有可注入的凭证（Cookie/Token 都为空）", "err");
            }
        } catch (e) {
            srvSetStatus("注入失败：" + (e && e.message || e), "err");
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /** 监听 SPA 路由：只把 UI 挂回去，不重建、不重拉账号。 */
    function onSpaNav() {
        const href = location.href;
        if (href === lastHref) {
            ensureUi();
            return;
        }
        lastHref = href;
        ensureUi();
        log("SPA 换页", href);
    }

    function hookSpa() {
        if (spaHooked) return;
        spaHooked = true;
        const wrap = (type) => {
            const orig = history[type];
            if (typeof orig !== "function") return;
            history[type] = function () {
                const ret = orig.apply(this, arguments);
                try { window.dispatchEvent(new Event("iwcred-nav")); } catch (_) {}
                return ret;
            };
        };
        wrap("pushState");
        wrap("replaceState");
        window.addEventListener("popstate", onSpaNav);
        window.addEventListener("hashchange", onSpaNav);
        window.addEventListener("iwcred-nav", onSpaNav);
        const mo = new MutationObserver(() => { ensureUi(); });
        try { mo.observe(document.documentElement, { childList: true, subtree: false }); } catch (_) {}
        lastHref = location.href;
    }

    function boot() {
        injectStyle();
        ensureUi();
        hookSpa();
        log("已加载 v" + VER + "（SPA 常驻，换页不重载）");
        setInterval(() => { ensureUi(); }, 2500);
    }

    try {
        boot();
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => { ensureUi(); }, { once: true });
        }
    } catch (e) {
        log("启动异常:", e);
    }
})();
