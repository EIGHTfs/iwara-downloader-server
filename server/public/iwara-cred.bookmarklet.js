/* iwara-cred bookmarklet
 * 手机 Edge 无法跑油猴脚本时的替代方案：把这段代码存为书签，在 iwara 页面点一下即弹出凭证面板。
 * 用法见 server/public/bookmarklet.html 或 README。
 */
(function () {
    "use strict";
    function ls(k) { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } }
    function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    var cookie = document.cookie || "";
    var token = ls("token");
    var atoken = ls("accessToken");

    var old = document.getElementById("iwcred-bm");
    if (old) old.remove();

    var panel = document.createElement("div");
    panel.id = "iwcred-bm";
    panel.style.cssText = "position:fixed;left:0;right:0;bottom:0;top:0;z-index:9999999;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;font:14px/1.6 system-ui,-apple-system,'Microsoft YaHei',sans-serif";
    panel.innerHTML =
        '<div style="background:#fff;width:100%;max-width:520px;max-height:82vh;overflow:auto;border-radius:16px 16px 0 0;padding:14px 16px 18px;box-sizing:border-box;color:#222">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><b>🎫 Iwara 凭证</b><span id="iwcred-bm-x" style="font-size:20px;cursor:pointer;padding:0 6px">✕</span></div>' +
        '<div style="font-size:12px;color:#5a6472;margin:6px 0">长按下方文本 → 全选 → 复制。</div>' +
        '<label style="font-size:12px;color:#5a6472">完整 Cookie（含 cf_clearance）</label>' +
        '<textarea id="iwcred-bm-c" readonly style="width:100%;height:90px;box-sizing:border-box;font:11px/1.5 monospace;border:1px solid #c9cfd8;border-radius:8px;padding:6px;background:#fafbfc">' + esc(cookie) + '</textarea>' +
        '<label style="font-size:12px;color:#5a6472">refresh_token</label>' +
        '<textarea id="iwcred-bm-t" readonly style="width:100%;height:50px;box-sizing:border-box;font:11px/1.5 monospace;border:1px solid #c9cfd8;border-radius:8px;padding:6px;background:#fafbfc">' + esc(token) + '</textarea>' +
        '<label style="font-size:12px;color:#5a6472">access_token</label>' +
        '<textarea id="iwcred-bm-a" readonly style="width:100%;height:50px;box-sizing:border-box;font:11px/1.5 monospace;border:1px solid #c9cfd8;border-radius:8px;padding:6px;background:#fafbfc">' + esc(atoken) + '</textarea>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button id="iwcred-bm-cb" style="flex:1;padding:12px;border:none;border-radius:10px;background:#2f6fed;color:#fff;font-size:15px;font-weight:600">📋 复制 Cookie</button>' +
        '<button id="iwcred-bm-tb" style="flex:1;padding:12px;border:none;border-radius:10px;background:#17a2b8;color:#fff;font-size:15px;font-weight:600">📋 复制 Token</button>' +
        '</div>' +
        '<div id="iwcred-bm-st" style="text-align:center;font-size:13px;color:#1a9d4b;margin-top:8px;min-height:18px"></div>' +
        '<div style="font-size:12px;color:#8a94a3;margin-top:6px;background:#fff8e6;padding:8px 10px;border-radius:8px">💡 cf_clearance 缺失时：下拉刷新页面（等 Cloudflare 挑战完成）后再点书签。</div>' +
        '</div>';

    document.body.appendChild(panel);

    function doCopy(text, okMsg) {
        var st = document.getElementById("iwcred-bm-st");
        function fallback() {
            try {
                var ta = document.createElement("textarea");
                ta.value = text;
                ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
                document.body.appendChild(ta);
                ta.focus(); ta.select();
                var r = document.execCommand("copy");
                ta.remove();
                st.textContent = r ? "✅ " + okMsg : "❌ 复制失败，请长按手动复制";
            } catch (_) {
                st.textContent = "❌ 复制失败，请长按手动复制";
            }
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                    st.textContent = "✅ " + okMsg;
                }, fallback);
            } else fallback();
        } catch (_) { fallback(); }
    }

    document.getElementById("iwcred-bm-x").onclick = function () { panel.remove(); };
    document.getElementById("iwcred-bm-cb").onclick = function () { doCopy(cookie, "Cookie 已复制（" + cookie.length + " 字符）"); };
    document.getElementById("iwcred-bm-tb").onclick = function () { doCopy(token, "Token 已复制"); };
})();