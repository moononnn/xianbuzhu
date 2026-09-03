// 闲不住 · 后台状态观察
// 低频调用闲不住设置中的专用模型，根据活动事实决定“更新 / 保持 / 清除”，
// 由数据层执行严格校验和落盘；观察过程不进入任何用户可见会话。

import {
  getCurrentStatus,
  getStatusCatalog,
  getStatusUpdateContext,
  loadData,
  nextId,
  nowISO,
  saveData,
  setPartnerStatus,
  todayStr,
  withDataLock,
} from "./data.js";
import { getPartnerIds, isVisiblePartner } from "./config.js";
import { callLLM, getLLMConfig } from "./providers.js";
import { scanTodayActivity } from "./activity.js";
import { normalizeTemperamentConfig } from "./temperament.js";

export const STATUS_AUTONOMY_INTERVAL_MS = 90 * 60 * 1000;
export const STATUS_AUTONOMY_CHECK_TIMEOUT_MS = 8 * 60 * 1000;
export const STATUS_AUTONOMY_MODEL_TIMEOUT_MS = 30 * 1000;
// 部分供应商网关不理会 thinking 关闭参数（如实测的 commandcode deepseek 路由），
// 推理会吃掉短预算导致正文为空；预算给足 + prompt 尾部收敛指令能让这类网关停下出正文。
export const STATUS_AUTONOMY_MODEL_MAX_TOKENS = 800;
// 空返回/解析失败时，同一轮用精简提示词重试一次（改预算与收敛要求，属于差异化重试），
// 不再一次失败就整体退避数小时。
export const STATUS_AUTONOMY_MODEL_RETRY_ATTEMPTS = 1;
export const STATUS_AUTONOMY_MODEL_MAX_TOKENS_RETRY = 400;

// 可复用的关键规则（完整 prompt 与精简重试 prompt 共用）
function buildStatusRules() {
  return [
    "状态徽章是这位伙伴此刻的「样子」（姿态/心情/气质），不是工作内容复述。被派去做什么、在聊什么话题，展板另有「正在做什么」一行单独显示；所以不要把活动标题、具体任务、narrative 或它们的近义改写塞进 statusText，也不要一看对方在忙就机械选「专注/忙碌」。",
    "mode=activity 表示这位伙伴自己主动在聊或做事：可参考 availableStatuses 里做事/小情绪/整活组的短标签，选出贴合这位伙伴当下姿态的一条，认真沉浸可以是专注/吭哧吭哧，也可以是更有个性的表达。mode=delegated 表示她只是被派了活（activityFacts.delegatedTask）：这正是活人感的机会——同样在干活，可以是被迫营业、低电量、赶工、日常叹气这种带软负面可爱感的词，也可以 keep 留白，不要因为「在忙」就都挂专注。",
    "不要因为所有伙伴都空闲就一起换状态，不要为了填满展板而换状态。availableStatuses 已经按场景下发，只从这里面选；如果 currentStatus 仍合适就 keep，没有新的表达价值不硬换。",
    "boardStatuses 列出展板上其他伙伴此刻挂着的状态：除非某个状态对这位伙伴真的唯一合适，尽量避开和大家撞同款，优先换一个只适合这位伙伴的姿态，或 keep。",
    "只从 availableStatuses 里选最贴合的 statusId；只有现有状态都不合适时，才返回不超过8字的 statusText，而且必须是简短状态词，不写完整活动描述。不要编造资料里没有的事件、任务、心情或人物。空闲自选若想长期保持，可以使用 duration=until_changed，但未解锁的高级状态只能临时自动展示，不能用 until_changed。",
    "如果要更新，避开 recentStatuses 中刚用过的相同状态，除非它仍然是唯一准确的选择；当前状态确实不再适合时才 clear。",
  ];
}

// 尾部收敛指令：对「关思考无效、推理不收敛」的网关，实测能有效让它停下并输出正文
const CONVERGENCE_HINT =
  "\n请立即输出最终决定：不要分析、不要思考过程、不要任何多余文字，只输出一个 JSON 对象。";

