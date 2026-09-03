// ═══════════════════════════════════════════════════════════════
// 按时间搜索日期窗口组件（零依赖，浏览器 + Node CJS 双模式）
// ═══════════════════════════════════════════════════════════════
//
// 功能：日期输入框自动修正 + 时间戳计算，香蕉网和 iwara 两个项目共用。
//
// 三条自动修正规则（来源：旧插件 extension/popup.js enforceDateRules）：
//   规则1：结束日期不能超过今天 → 结束回退到今天
//          // 用户原话：「结束不能比今天晚」
//   规则2：用户改了开始日期，且开始晚于结束 → 开始回退到结束
//          // 用户原话：「开始比结束晚变成结束」——主体是开始，开始变
//          // 示例：开始 9.4 结束 9.3 → 开始变成 9.3
//   规则3：用户改了结束日期，且结束早于开始 → 开始跟随结束回退
//          // 用户原话：「结束比开始早变成开始」——主体是开始，开始变
//          // 示例：开始 9.3 结束改到 9.2 → 开始变成 9.2
//
// AI 思路：两条规则方向一致——开始总是跟随结束。
//   规则2：动开始 → 开始回退到结束；规则3：动结束 → 开始跟随结束回退。
//   旧插件只有规则3但方向搞反了（end = start），漏了规则2。
//   因为旧代码没注释，读代码时把两条规则误判为同一条。
//   2026-09-03 固化 skill：代码必须写注释（code-detailed-comments）。
//
// 服务端时间戳计算（resolveRange）：
//   startTs = 开始日 00:00:00 的 epoch 秒
//   endTs   = 结束日 00:00:00 + 86400（次日零点），确保当天 mod 不遗漏
//   // 来源：旧插件 background.js GBMD_QUERY_MODS
// ═══════════════════════════════════════════════════════════════
"use strict";

// 最早日期常量：用户点「最早」按钮时填入的值
const EARLIEST = "2000-01-01";

// 日期格式正则：YYYY-MM-DD
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// 补零工具：月份/日期个位数前面补0
function pad2(n) { return String(n).padStart(2, "0"); }

// 把 Date 对象或时间字符串转成本地 YYYY-MM-DD 字符串
// 注意：用本地时区（getFullYear/getMonth/getDate），不是 UTC
function localYmd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate());
}

// 今天的本地日期字符串
function todayYmd() { return localYmd(new Date()); }

// 校验日期字符串是否合法 YYYY-MM-DD 格式，合法返回原字符串，否则返回 null
function parseYmd(s) {
  const v = String(s || "").trim();
  if (!YMD.test(v)) return null;
  return v;
}

// 把 YYYY-MM-DD 转成 epoch 秒（当天 00:00:00）
// 用途：服务端比对 mod 的 added/modified/updated 时间戳
function dayStartSec(ymd) {
  const v = parseYmd(ymd);
  if (!v) return NaN;
  const t = new Date(v + "T00:00:00").getTime();
  return Math.floor(t / 1000);
}

// 别名，保持向后兼容
function todayStr() { return todayYmd(); }

