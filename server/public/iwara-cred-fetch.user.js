// ==UserScript==
// @name         Iwara Cookie/Token 获取器（按钮版）
// @namespace    iwara-cred
// @version      5.0.0
// @description  打开 iwara 页面后点右下角 🎫 按钮，弹出面板一键复制完整 Cookie（含 HttpOnly cf_clearance，经 GM_cookie 读取）与 token
// @author       fnOS
// @match        https://www.iwara.tv/*
// @match        https://iwara.tv/*
// @match        https://ecchi.iwara.tv/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_cookie.list
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/* ============================================================
 * v5.0.0：按钮获取模式（v4 基础上改）
 * - 去掉「自动复制」：打开页面不再自动复制，点击 🎫 按钮才获取
 * - 保留 GM_cookie.list 读取完整 cookie（含 HttpOnly cf_clearance）
 * - 面板三个字段 + 「复制全部 / 仅复制 Cookie」按钮
 * - 右上角状态徽标保留（确认脚本在运行）
 * ============================================================ */
(function () {
    "use strict";

    const VER = "5.0.0";

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
<div id="iwcred-head"><b>🎫 Iwara 凭证</b><span id="iwcred-close">✕</span></div>
<div id="iwcred-body">
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