// 精简版规则：只保留判断骨架，用于失败后的同轮重试（更短的 prompt 更容易让思考型网关收敛）
function buildLeanRules(snapshot) {
  const statuses = (snapshot.availableStatuses || [])
    .map((item) => `${item.id}:${item.text}`)
    .join(" | ");
  const current = snapshot.currentStatus
    ? `当前是 ${snapshot.currentStatus.text}`
    : "当前无状态";
  const activity = snapshot.activityFacts && Object.keys(snapshot.activityFacts).length > 0
    ? `最近在忙：${JSON.stringify(snapshot.activityFacts)}`
    : `暂无具体活动；性格：${snapshot.personalitySnapshot?.surfaceTag || "未知"}`;
  const poolText = statuses || "（无可用状态）";
  const board = Array.isArray(snapshot.boardStatuses) && snapshot.boardStatuses.length > 0
    ? `展板上其他人挂着：${snapshot.boardStatuses.map((item) => item.text).join("、")}；尽量避免撞同款。`
    : "展板上没有其他人挂状态。";
  const modeHint = snapshot.mode === "delegated"
    ? "她只是被派了活：可以是带软负面可爱感的词（被迫营业/低电量/赶工等），也可以 keep，不要都挂专注。"
    : snapshot.mode === "activity"
      ? "她在忙自己的事：选贴合她姿态的短标签。"
      : "空闲：可以按性格偶尔选一条，也可以 keep。";
  return [
    `为伙伴「${snapshot.partnerId}」选一条展板短状态。${current}。${activity}。${board}`,
    `可选状态（id:文案）：${poolText}`,
    `规则：${modeHint}状态是「样子」不是任务复述；没有合适的就 keep 不换，当前状态不适合才 clear。`,
    `只输出一个 JSON 对象，不要任何其他文字。格式：{"action":"keep"} 或 {"action":"update","statusId":"某id","duration":"today","trigger":"idle"} 或 {"action":"clear"}`,
  ].join("\n");
}
// 一轮把所有可见伙伴都纳入判断，但限制同时在途的模型请求，避免伙伴很多时瞬间打满通道。
export const STATUS_AUTONOMY_MAX_CONCURRENCY = 8;
export const STATUS_AUTONOMY_FAILURE_DELAYS_MS = Object.freeze([
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
]);

const STATUS_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const STATUS_CATEGORIES = new Set(["日常", "心情", "做事", "陪伴", "整活", "自定义"]);
const STATUS_DURATIONS = new Set(["today", "hour", "four_hours", "until_changed"]);
const STATUS_TRIGGERS = new Set(["conversation", "event", "mood", "energy", "routine", "agent", "activity", "idle"]);
const AUTONOMY_OPERATION = "work-visit-autonomous-status";
const MAX_ERROR_LENGTH = 180;
const MAX_ACTIVITY_TEXT_LENGTH = 120;

function cleanActivityText(value, maxLength = MAX_ACTIVITY_TEXT_LENGTH) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function personalityForPrompt(config = {}) {
  const normalized = normalizeTemperamentConfig(config, cleanActivityText(config?.description, 120));
  return {
    source: normalized.temperamentSource,
    surfaceTag: normalized.surfaceLayer.tag,
    surfaceStyle: cleanActivityText(normalized.surfaceLayer.params.style, 40),
    innerTag: normalized.innerLayer.tag,
    innerStyle: cleanActivityText(normalized.innerLayer.params.style, 40),
    heartRhythm: normalized.heartRhythm,
  };
}

function activityForPartner(data, partnerId, activitySnapshot = {}) {
  const raw = activitySnapshot?.[partnerId] || {};
  const today = data?.days?.[todayStr()]?.partners?.[partnerId] || {};
  const activity = {
    conversationTitle: cleanActivityText(raw.title, 80),
    delegatedTask: cleanActivityText(raw.dispatched, 80),
    delegatedBy: cleanActivityText(raw.dispatchedBy, 40),
    narrative: cleanActivityText(today.narrative, MAX_ACTIVITY_TEXT_LENGTH),
  };
  activity.fingerprint = JSON.stringify({
    conversationTitle: activity.conversationTitle,
    delegatedTask: activity.delegatedTask,
    delegatedBy: activity.delegatedBy,
    narrative: activity.narrative,
  });
  return activity;
}

function configuredStatusModel(options = {}) {
  const configured = options.statusModel && typeof options.statusModel === "object"
    ? options.statusModel
    : (() => {
      try {
        return getLLMConfig();
      } catch {
        return {};
      }
    })();
  return {
    providerId: String(configured?.providerId || "").trim(),
    modelId: String(configured?.modelId || "").trim(),
  };
}

export function hasConfiguredStatusModel(options = {}) {
  const model = configuredStatusModel(options);
  return Boolean(model.providerId && model.modelId);
}

