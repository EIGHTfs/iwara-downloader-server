// ============================================================
// 设备判断：aria2 是否与服务器同一台设备（app.js 与 downloader.js 共用）
// 依据：aria2Path 的主机名，与回环地址 / 本机网卡 IP / 本机 hostname 比对
// 返回：true = 同机；false = 跨设备；null = 无法判断（解析失败等）
// ============================================================
"use strict";

const os = require("os");
const dns = require("dns").promises;

async function aria2SameDevice(aria2Path) {
  const raw = String(aria2Path || "").trim();
  if (!raw) return null;
  let host;
  try { host = new URL(raw).hostname.toLowerCase(); } catch (_) { return null; }
  if (!host) return null;
  host = host.replace(/^\[|\]$/g, ""); // 去掉 IPv6 括号
  const hostname = String(os.hostname()).toLowerCase();
  // 回环 or 本机主机名 → 同机
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host === hostname) return true;
  // 本机网卡 IP 集合
  const localIps = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a && a.address) localIps.add(String(a.address).toLowerCase().replace(/^\[|\]$/g, ""));
    }
  }
  if (localIps.has(host)) return true;
  // dns 解析主机名 → IP，落在本机网卡 → 同机
  try {
    const res = await dns.lookup(host, { all: true });
    const ips = Array.isArray(res) ? res.map((r) => String(r.address).toLowerCase().replace(/^\[|\]$/g, "")) : [host];
    if (ips.some((ip) => localIps.has(ip))) return true;
    // 能解析出来但都不在本机 → 跨设备
    return ips.length ? false : null;
  } catch (_) {
    return null; // 解析不出来（如 sa6400.local 本机无记录）→ 无法判断
  }
}

module.exports = { aria2SameDevice };