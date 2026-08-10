// lib/validate.js — 闲不住共享输入校验（lib 层与 routes 层共用）
// isValidAgentId 原定义在 routes/api.js，核心动作 performVisit 在 lib 层
// 无法引用 routes（避免循环依赖），故抽到独立文件，两边统一复用同一套白名单。

// 助手 ID 白名单（防路径穿越 / 原型污染）
const _RESERVED_IDS = new Set(["constructor", "prototype", "__proto__"]);
export function isValidAgentId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
  if (_RESERVED_IDS.has(id)) return false;
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id);
}