function statusModelNeedsThinkingDisabled(model = {}) {
  const providerId = String(model.providerId || "").trim().toLowerCase();
  const modelId = String(model.modelId || "").trim().toLowerCase();
  const isDeepSeekProvider = providerId === "deepseek" || providerId === "command code";
  return isDeepSeekProvider && /deepseek-v4-(?:flash|pro)\b/.test(modelId);
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shanghaiDayKey(value) {
  const ms = timestamp(value);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function finiteNow(value) {
  if (value === null || value === undefined || value === "") return Date.now();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

const AUTONOMOUS_STATUS_TEXT_MAX_LENGTH = 8;

function shortText(value, maxLength = 40) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > maxLength) return "";
  return text;
}

function safeError(error) {
  return String(error?.message || error || "自主状态自检失败")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

function ensureAutonomyState(config) {
  if (!config || typeof config !== "object") return {};
  if (!config.statusAutonomy || typeof config.statusAutonomy !== "object" || Array.isArray(config.statusAutonomy)) {
    config.statusAutonomy = {};
  }
  return config.statusAutonomy;
}

function statusIdentity(status) {
  // 默认占位不是伙伴真正挂上的状态，不能因为它在模型回包期间消失就误判为竞态。
  if (!status || status.source === "baseline") return "";
  return `${status.id || ""}\u0000${status.text || ""}`;
}

function triggerForReason(reason) {
  if (reason === "event") return "event";
  if (reason === "mood-change") return "mood";
  if (reason === "energy-change") return "energy";
  if (reason === "activity-change") return "activity";
  if (reason === "conversation") return "conversation";
  return "routine";
}

function localTimeText(now) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString();
  }
}

// 展板状态库按生活场景分组；自动判断先定场景，再下发对应子集，避免大池子全量塞给模型，也让选词贴合场景。
const STATUS_GROUP_LABELS = {
  work: "做事·沉浸（认真干活）",
  "mood-work": "小情绪·活人感（被派活/有点累，带软负面的可爱感）",
  leisure: "日常·闲散（休息/发呆/放空）",
  mood: "心情（情绪起伏）",
  company: "陪伴（和主人相关）",
  fun: "整活·收藏梗（摸鱼/梗）",
  custom: "专属状态（只有 ta 自己写的）",
};

function catalogForPrompt(catalog = {}) {
  return [
    ...(Array.isArray(catalog.publicStatuses) ? catalog.publicStatuses : []),
    ...(Array.isArray(catalog.customStatuses) ? catalog.customStatuses : []),
  ].map((item) => ({
    id: item.id,
    text: item.text,
    icon: item.icon || "✨",
    category: item.category || "自定义",
    tone: item.tone || "mint",
    unlocked: item.unlocked !== false,
    group: item.group || "custom",
  }));
}

// 按场景从完整目录里挑出本次该下发的状态子集
// mode: activity=有真实活动 / delegated=仅被派活 / idle=空闲
function catalogForScene(catalog = {}, mode = "idle") {
  const items = catalogForPrompt(catalog);
  const groups = mode === "activity"
    ? ["work", "mood-work", "fun"]
    : mode === "delegated"
      ? ["mood-work", "work", "fun"]
      : ["leisure", "mood", "company", "fun", "mood-work"];
  const seen = new Set();
  const ordered = [];
  for (const group of groups) {
    for (const item of items) {
      if (item.group !== group || seen.has(item.id)) continue;
      seen.add(item.id);
      ordered.push(item);
    }
  }
  // 伙伴的专属状态兜底，避免场景子集把刚自配的专属状态藏起来
  for (const item of items) {
    if (item.group === "custom" && !seen.has(item.id)) {
      seen.add(item.id);
      ordered.push(item);
    }
  }
  return ordered;
}

// 占用上限：同一短状态最多同时 maxSame 人挂。超过时，对“还没挂它”的伙伴
// 从可选列表剔除，逼模型选别的（吭哧吭哧/被迫营业/赶工…）；但保留
// - 已挂着它的伙伴继续保留（不用被迫换下）
// - 自己的专属状态（custom）不受公共占用限制
// 这是“软中有硬”的平衡：不禁止重样（1~2 人可以同款），只是治模型偷懒导致的整排同款。
function applyOccupancyLimit(sceneItems, boardStatuses, partnerId, maxSame = 2) {
  if (!Array.isArray(boardStatuses) || boardStatuses.length === 0) return sceneItems;
  const occupancy = {};
  for (const item of boardStatuses) {
    if (!item || item.partnerId === partnerId) continue;
    const id = item.id || item.statusId;
    if (!id) continue;
    occupancy[id] = (occupancy[id] || 0) + 1;
  }
  if (Object.keys(occupancy).length === 0) return sceneItems;
  return sceneItems.filter((item) => {
    if (item.group === "custom") return true;
    const used = occupancy[item.id] || 0;
    return used < maxSame;
  });
}

