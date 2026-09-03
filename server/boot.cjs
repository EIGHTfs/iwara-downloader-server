// 零依赖启动器：强制本项目 .js 按 CommonJS 加载。
// 用户原话：「这个项目不需要packagejson文件」「零依赖nodejs项目禁止生成packagejson等」
// AI 思路：父目录 DSH 源码根 package.json 是 "type":"module"，直接 node server/app.js
//   会被当成 ESM 而 require 失败。禁止为此写本地 package.json；.cjs 永远是 CJS。
//   只劫持本项目根内的 .js，项目外仍走 Node 原逻辑。
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const origJs = Module._extensions[".js"];

Module._extensions[".js"] = function loadProjectJsAsCjs(module, filename) {
  const rel = path.relative(PROJECT_ROOT, filename);
  const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (inside) {
    const body = fs.readFileSync(filename, "utf8");
    module._compile(body, filename);
    return;
  }
  return origJs(module, filename);
};

require("./app.js");
