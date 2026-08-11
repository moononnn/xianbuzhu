// lib/llm.js — LLM 层公共出口（facade）
// 原 1075 行的单文件已按职责拆分为：
//   providers.js  供应商配置 + Key 混淆 + callLLM + fetchCustomModels
//   prompts.js    提示词构建 + 助手描述/记忆读取 + 清洗 + AI 八股检测
//   responses.js  generateReply / generateCrashReply / generateBrainrot
//   notes.js      小纸条流水线（初审/复审/重写/冷却/触发）
//   variables.js  变量数值规则（纯计算，不涉及 LLM）
//   events.js     事件队列编排（processVisitEvent）
// 本文件只做聚合 re-export，保持既有 import 路径兼容；新代码请直接 import 对应拆分文件。

export {
  encryptKey,
  decryptKey,
  loadProviderConfigs,
  loadModelsCatalog,
  getAvailableModels,
  getLLMConfig,
  saveLLMConfig,
  callLLM,
  fetchCustomModels,
} from "./providers.js";

export {
  sanitizeUserName,
  loadAgentDescription,
  loadAgentMemory,
  hasAiFlavor,
  buildNotePrompt,
  buildReviewPrompt,
} from "./prompts.js";

export {
  generateReply,
  generateCrashReply,
  generateBrainrot,
} from "./responses.js";

export {
  parseReview,
  generateAndSaveNote,
  shouldTriggerNote,
  isNoteOnCooldown,
  NOTE_COOLDOWN_MS,
} from "./notes.js";

export {
  logVariableChange,
  getVariableLog,
} from "./variables.js";

export { processVisitEvent } from "./events.js";