// 构建传给模型的当前资料快照（完整 prompt 与精简重试 prompt 共用）
function buildStatusSnapshot({
  now = Date.now(),
  partnerId = "",
  context = {},
  catalog = {},
  activity = {},
  config = {},
  boardStatuses = [],
  maxSame = 2,
} = {}) {
  const recentEvents = (context.recentEvents || [])
    .map((event) => ({
      type: cleanActivityText(event?.type, 30) || "event",
      itemName: cleanActivityText(event?.itemName, 60),
    }))
    .filter((event) => event.itemName || event.type);
  const recentStatuses = (context.recentStatusHistory || [])
    .map((status) => ({
      id: cleanActivityText(status?.id, 80),
      text: cleanActivityText(status?.text, 40),
    }))
    .filter((status) => status.id || status.text);
  const activityFacts = {
    conversationTitle: cleanActivityText(activity.conversationTitle, 80),
    delegatedTask: cleanActivityText(activity.delegatedTask, 80),
    delegatedBy: cleanActivityText(activity.delegatedBy, 40),
    narrative: cleanActivityText(activity.narrative, MAX_ACTIVITY_TEXT_LENGTH),
  };
  // 亲疏判定：自己主动在聊/在做（conversationTitle/narrative）是真实活动；
  // 只有“被派去做什么”时是 delegated（别人给的活，不驱动“忙”的选词，更该往活人感走）。
  const selfDriven = Boolean(activityFacts.conversationTitle || activityFacts.narrative);
  const delegatedOnly = !selfDriven && Boolean(activityFacts.delegatedTask);
  const mode = selfDriven ? "activity" : (delegatedOnly ? "delegated" : "idle");
  const currentStatus = context.current && context.current.source !== "baseline"
    ? {
      id: context.current.id,
      text: context.current.text,
      icon: context.current.icon || "✨",
      source: context.current.source || "user",
    }
    : null;
  return {
    localTime: localTimeText(now),
    partnerId,
    mode,
    mood: context.moodText || "心情平稳",
    energy: context.energyText || "精力正常",
    updateReason: context.reasonText || "当前没有明显变化",
    changesToday: Number(context.changesToday) || 0,
    currentStatus,
    personalitySnapshot: personalityForPrompt(config),
    activityFacts,
    activityChanged: context.activityChanged === true,
    recentStatuses,
    recentEvents,
    // 展板现状：其他伙伴此刻挂着的状态（防无意识批量撞同款；id 供占用上限剔除用）
    boardStatuses: (Array.isArray(boardStatuses) ? boardStatuses : [])
      .filter((item) => item && item.partnerId !== partnerId && item.text)
      .map((item) => ({
        partnerId: cleanActivityText(item.partnerId, 40),
        text: cleanActivityText(item.text, 40),
        id: cleanActivityText(item.id, 80),
      })),
    availableStatuses: applyOccupancyLimit(
      catalogForScene(catalog, mode),
      boardStatuses,
      partnerId,
      maxSame,
    ),
  };
}

export function buildAutonomousStatusPrompt({
  now = Date.now(),
  partnerId = "",
  partnerName = partnerId,
  context = {},
  catalog = {},
  activity = {},
  config = {},
  boardStatuses = [],
  maxSame = 2,
} = {}) {
  const snapshot = buildStatusSnapshot({ now, partnerId, context, catalog, activity, config, boardStatuses, maxSame });
  const safePartnerName = cleanActivityText(partnerName, 60) || partnerId;

  return [
    `你是闲不住的状态编辑员，正在为「${safePartnerName}」整理一条展板状态。`,
    "这是低频后台判断，不会进入主对话，不会发消息，也不需要向对方解释；只返回状态决定。",
    ...buildStatusRules(),
    "只返回一个 JSON 对象，不要 Markdown、解释、思考过程或额外文字。格式只能是：",
    '{"action":"update","statusId":"quiet-work","duration":"four_hours","trigger":"activity"}',
    '或者：{"action":"update","statusId":"inspiration","duration":"today","trigger":"mood"}',
    '或者：{"action":"update","statusId":"leisurely","duration":"until_changed","trigger":"idle"}',
    '或者：{"action":"keep"}；当前状态确实不再适合时才用：{"action":"clear"}。',
    "action 只能是 update、keep、clear；trigger 只能是 conversation、event、mood、energy、routine、agent、activity、idle；duration 只能是 today、hour、four_hours、until_changed。",
    `当前资料：${JSON.stringify(snapshot)}`,
  ].join("\n") + CONVERGENCE_HINT;
}

