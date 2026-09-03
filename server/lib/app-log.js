// 用户原话：「两边都改 日志功能没有记录时间，也没记录所有前端触发的操作」
"use strict";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function install() {
  if (console._appLogInstalled) return;
  console._appLogInstalled = true;
  function wrap(fn) {
    return function () {
      const args = Array.prototype.slice.call(arguments);
      if (args.length && typeof args[0] === "string") args[0] = "[" + stamp() + "] " + args[0];
      else args.unshift("[" + stamp() + "]");
      return fn.apply(console, args);
    };
  }
  console.log = wrap(console.log);
  console.warn = wrap(console.warn);
  console.error = wrap(console.error);
}

function shouldLogApi(method, pathname) {
  if (!pathname || pathname.indexOf("/api/") !== 0) return false;
  if (method === "GET" && (pathname === "/api/task" || pathname === "/api/clock" || pathname === "/api/login-status")) return false;
  return true;
}

function apiLine(method, pathname) {
  console.log("[api] " + method + " " + pathname);
}

module.exports = { install, shouldLogApi, apiLine, stamp };
