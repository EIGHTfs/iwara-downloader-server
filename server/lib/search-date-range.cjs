// 按时间搜索日期窗口（零依赖）。权威：旧 gamebanana-mods-downloader 插件
// popup.js enforceDateRules + background.js GBMD_QUERY_MODS。
//
// 前端：
//   结束不能比今天大 → 改成今天
//   开始晚于结束 → 结束改成开始同一天
// 服务端：
//   startTs = 开始日 00:00
//   endTs   = 结束日 00:00 + 86400（次日 0 点），当天不漏
"use strict";

const EARLIEST = "2000-01-01";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) { return String(n).padStart(2, "0"); }

function localYmd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate());
}

function todayYmd() { return localYmd(new Date()); }

function parseYmd(s) {
  const v = String(s || "").trim();
  if (!YMD.test(v)) return null;
  return v;
}

function dayStartSec(ymd) {
  const v = parseYmd(ymd);
  if (!v) return NaN;
  const t = new Date(v + "T00:00:00").getTime();
  return Math.floor(t / 1000);
}

function todayStr() { return todayYmd(); }

function enforceDateRules(startDate, endDate, today) {
  const todayStr2 = parseYmd(today) || todayYmd();
  let start = String(startDate || "").trim();
  let end = String(endDate || "").trim();
  const changed = [];
  if (!end) {
    end = todayStr2;
    changed.push("end-default-today");
  }
  if (end && end > todayStr2) {
    end = todayStr2;
    changed.push("end-clamp-today");
  }
  if (start && end && start > end) {
    end = start;
    changed.push("end-follow-start");
  }
  return { startDate: start, endDate: end, changed };
}

function resolveRange(startDate, endDate) {
  const start = String(startDate || "").trim() || EARLIEST;
  const end = String(endDate || "").trim();
  const fixed = enforceDateRules(start, end);
  const startTs = dayStartSec(fixed.startDate || EARLIEST);
  const endTs = dayStartSec(fixed.endDate) + 86400;
  if (isNaN(startTs) || isNaN(endTs)) return { ok: false, error: "日期格式无效" };
  return {
    ok: true,
    startDate: fixed.startDate || EARLIEST,
    endDate: fixed.endDate,
    startTs,
    endTs,
    changed: fixed.changed
  };
}

function bindInputs(startEl, endEl, onChanged) {
  if (!startEl || !endEl) return;
  if (!endEl.value) endEl.value = todayYmd();
  function apply() {
    const r = enforceDateRules(startEl.value, endEl.value);
    if (startEl.value !== r.startDate) startEl.value = r.startDate;
    if (endEl.value !== r.endDate) endEl.value = r.endDate;
    if (r.changed.length && typeof onChanged === "function") onChanged(r);
  }
  startEl.addEventListener("change", apply);
  endEl.addEventListener("change", apply);
}

const api = {
  EARLIEST, localYmd, todayYmd, todayStr, parseYmd, dayStartSec,
  enforceDateRules, resolveRange, bindInputs
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.SearchDateRange = api;