function extractTextPart(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.output_text === "string") return value.output_text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .filter((part) => typeof part === "string" || part?.type === "text" || part?.type === "input_text" || typeof part?.text === "string")
      .map(extractTextPart)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function extractAutonomousModelText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if ("action" in result || "decision" in result) return JSON.stringify(result);
  const direct = extractTextPart(result);
  if (direct) return direct;
  if (Array.isArray(result.output)) {
    return result.output
      .filter((part) => typeof part === "string" || part?.type === "text" || part?.type === "output_text" || typeof part?.text === "string")
      .map(extractTextPart)
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(result.choices)) {
    return result.choices.map((choice) => extractTextPart(choice?.message || choice)).filter(Boolean).join("\n");
  }
  return "";
}

function stripHiddenModelBlocks(value) {
  return String(value || "")
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/gi, "")
    .replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, "")
    .replace(/<pulse>[\s\S]*?(?:<\/pulse>|$)/gi, "")
    .replace(/```(?:json|javascript|text|markdown)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function balancedJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" && depth === 0) {
      start = index;
      depth = 1;
      continue;
    }
    if (char === "{" && depth > 0) {
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function parseObjectCandidate(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseAutonomousStatusDecision(raw) {
  const text = stripHiddenModelBlocks(extractAutonomousModelText(raw));
  if (!text) return { ok: false, error: "模型没有返回状态决定" };
  const candidates = [text, ...balancedJsonObjects(text)];
  let value = null;
  for (const candidate of candidates) {
    value = parseObjectCandidate(candidate);
    if (value) break;
  }
  if (!value) return { ok: false, error: "模型返回的状态决定不是有效 JSON" };

  const rawAction = String(value.action || value.decision || "").trim().toLowerCase();
  const actionAliases = {
    update: "update",
    set: "update",
    keep: "keep",
    hold: "keep",
    unchanged: "keep",
    none: "keep",
    clear: "clear",
    remove: "clear",
  };
  const action = actionAliases[rawAction];
  if (!action) return { ok: false, error: "状态决定缺少有效 action" };
  if (action === "keep" || action === "clear") return { ok: true, decision: { action } };

  const statusId = typeof value.statusId === "string"
    ? value.statusId.trim()
    : (typeof value.id === "string" ? value.id.trim() : "");
  const statusText = shortText(
    typeof value.statusText === "string"
      ? value.statusText
      : (typeof value.status === "string" ? value.status : value.text),
    AUTONOMOUS_STATUS_TEXT_MAX_LENGTH,
  );
  if (!statusId && !statusText) {
    return { ok: false, error: "更新决定缺少 statusId 或 statusText" };
  }
  if (statusId && !STATUS_ID_RE.test(statusId)) {
    return { ok: false, error: "状态 ID 格式无效" };
  }

  const icon = value.icon === undefined ? "✨" : shortText(value.icon, 8);
  if (!icon) return { ok: false, error: "状态图标无效或过长" };
  const category = value.category === undefined ? "自定义" : String(value.category);
  if (!STATUS_CATEGORIES.has(category)) return { ok: false, error: "状态类别无效" };
  const duration = value.duration === undefined ? "today" : String(value.duration);
  if (!STATUS_DURATIONS.has(duration)) return { ok: false, error: "状态保持时间无效" };
  const rawTrigger = value.trigger === undefined ? "" : String(value.trigger);
  const trigger = rawTrigger === "activity-change" ? "activity" : rawTrigger;
  if (trigger && !STATUS_TRIGGERS.has(trigger)) return { ok: false, error: "状态更新缘由无效" };

  return {
    ok: true,
    decision: {
      action,
      statusId,
      statusText,
      icon,
      category,
      duration,
      trigger,
    },
  };
}

export function isAutonomousStatusDue(config, context, now = Date.now()) {
  if (!context?.canUpdate || context.statusCleared) return false;
  const state = config?.statusAutonomy;
  if (!state || typeof state !== "object") return true;

  const currentNow = finiteNow(now);
  const checkingAt = timestamp(state.checkingAt);
  if (Number.isFinite(checkingAt) && currentNow - checkingAt < STATUS_AUTONOMY_CHECK_TIMEOUT_MS) {
    return false;
  }
  const lastCheckedAt = timestamp(state.lastCheckedAt);
  // 新的一天没有真实状态时至少重新问一次，不能让前一天的失败退避把整天锁成统一占位。
  const needsNewDayCheck = context.changesToday === 0
    && context.current?.source === "baseline"
    && Number.isFinite(lastCheckedAt)
    && shanghaiDayKey(lastCheckedAt) !== shanghaiDayKey(currentNow);
  if (needsNewDayCheck) return true;
  const nextCheckAt = timestamp(state.nextCheckAt);
  if (Number.isFinite(nextCheckAt) && nextCheckAt > currentNow) return false;
  if (Number.isFinite(lastCheckedAt) && currentNow - lastCheckedAt < STATUS_AUTONOMY_INTERVAL_MS) {
    return false;
  }
  return true;
}

function resolveActivitySnapshot(data, options = {}) {
  if (options.activitySnapshot && typeof options.activitySnapshot === "object") {
    return options.activitySnapshot;
  }
  try {
    return scanTodayActivity(data);
  } catch {
    return {};
  }
}

function chooseCandidates(data, now, activitySnapshot = {}) {
  const ids = getPartnerIds(data);
  // 展板现状：所有可见伙伴此刻真正挂着的状态（供防撞参考）
  const boardStatuses = [];
  for (const pid of ids) {
    const cfg = data.partnerConfig?.[pid];
    if (!cfg || cfg.hidden) continue;
    const current = getCurrentStatus(data, pid, now);
    if (current && current.source !== "baseline") {
      boardStatuses.push({
        partnerId: pid,
        text: current.text,
        id: current.id,
      });
    }
  }
  const candidates = [];
  for (let index = 0; index < ids.length; index += 1) {
    const partnerId = ids[index];
    const config = data.partnerConfig?.[partnerId];
    if (!config || config.hidden) continue;
    const activity = activityForPartner(data, partnerId, activitySnapshot);
    const autonomy = config.statusAutonomy;
    const activityChanged = typeof autonomy?.lastActivityFingerprint === "string"
      && autonomy.lastActivityFingerprint !== activity.fingerprint;
    const context = getStatusUpdateContext(data, partnerId, {
      now,
      activityChanged,
    });
    if (!isAutonomousStatusDue(config, context, now)) continue;
    candidates.push({
      partnerId,
      partnerName: config.name || partnerId,
      config,
      context,
      activity,
      activityFingerprint: activity.fingerprint,
      catalog: getStatusCatalog(data, partnerId),
      boardStatuses,
      order: index,
      lastCheckedAt: timestamp(config.statusAutonomy?.lastCheckedAt) || 0,
    });
  }
  candidates.sort((a, b) => a.lastCheckedAt - b.lastCheckedAt || a.order - b.order);
  return candidates;
}

function log(ctx, level, message, details) {
  try {
    const logger = ctx?.log?.[level];
    if (typeof logger === "function") logger.call(ctx.log, message, details);
  } catch {}
}

async function sampleStatus(ctx, candidate, options, sampleOptions = {}) {
  const model = configuredStatusModel(options);
  const thinking = statusModelNeedsThinkingDisabled(model)
    ? { type: "disabled" }
    : null;
  // 重试档位用更短的提示词 + 更小预算，让思考型网关更容易收敛出正文；
  // 重试不是原样重复，必须带着收敛指令（见 CONVERGENCE_HINT）。
  const lean = sampleOptions.lean === true;
  const content = lean
    ? buildLeanRules(buildStatusSnapshot(candidate))
    : buildAutonomousStatusPrompt(candidate);
  const maxTokens = lean ? STATUS_AUTONOMY_MODEL_MAX_TOKENS_RETRY : (options.maxTokens ?? STATUS_AUTONOMY_MODEL_MAX_TOKENS);
  const input = {
    messages: [{ role: "user", content }],
    agentId: candidate.partnerId,
    temperature: 0.45,
    maxTokens,
    operation: AUTONOMY_OPERATION,
    ...(thinking ? { thinking } : {}),
  };
  if (typeof options.autonomousStatusSampler === "function") {
    return options.autonomousStatusSampler(input, candidate, sampleOptions);
  }
  if (typeof options.sampleText === "function") {
    return options.sampleText(input, candidate, sampleOptions);
  }

  if (!model.providerId || !model.modelId) {
    throw new Error("闲不住尚未配置状态模型");
  }
  return callLLM(content, {
    providerId: model.providerId,
    modelId: model.modelId,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    timeout: options.timeoutMs || STATUS_AUTONOMY_MODEL_TIMEOUT_MS,
    ...(thinking ? { thinking } : {}),
  });
}

function withTimeout(promise, timeoutMs) {
  const numericTimeout = Number(timeoutMs);
  const delay = Number.isFinite(numericTimeout)
    ? Math.max(1, Math.min(30 * 1000, numericTimeout))
    : STATUS_AUTONOMY_MODEL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`伙伴状态模型调用超时（${delay}ms）`)), delay);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function finishState(state, now, result, reason, error = "", activityFingerprint) {
  state.checkingAt = null;
  state.claimId = null;
  state.lastCheckedAt = nowISO(now);
  state.nextCheckAt = nowISO(now + STATUS_AUTONOMY_INTERVAL_MS);
  state.failureCount = 0;
  state.lastFailureAt = null;
  state.lastError = error ? safeError(error) : null;
  state.lastResult = result;
  state.lastReason = reason || "";
  if (typeof activityFingerprint === "string") {
    state.lastActivityFingerprint = activityFingerprint;
  }
}

function failureDelay(failureCount) {
  const index = Math.max(0, Math.min(
    STATUS_AUTONOMY_FAILURE_DELAYS_MS.length - 1,
    Number(failureCount) - 1,
  ));
  return STATUS_AUTONOMY_FAILURE_DELAYS_MS[index];
}

function finishFailure(state, now, error) {
  const count = (Number.isInteger(Number(state.failureCount)) ? Number(state.failureCount) : 0) + 1;
  state.checkingAt = null;
  state.claimId = null;
  state.failureCount = count;
  state.lastFailureAt = nowISO(now);
  state.lastError = safeError(error);
  state.lastResult = "failed";
  state.nextCheckAt = nowISO(now + failureDelay(count));
}

function snapshotCandidate(candidate, claimId) {
  return {
    ...candidate,
    claimId,
    activity: candidate.activity ? { ...candidate.activity } : {},
    context: {
      ...candidate.context,
      current: candidate.context.current ? { ...candidate.context.current } : null,
      recentEvents: Array.isArray(candidate.context.recentEvents)
        ? candidate.context.recentEvents.map((event) => ({ ...event }))
        : [],
      recentStatusHistory: Array.isArray(candidate.context.recentStatusHistory)
        ? candidate.context.recentStatusHistory.map((status) => ({ ...status }))
        : [],
    },
  };
}

function normalizeConcurrency(value, itemCount) {
  const numeric = Number(value);
  const requested = Number.isInteger(numeric) && numeric > 0
    ? numeric
    : STATUS_AUTONOMY_MAX_CONCURRENCY;
  return Math.max(1, Math.min(itemCount, requested));
}

async function runConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(items.length, limit);
  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function recordFailure(ctx, claim, now, error) {
  try {
    await withDataLock(() => {
      const data = loadData();
      const state = ensureAutonomyState(data.partnerConfig?.[claim.partnerId]);
      if (state.claimId !== claim.claimId) return { ok: false, stale: true };
      finishFailure(state, now, error);
      const saved = saveData(data);
      if (!saved) return { ok: false, error: "状态自检失败信息保存失败" };
      return { ok: true };
    });
  } catch (saveError) {
    log(ctx, "warn", "[闲不住] 自主状态失败记录未能落盘", safeError(saveError));
  }
  return { ok: false, partnerId: claim.partnerId, error: safeError(error) };
}

async function applyDecision(ctx, claim, decision, now) {
  return withDataLock(() => {
    const data = loadData();
    const config = data.partnerConfig?.[claim.partnerId];
    const state = ensureAutonomyState(config);
    if (state.claimId !== claim.claimId) return { ok: false, stale: true };
    if (!isVisiblePartner(data, claim.partnerId)) {
      finishState(state, now, "hidden", claim.context.reason, "", claim.activityFingerprint);
      saveData(data);
      return { ok: false, partnerId: claim.partnerId, skipped: "hidden" };
    }

    const current = getCurrentStatus(data, claim.partnerId, now);
    const currentDay = data?.days?.[todayStr()]?.partners?.[claim.partnerId];
    const changedDuringCheck = statusIdentity(current) !== statusIdentity(claim.context.current)
      || Boolean(currentDay?.statusClearedAt) !== Boolean(claim.context.statusCleared);
    let result = null;
    let outcome = decision.action;
    let error = "";
    let failedDecision = false;

    if (changedDuringCheck) {
      outcome = "stale";
    } else if (decision.action === "update") {
      const availableCatalog = getStatusCatalog(data, claim.partnerId);
      const available = [...(availableCatalog.publicStatuses || []), ...(availableCatalog.customStatuses || [])];
      const selectedStatus = decision.statusId
        ? available.find((item) => item.id === decision.statusId)
        : null;
      if (decision.statusId && !selectedStatus) {
        outcome = "rejected";
        error = "模型选择的状态已经不在衣柜里";
        failedDecision = true;
      } else if (selectedStatus?.unlocked === false && decision.duration === "until_changed") {
        outcome = "rejected";
        error = "未解锁的高级状态只能临时自动展示";
        failedDecision = true;
      } else {
        const trigger = decision.trigger || triggerForReason(claim.context.reason);
        result = setPartnerStatus(data, claim.partnerId, {
          statusId: decision.statusId || undefined,
          text: decision.statusText || undefined,
          icon: decision.icon,
          category: decision.category,
          duration: decision.duration,
          source: "autonomous",
          trigger,
          activityChanged: claim.context.activityChanged === true,
          // 自动生成的短句只是当前活动的临时投影，不污染伙伴的专属衣柜。
          persist: !(decision.statusText && !decision.statusId),
          now,
        });
        if (!result.ok) {
          outcome = "rejected";
          error = result.error || "状态更新被拒绝";
          failedDecision = true;
        } else if (result.unchanged) {
          outcome = "unchanged";
        }
      }
    } else if (decision.action === "clear") {
      result = setPartnerStatus(data, claim.partnerId, {
        clear: true,
        source: "autonomous",
        trigger: decision.trigger || "agent",
        now,
      });
      if (!result.ok) {
        outcome = "rejected";
        error = result.error || "状态清除被拒绝";
        failedDecision = true;
      }
    } else {
      outcome = "keep";
    }

    if (failedDecision) finishFailure(state, now, error);
    else finishState(state, now, outcome, claim.context.reason, error, claim.activityFingerprint);
    const saved = saveData(data);
    if (!saved) return { ok: false, partnerId: claim.partnerId, error: "状态自检结果保存失败" };
    return {
      ok: !error,
      partnerId: claim.partnerId,
      action: outcome,
      status: result?.current || getCurrentStatus(data, claim.partnerId, now),
      reason: claim.context.reason,
      error: error || undefined,
    };
  });
}

async function evaluateClaim(ctx, claim, now, options) {
  try {
    const raw = await withTimeout(
      sampleStatus(ctx, claim, options),
      options.timeoutMs ?? STATUS_AUTONOMY_MODEL_TIMEOUT_MS,
    );
    let parsed = parseAutonomousStatusDecision(raw);
    // 只对「模型没吐出任何正文」空返回做同轮精简重试（常见于思考型网关把预算
    // 耗在推理上）；有正文但格式不对（如模型回了句普通话）说明通道本身正常，
    // 重试不会改善，直接记失败退避。
    if (!parsed.ok && parsed.error === "模型没有返回状态决定" && STATUS_AUTONOMY_MODEL_RETRY_ATTEMPTS > 0) {
      log(ctx, "info", "[闲不住] 状态模型首次返回不可用，尝试精简重试", {
        partnerId: claim.partnerId,
        reason: safeError(parsed.error),
      });
      const retryRaw = await withTimeout(
        sampleStatus(ctx, claim, options, { lean: true }),
        options.timeoutMs ?? STATUS_AUTONOMY_MODEL_TIMEOUT_MS,
      );
      parsed = parseAutonomousStatusDecision(retryRaw);
    }
    if (!parsed.ok) throw new Error(parsed.error);
    return await applyDecision(ctx, claim, parsed.decision, now);
  } catch (error) {
    log(ctx, "warn", "[闲不住] 伙伴自主状态自检失败", {
      partnerId: claim.partnerId,
      error: safeError(error),
    });
    return recordFailure(ctx, claim, now, error);
  }
}

export async function runAutonomousStatusTick(ctx = {}, options = {}) {
  if (options.skipAutonomousStatus === true) return { ok: false, skipped: "disabled", checked: 0, results: [] };
  const hasSampler = typeof options.autonomousStatusSampler === "function"
    || typeof options.sampleText === "function"
    || hasConfiguredStatusModel(options);
  if (!hasSampler) return { ok: false, skipped: "model-config", checked: 0, results: [] };

  const now = finiteNow(options.now);
  let claims;
  try {
    claims = await withDataLock(() => {
      const data = loadData();
      const activitySnapshot = resolveActivitySnapshot(data, options);
      const candidates = chooseCandidates(data, now, activitySnapshot);
      if (candidates.length === 0) return [];
      const claimed = candidates.map((candidate) => {
        const state = ensureAutonomyState(candidate.config);
        const claimId = `status-${now.toString(36)}-${nextId().toString(36)}`;
        state.checkingAt = nowISO(now);
        state.claimId = claimId;
        return snapshotCandidate(candidate, claimId);
      });
      return saveData(data) ? claimed : [];
    });
  } catch (error) {
    log(ctx, "warn", "[闲不住] 自主状态候选读取失败", safeError(error));
    return { ok: false, error: safeError(error), checked: 0, results: [] };
  }

  if (!claims.length) return { ok: true, skipped: "not-due", checked: 0, results: [] };

  const results = await runConcurrent(
    claims,
    normalizeConcurrency(options.maxConcurrency, claims.length),
    (claim) => evaluateClaim(ctx, claim, now, options),
  );
  const summary = {
    ok: results.every((result) => result?.ok === true),
    checked: claims.length,
    results,
  };
  // 保留单伙伴调用的旧返回字段，避免现有调用方和测试失去兼容。
  if (results.length === 1) Object.assign(summary, results[0]);
  return summary;
}