// ═══════════════════════════════════════════════════════════════
// enforceDateRules：日期自动修正（核心函数）
// ═══════════════════════════════════════════════════════════════
// 参数：
//   startDate    - 开始日期字符串（YYYY-MM-DD 或空）
//   endDate      - 结束日期字符串（YYYY-MM-DD 或空）
//   today        - 今天的日期字符串（可选，默认取系统今天）
//   changedField - 哪个输入框触发了变更（'start' | 'end' | null）
//                  null = 服务端调用 / 初始化，默认按旧插件行为（end 跟随 start）
// 返回：{ startDate, endDate, changed[] }
//   changed 数组记录实际做了哪些修正（用于 UI 提示「已自动修正日期范围」）
//
// 三条规则详见文件头注释。
// ═══════════════════════════════════════════════════════════════
function enforceDateRules(startDate, endDate, today, changedField) {
  const todayStr2 = parseYmd(today) || todayYmd();
  let start = String(startDate || "").trim();
  let end = String(endDate || "").trim();
  const changed = [];

  // 结束日期为空时，默认设为今天（用户还没选结束日期的场景）
  if (!end) {
    end = todayStr2;
    changed.push("end-default-today");
  }

  // 规则1：结束日期不能超过今天 → 结束回退到今天
  // 用户原话：「结束不能比今天晚」
  if (end && end > todayStr2) {
    end = todayStr2;
    changed.push("end-clamp-today");
  }

  // 规则2：用户改了开始日期，且开始晚于结束 → 开始回退到结束
  // 用户原话：「开始比结束晚变成结束」——主体是开始，开始变
  // 示例：开始 9.4 结束 9.3 → 开始变成 9.3
  if (changedField === "start" && start && end && start > end) {
    start = end;
    changed.push("start-follow-end");
  }

  // 规则3：用户改了结束日期，且结束早于开始 → 开始跟随结束回退
  // 用户原话：「结束比开始早变成开始」——主体是开始，开始变（跟随结束往回走）
  // 示例：开始 9.3 结束改到 9.2 → 开始变成 9.2（不是结束卡在 9.3）
  // AI 思路：两条规则方向一致——用户动了哪个框，另一个框跟随适配。
  //   规则2：动开始 → 开始跟随结束；规则3：动结束 → 开始跟随结束
  //   服务端/初始化（changedField 为 null）也走这条
  if ((changedField === "end" || !changedField) && start && end && end < start) {
    start = end;
    changed.push("start-follow-end");
  }

  return { startDate: start, endDate: end, changed };
}

// ═══════════════════════════════════════════════════════════════
// resolveRange：服务端时间戳计算
// ═══════════════════════════════════════════════════════════════
// 把用户选的日期范围转成 epoch 秒，供服务端搜索比对。
// endTs 加 86400（次日零点），确保结束日期当天的 mod 不遗漏。
// 来源：旧插件 background.js GBMD_QUERY_MODS
// ═══════════════════════════════════════════════════════════════
function resolveRange(startDate, endDate) {
  const start = String(startDate || "").trim() || EARLIEST;
  const end = String(endDate || "").trim();
  // 服务端调用不带 changedField，默认行为：end 跟随 start（旧插件规则3）
  const fixed = enforceDateRules(start, end, null, null);
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

// ═══════════════════════════════════════════════════════════════
// bindInputs：绑定日期输入框的自动修正事件
// ═══════════════════════════════════════════════════════════════
// 参数：
//   startEl   - 开始日期 <input type="date"> 元素
//   endEl     - 结束日期 <input type="date"> 元素
//   onChanged - 修正触发时的回调（可选，用于显示「已自动修正」提示）
//
// AI 思路：每个输入框的 change 事件会传入 changedField 参数，
//   让 enforceDateRules 知道是哪个框变了，从而应用正确的修正方向。
//   旧插件没区分，导致两条规则被当成一条。
// ═══════════════════════════════════════════════════════════════
function bindInputs(startEl, endEl, onChanged) {
  if (!startEl || !endEl) return;
  // 初始化：结束日期默认今天
  if (!endEl.value) endEl.value = todayYmd();

  // apply：执行修正并回写输入框
  // changedField 标识哪个框触发了变更，传给 enforceDateRules
  function apply(changedField) {
    const r = enforceDateRules(startEl.value, endEl.value, null, changedField);
    if (startEl.value !== r.startDate) startEl.value = r.startDate;
    if (endEl.value !== r.endDate) endEl.value = r.endDate;
    if (r.changed.length && typeof onChanged === "function") onChanged(r);
  }

  // 用户改开始日期 → changedField = "start" → 规则2生效（start 跟随 end）
  startEl.addEventListener("change", function () { apply("start"); });
  // 用户改结束日期 → changedField = "end" → 规则3生效（end 跟随 start）
  endEl.addEventListener("change", function () { apply("end"); });
}

// ═══════════════════════════════════════════════════════════════
// 导出：浏览器挂 window.SearchDateRange，Node 走 module.exports
// ═══════════════════════════════════════════════════════════════
const SearchDateRangeApi = {
  EARLIEST, localYmd, todayYmd, todayStr, parseYmd, dayStartSec,
  enforceDateRules, resolveRange, bindInputs
};

if (typeof module !== "undefined" && module.exports) module.exports = SearchDateRangeApi;
if (typeof window !== "undefined") window.SearchDateRange = SearchDateRangeApi;
