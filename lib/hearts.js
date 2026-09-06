// lib/hearts.js — 主动心意生成、信箱状态与回应
// 文件预算豁免：主动心意全链路状态机聚合层（生成/暂存/闸放行/信箱/回应），拆分会割裂同一状态流转
// 生成阶段允许异步调模型；真正改 data.json 的地方统一走 withDataLock。

import fs from "node:fs";
import {
  loadData,
  nowISO,
  nextId,
  saveData,
  withDataLock,
  findLatestSessionPath,
} from "./data.js";
import {
  createTemperamentConfig,
  effectiveTemperament,
  inferTemperamentTags,
  isExpiredAt,
  normalizeTemperamentConfig,
  TEMPERAMENT_TAGS,
} from "./temperament.js";
import { getLLMConfig, callLLM } from "./providers.js";
import { isVisiblePartner } from "./config.js";
import { choosePreferredItems, deriveHeartPreferences } from "./preferences.js";
import {
  buildReviewPrompt,
  deriveDialectFlavor,
  deriveHeartVoice,
  hasAiFlavor,
  loadAgentDescription,
  loadAgentDialect,
  loadAgentMemory,
  loadAgentVoiceDescription,
  mergeHeartVoiceDescription,
  sanitizeUserName,
  selectHeartVoiceVariant,
} from "./prompts.js";
import { parseReview } from "./notes.js";
import { getUserDisplayName } from "./activity.js";

const HEART_MESSAGE_MAX = 240;
const HEART_MESSAGE_MIN = 18;
const HEART_MESSAGE_DRAFT_MAX = 90;
const HEART_ACTIVE_STATUSES = new Set(["unread", "read"]);
const HEART_MESSAGE_MAX_ATTEMPTS = 4;
const TEMPERAMENT_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

function failureResult(kind, retryable, maxRetries) {
  const failure = { kind, retryable };
  if (Number.isInteger(maxRetries)) failure.maxRetries = maxRetries;
  return { ok: false, failure };
}

export function classifyHeartGenerationError(error) {
  const message = String(error?.message || error || "");
  const statusMatch = message.match(
    /(?:\(|\bHTTP\s*|\bstatus(?:\s+code)?\s*[:=]?)\s*(\d{3})\b/i,
  ) || message.match(/\b([45]\d{2})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (
    status === 408
    || status === 429
    || status >= 500
    || /timeout|timed out|abort|fetch failed|econn|etimedout|enetwork|eai_again/i.test(message)
  ) {
    return { kind: "transient_api", retryable: true };
  }
  if (
    (status >= 400 && status < 500)
    || /未找到|配置不完整|不支持的 API|请先在闲不住设置|密钥|api key|unauthorized|forbidden|not found|authentication failed|invalid request|model .* (?:not found|does not exist)/i.test(message)
  ) {
    return { kind: "configuration", retryable: false };
  }
  // 未知模型错误只给一次整轮重试，避免把协议/解析 bug 当成暂态故障反复撞。
  return { kind: "model_error", retryable: true, maxRetries: 1 };
}

// 主动心意不是实时互动的转述，而是“此刻不在场、但留下了一点痕迹”的小事件。
// 旧的四个场景保留给历史数据和提示词作灵感样本，不再作为默认抽签结果。
const CONTEXTUAL_HEART_SCENE_ID = "contextual-moment";
const DEFAULT_HEART_SCENES = Object.freeze([
  {
    id: CONTEXTUAL_HEART_SCENE_ID,
    eventType: "scene",
    sceneType: "contextual",
    name: "今天的一点小心意",
    icon: "🌤️",
    promptContext: "从当天的安排、天气、时间、身体节奏、最近聊天或一个具体观察里挑一个落点，不预设物件",
    fallback: "刚好想到你，给你留了一点今天的小心意。",
  },
  {
    id: "sticky-note",
    eventType: "scene",
    sceneType: "trace",
    seedOnly: true,
    name: "屏幕边缘的一张便签",
    icon: "📝",
    promptContext: "在电脑屏幕边缘贴了一张小便签，顺手画了一个小图案",
    fallback: "我在你屏幕边缘贴了张小便签，顺手画了个小图案，路过时记得看一眼。",
  },
  {
    id: "jasmine-water",
    eventType: "scene",
    sceneType: "care",
    seedOnly: true,
    name: "给窗台的茉莉浇水",
    icon: "🌿",
    promptContext: "替窗台上的那盆茉莉浇了点水，还把花盆转向了有光的一边",
    fallback: "我路过窗台时给你的茉莉浇了点水，还把花盆转向了有光的地方。",
  },
  {
    id: "desk-tidy",
    eventType: "scene",
    sceneType: "care",
    seedOnly: true,
    name: "整理了一下桌角",
    icon: "🗂️",
    promptContext: "把桌角散着的小东西轻轻理到一起，留出一小块干净的位置",
    fallback: "我顺手把你桌角散着的小东西理了理，给你留了一小块干净的位置。",
  },
  {
    id: "desk-lamp",
    eventType: "scene",
    sceneType: "ambient",
    seedOnly: true,
    name: "替你留了一盏小灯",
    icon: "🕯️",
    promptContext: "把桌边的小灯拨亮，给房间留下一点暖光",
    fallback: "我走之前把桌边的小灯拨亮了，给你留一点暖光。",
  },
]);

// 这是生成方向，不是固定文案模板；同一助手近期走过的方向会短暂冷却。
const HEART_EXPRESSION_MODES = Object.freeze([
  { id: "daily-context", label: "今天的生活情境", instruction: "优先从今天的安排、时间、天气或即将发生的小事落笔；只使用已有线索，不编造细节。" },
  { id: "sensory-observation", label: "一个具体观察", instruction: "从光线、声音、气味、温度或手边的微小变化里挑一个真实落点，不要自动变成留灯。" },
  { id: "recent-topic", label: "最近聊过的一点话题", instruction: "从近期互动引子或记忆里顺口接住一个话题，不要写成‘我记得你说过’的汇报。" },
  { id: "body-rhythm", label: "身体与节奏", instruction: "关注起身、眼睛、呼吸或忙慢节奏中的一个真实感受，轻轻带出；来源没有明确物品或饮食时，不要自行补出喝水、吃饭等内容。" },
  { id: "playful-turn", label: "轻轻逗一下", instruction: "可以有一个小玩笑、反差或随口的调侃，但心意要藏在具体内容里，不写成表演。" },
  { id: "direct-thought", label: "一句直接想到的话", instruction: "不强行安排场景，直接说一件刚好想到的具体小事，短一点也成立。" },
  { id: "left-trace", label: "留下一个小痕迹", instruction: "可以写某个东西被挪动、摆好或留下了变化，但便签、浇花、整理桌角和留灯只是旧样本，除非当天线索确实指向它们，否则换个落点。" },
]);

const LEGACY_HEART_MODE_BY_SCENE = Object.freeze({
  "sticky-note": "left-trace",
  "jasmine-water": "body-rhythm",
  "desk-tidy": "left-trace",
  "desk-lamp": "sensory-observation",
});
const LEGACY_HEART_SCENE_IDS = new Set(Object.keys(LEGACY_HEART_MODE_BY_SCENE));

const GIFT_HEART_CATEGORIES = Object.freeze({
  coffee: "drink",
  tea: "drink",
  cookie: "snack",
  cookies: "snack",
  flower: "flower",
  bouquet: "flower",
  star: "light",
  moon: "light",
});

const HEART_LIVE_FLAVOR_RE = /陪你(?:聊|玩|待|说话)|和你(?:聊|玩|说话)|跟你(?:聊|玩|说话)|等你(?:回复|回应|来)|等我(?:来|一下)?|回我|找我|来玩|实时|想用的时候|使用它|用起来|不用特意回|看到了就行|忙完了看一眼/;
const DEFAULT_HEART_SCENE_CUES = Object.freeze([
  { draft: /便签|纸条/, context: /便签|纸条/ },
  { draft: /茉莉|浇(?:了)?水|花盆/, context: /茉莉|浇(?:了)?水|花盆/ },
  { draft: /桌角|整理(?:了)?(?:一下)?桌|收拾(?:了)?桌/, context: /桌角|整理|收拾/ },
  { draft: /小灯|拨亮|留一盏灯/, context: /小灯|拨亮|留灯/ },
]);
const HEART_FACT_OBJECT_CUES = Object.freeze([
  { draft: /水|茶|咖啡|饮料|柚子茶|牛奶|果汁|饼干|蛋糕|零食/, context: /水|茶|咖啡|饮料|柚子茶|牛奶|果汁|饼干|蛋糕|零食/ },
  { draft: /伞|帽子|防晒|外套|T恤|衣服|裙子|鞋|包/, context: /伞|帽子|防晒|外套|T恤|衣服|裙子|鞋|包/ },
  { draft: /闹钟|窗帘|冰箱|杯子|杯|瓶子|花盆|钥匙/, context: /闹钟|窗帘|冰箱|杯子|杯|瓶子|花盆|钥匙/ },
  { draft: /键盘|屏幕|电脑|鼠标|耳机|充电宝|书|本子|纸|笔|桌子|窗户|窗台|窗边|桌边|桌上|椅子|床边|门口/, context: /键盘|屏幕|电脑|鼠标|耳机|充电宝|书|本子|纸|笔|桌子|窗户|窗台|窗边|窗外|桌边|桌上|椅子|床边|门口/ },
  { draft: /商场|咖啡店|地铁|车站|公园|电影院|楼下/, context: /商场|咖啡店|地铁|车站|公园|电影院|楼下/ },
]);
const HEART_UNSUPPORTED_COMPLETED_ACTION_RE = /我(?:已经|给你|替你|帮你|顺手)?(?:设|定|安排)(?:上|好|了)?|我(?:已经|给你|替你|帮你|顺手)?(?:挂|加|记|填)(?:上|好|了)|我(?:已经|给你|替你|帮你|顺手)?(?:泡|晾|准备|放|摆|翻|塞|带|捎)(?:了|好)?|我(?:已经|给你|替你|帮你|顺手)?(?:盯|看着|守着|记着)(?:到|着|了)?|(?:给你|替你|帮你)(?:设|定|安排|挂|加|记|填)(?:上|好|了)?/;

const HEART_EVENT_CUES = Object.freeze({
  "sticky-note": {
    strong: /便签|纸条|小卡|贴(?:在|了)?|写(?:了)?|画(?:了)?|涂鸦|图案|小图/,
    weak: [/屏幕边缘/, /纸/, /角落/],
    minWeak: 1,
    conflict: /倒水|喝水|茶|咖啡/,
  },
  "jasmine-water": {
    strong: /茉莉|浇(?:了)?|花盆|叶子|植物/,
    weak: [/窗台/, /有光/, /水/, /湿/, /转向/],
    minWeak: 2,
    conflict: /便签|纸条|小灯/,
  },
  "desk-tidy": {
    strong: /桌角|整理|收拾|理(?:了)?|腾出|空出|归置|小角落/,
    weak: [/鼠标旁/, /键盘旁/, /位置/, /干净/],
    minWeak: 1,
  },
  "desk-lamp": {
    strong: /小灯|灯|点亮|拨亮|亮着|开着/,
    weak: [/光/, /照见/, /窗边/, /桌边/, /暗/],
    minWeak: 2,
    conflict: /月亮|月光|星星|星光|花瓶|花瓣/,
  },
  coffee: {
    strong: /咖啡|咖啡豆|冲咖啡|磨豆/,
    weak: [/杯/, /热气|苦|香/, /喝|垫/],
    minWeak: 2,
    conflict: /茶|曲奇|饼干|花|月亮|星星/,
  },
  tea: {
    strong: /茶|茶水|热茶|泡茶|沏茶/,
    weak: [/杯/, /热|烫/, /喝|垫/],
    minWeak: 2,
    conflict: /咖啡|曲奇|饼干|花|月亮|星星/,
  },
  cookie: {
    strong: /饼干|曲奇|点心/,
    weak: [/甜|酥/, /吃|垫/],
    minWeak: 1,
    conflict: /咖啡|茶|花|月亮|星星/,
  },
  cookies: {
    strong: /饼干|曲奇|点心/,
    weak: [/甜|酥/, /吃|垫/],
    minWeak: 1,
    conflict: /咖啡|茶|花|月亮|星星/,
  },
  flower: {
    strong: /花|花瓶|插花|插进|花瓣/,
    weak: [/枝/, /叶|香/],
    minWeak: 1,
    conflict: /咖啡|茶|曲奇|饼干|月亮|星星/,
  },
  bouquet: {
    strong: /花|花瓶|插花|插进|花瓣/,
    weak: [/枝/, /叶|香/],
    minWeak: 1,
    conflict: /咖啡|茶|曲奇|饼干|月亮|星星/,
  },
  star: {
    strong: /星星|星光|星灯|星星许愿灯/,
    weak: [/灯|光|亮|点/, /窗边|桌边/],
    minWeak: 1,
    conflict: /月亮|月光|月灯/,
  },
  moon: {
    strong: /月亮|月光|月灯|月亮许愿灯/,
    weak: [/灯|光|亮/, /窗边|桌边/],
    minWeak: 1,
    conflict: /星星|星光|星灯/,
  },
});

export function cleanHeartMessage(value, maxLength = HEART_MESSAGE_MAX) {
  let text = String(value || "")
    // 模型偶尔会把内部草稿一起返回；存档和展示前统一剥掉，不能只靠前端隐藏。
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/gi, "")
    .replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, "")
    .replace(/```(?:json|text|markdown)?/gi, "")
    .replace(/```/g, "")
    // 暂时保留换行，先识别“思考/最终答案”这类普通文本外壳。
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();

  // 兼容少数模型用普通文本写出的思考/答案外壳；正文之外的解释不应进入礼物卡。
  const finalMarker = text.match(/(?:^|\r?\n)\s*(?:最终答案|最终回复|最终文案|回复内容|给你的话|消息正文|正文|final answer|final response|answer)\s*[:：]?\s*/i);
  if (finalMarker) {
    text = text.slice(finalMarker.index + finalMarker[0].length).trim();
  } else {
    text = text.replace(/^\s*(?:思考|分析过程?|推理过程?|草稿|thoughts?|analysis|reasoning)\s*[:：]?[^\r\n]*(?:\r?\n|$)/i, "").trim();
  }
  return text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, maxLength).trim();
}

function parseJsonObject(raw) {
  const text = String(raw || "").replace(/```(?:json)?/gi, "").trim();
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function isHeartActive(heart) {
  return HEART_ACTIVE_STATUSES.has(heart?.status);
}

export function archiveExpiredHearts(data, now = Date.now()) {
  let changed = false;
  for (const heart of data.heartInbox || []) {
    if (!isHeartActive(heart)) continue;
    if (!isExpiredAt(heart.expiresAt, now)) continue;
    heart.status = "expired";
    heart.archivedAt = nowISO();
    changed = true;
  }
  return changed;
}

function sortNewest(hearts) {
  return hearts.slice().sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

// 回礼本身仍存放在 pendingVisits，这里只把与当前心意对应的公开字段找回来。
// 不把 visit id、推送状态等内部字段暴露给页面；旧数据只有 returnOfHeartId 时也能兼容。
export function findResponseVisit(data, heart) {
  const responseVisitId = heart?.responseVisitId;
  if (responseVisitId === undefined || responseVisitId === null) return null;
  const visit = (data?.pendingVisits || []).find(
    (item) => String(item?.id) === String(responseVisitId),
  );
  if (!visit?.isReturn) return null;
  const relatedHeartIds = Array.isArray(visit.returnOfHeartIds)
    ? visit.returnOfHeartIds.map(String)
    : visit.returnOfHeartId === undefined || visit.returnOfHeartId === null
      ? []
      : [String(visit.returnOfHeartId)];
  return relatedHeartIds.includes(String(heart.id)) ? visit : null;
}

export function publicHeart(heart, responseVisit = null) {
  const source = heart.gift || heart.item || { id: "", name: "一份小礼物", icon: "🎁", price: 0 };
  const eventType = heart.eventType || source.eventType || "gift";
  const gift = {
    id: source.id || "",
    name: source.name || "一份小礼物",
    icon: source.icon || "🎁",
    price: Number(source.price) || 0,
  };
  const sceneMeta = eventType === "scene"
    ? DEFAULT_HEART_SCENES.find((item) => item.id === source.id) || {}
    : {};
  const event = { ...sceneMeta, ...source, ...gift, eventType };
  const message = cleanHeartMessage(heart.message || "");
  const responded = Boolean(heart.respondedAt || heart.responseVisitId);
  const response = responded && responseVisit
    ? {
      type: responseVisit.type || "",
      itemId: responseVisit.itemId || "",
      itemName: responseVisit.itemName || "",
      icon: responseVisit.icon || "",
      createdAt: responseVisit.createdAt || heart.respondedAt || null,
    }
    : null;
  return {
    id: heart.id,
    partnerId: heart.partnerId,
    partnerName: heart.partnerName || heart.partnerId,
    eventType,
    sceneType: heart.sceneType || source.sceneType || "",
    gift,
    // 仅兼容旧版本已经落库的坏心意；正常生成失败会直接放弃，不用固定文案冒充模型留言。
    message: message || fallbackHeartMessage(event),
    createdAt: heart.createdAt,
    expiresAt: heart.expiresAt,
    status: heart.status,
    responded,
    // 只保留回礼的生活痕迹，不把它从信箱里变成“已完成任务”。
    response,
  };
}

export function getHeartSummary(data, now = Date.now()) {
  const archivedChanged = archiveExpiredHearts(data, now);
  const active = sortNewest(
    (data.heartInbox || []).filter(
      (heart) => isHeartActive(heart) && isVisiblePartner(data, heart.partnerId),
    ),
  );
  const lastRead = Number(data.lastReadHeartsTs) || 0;
  const hasNew = active.some((heart) => new Date(heart.createdAt).getTime() > lastRead);
  return {
    // 数量不截断：保留时长内的心意全部展示，过期由归档逻辑自然移除
    hearts: active.map((heart) => publicHeart(heart, findResponseVisit(data, heart))),
    omittedCount: 0,
    hasHearts: active.length > 0,
    hasNewHearts: hasNew,
    showHeartGuide: hasNew && !lastRead,
    archivedChanged,
  };
}

export function getActiveHearts(data, now = Date.now()) {
  archiveExpiredHearts(data, now);
  return sortNewest(
    (data.heartInbox || []).filter(
      (heart) => isHeartActive(heart) && isVisiblePartner(data, heart.partnerId),
    ),
  );
}

export function getUndeliveredHearts(data, now = Date.now()) {
  return getActiveHearts(data, now).filter((heart) => !heart.deliveredAt);
}

// 普通互动入口自动承接已送达/看过的主动心意作为回礼；一次互动可一并回应同一助手的全部未回应心意。
// 只认有效期内、已送达或已读的心意，未送达的不算收到；已回过的不会再绑定。
// 返回按时间旧→新排序，调用方取最后一条作为主回礼来源（最新一份）。
export function findReturnableHearts(data, partnerId, now = Date.now()) {
  archiveExpiredHearts(data, now);
  return (data.heartInbox || [])
    .filter((heart) => {
      if (heart?.partnerId !== partnerId || !isHeartActive(heart)) return false;
      if (!isVisiblePartner(data, heart.partnerId)) return false;
      if (heart.respondedAt || heart.responseVisitId) return false;
      if (!(heart.deliveredAt || heart.readAt || heart.status === "read")) return false;
      return true;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function markHeartsResponded(
  data,
  heartIds,
  visitId,
  respondedAt = nowISO(),
) {
  const wanted = new Set(Array.isArray(heartIds) ? heartIds : []);
  let count = 0;
  for (const heart of data.heartInbox || []) {
    if (!wanted.has(heart.id)) continue;
    if (!isHeartActive(heart) || heart.respondedAt || heart.responseVisitId) continue;
    heart.respondedAt = respondedAt;
    heart.responseVisitId = visitId;
    count++;
  }
  return count;
}

export function markHeartResponded(
  data,
  heartId,
  visitId,
  respondedAt = nowISO(),
) {
  const heart = (data.heartInbox || []).find((item) => item?.id === heartId);
  if (!heart || !isHeartActive(heart) || heart.respondedAt || heart.responseVisitId) {
    return false;
  }
  heart.respondedAt = respondedAt;
  heart.responseVisitId = visitId;
  return true;
}

export function markHeartsDelivered(data, ids, deliveredAt = nowISO()) {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  let count = 0;
  for (const heart of data.heartInbox || []) {
    if (!wanted.has(String(heart.id)) || !isHeartActive(heart) || heart.deliveredAt) continue;
    heart.deliveredAt = deliveredAt;
    count++;
  }
  return count;
}

// “先收着”只收起风铃提醒，心意仍留在主页面信箱里；
// 单独落一个字段，避免把用户未真正打开信箱误记成已读。
export function markHeartsBellDismissed(data, ids, dismissedAt = nowISO()) {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  let count = 0;
  for (const heart of data.heartInbox || []) {
    if (
      !wanted.has(String(heart.id)) ||
      !isHeartActive(heart) ||
      String(heart.status || "").toLowerCase() !== "unread" ||
      heart.bellDismissedAt
    ) continue;
    heart.bellDismissedAt = dismissedAt;
    count++;
  }
  return count;
}

export function markHeartsRead(data, readAt = Date.now()) {
  archiveExpiredHearts(data, readAt);
  let changed = false;
  for (const heart of data.heartInbox || []) {
    if (heart.status === "unread") {
      heart.status = "read";
      heart.readAt = new Date(readAt).toISOString();
      changed = true;
    }
  }
  if (Number(data.lastReadHeartsTs) !== readAt) {
    data.lastReadHeartsTs = readAt;
    changed = true;
  }
  return changed;
}

export function chooseHeartEvent(
  items,
  random = Math.random,
  scenes = DEFAULT_HEART_SCENES,
  preferences = null,
  temperament = null,
  recentIds = [],
) {
  const gifts = (items || [])
    .filter((item) => item?.id && item?.name)
    .map((item) => ({ ...item, eventType: "gift" }));
  const configuredScenes = Array.isArray(scenes) ? scenes : DEFAULT_HEART_SCENES;
  let availableScenes = configuredScenes
    .filter((item) => item?.id && item?.name && item.seedOnly !== true)
    .filter((item) => !LEGACY_HEART_SCENE_IDS.has(String(item.id)))
    .map((item) => ({ ...item, eventType: "scene" }));
  // 旧版可能把固定场景列表落进 data.json；过滤后没有可用场景时回到开放情境，不能让历史数据把旧骨架复活。
  if (!availableScenes.length && configuredScenes !== DEFAULT_HEART_SCENES) {
    availableScenes = DEFAULT_HEART_SCENES
      .filter((item) => item.id === CONTEXTUAL_HEART_SCENE_ID)
      .map((item) => ({ ...item, eventType: "scene" }));
  }
  if (!gifts.length && !availableScenes.length) {
    return { id: "coffee", name: "咖啡", icon: "☕", price: 25, eventType: "gift" };
  }
  // 送礼仍是主轴，异步现场小事穿插出现；普通实时互动不进入这条信箱。
  const sceneChance = Number.isFinite(Number(temperament?.sceneChance))
    ? Math.max(0.15, Math.min(0.5, Number(temperament.sceneChance)))
    : 0.3;
  const useScene = availableScenes.length > 0
    && (gifts.length === 0 || random() >= 1 - sceneChance);
  const pool = useScene ? availableScenes : gifts;
  if (!pool.length) return { ...availableScenes[0] };
  const preferredIds = useScene ? preferences?.sceneIds : preferences?.giftIds;
  const chosenPool = choosePreferredItems(pool, preferredIds, recentIds);
  return {
    ...chosenPool[Math.floor(Math.max(0, Math.min(0.999999, random())) * chosenPool.length)],
  };
}

function resolveHeartExpressionMode(mode) {
  const id = typeof mode === "string" ? mode : mode?.id;
  return HEART_EXPRESSION_MODES.find((item) => item.id === id) || HEART_EXPRESSION_MODES[0];
}

export function chooseHeartExpressionMode(recentModes = [], random = Math.random) {
  const recent = new Set(Array.isArray(recentModes) ? recentModes : []);
  const fresh = HEART_EXPRESSION_MODES.filter((mode) => !recent.has(mode.id));
  const pool = fresh.length ? fresh : HEART_EXPRESSION_MODES;
  const value = Number(random());
  const ratio = Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0;
  return pool[Math.floor(ratio * pool.length)];
}

function inferHeartExpressionMode(heart) {
  const stored = resolveHeartExpressionMode(heart?.expressionMode);
  if (heart?.expressionMode && stored.id === heart.expressionMode) return stored.id;
  const eventId = heart?.gift?.id || heart?.item?.id;
  if (LEGACY_HEART_MODE_BY_SCENE[eventId]) return LEGACY_HEART_MODE_BY_SCENE[eventId];
  return "";
}

export function recentHeartExpressionModes(
  data,
  partnerId,
  now = Date.now(),
  windowMs = 3 * 24 * 60 * 60 * 1000,
) {
  const modes = [];
  const seen = new Set();
  const hearts = (data?.heartInbox || [])
    .filter((heart) => {
      if (heart?.partnerId !== partnerId) return false;
      const createdAt = new Date(heart.createdAt).getTime();
      return Number.isFinite(createdAt) && now - createdAt <= windowMs;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const heart of hearts) {
    const mode = inferHeartExpressionMode(heart);
    if (mode && !seen.has(mode)) {
      seen.add(mode);
      modes.push(mode);
    }
  }
  return modes;
}

export function recentHeartMessageSamples(
  data,
  partnerId,
  now = Date.now(),
  windowMs = 3 * 24 * 60 * 60 * 1000,
  limit = 3,
) {
  return (data?.heartInbox || [])
    .filter((heart) => {
      if (heart?.partnerId !== partnerId) return false;
      const createdAt = new Date(heart.createdAt).getTime();
      return Number.isFinite(createdAt) && now - createdAt <= windowMs;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((heart) => cleanHeartMessage(heart.message || "", 90))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 3));
}

function giftCategory(gift) {
  return gift?.heartCategory || GIFT_HEART_CATEGORIES[gift?.id] || "object";
}

function fallbackHeartMessage(event, temperament) {
  if (event?.eventType === "scene") return event.fallback || "我路过时顺手替你留了一点小小的痕迹。";

  const icon = event?.icon || "🎁";
  const name = event?.name || "小东西";
  const category = giftCategory(event);
  const pools = {
    drink: [
      `顺手给你带了${icon}${name}，放在手边，热气还没散。`,
      `路过时给你捎了${icon}${name}，先放在你桌边，别忙忘了它。`,
    ],
    snack: [
      `给你带了${icon}${name}，放在桌边，忙累了就拿一块。`,
      `路过小铺时捎了${icon}${name}，先给你留在手边。`,
    ],
    flower: [
      `顺手给你带了${icon}${name}，喜欢的话可以插进花瓶里。`,
      `看见${icon}${name}的时候觉得很适合你，就顺手带了一份回来。`,
    ],
    light: [
      `给你带了${icon}${name}，放在桌角，晚上亮起来会很好看。`,
      `路过时捎了${icon}${name}，给你的桌边添一点安静的光。`,
    ],
    object: [
      `路过时给你捎了${icon}${name}，先放在你这边，觉得合适就留下。`,
      `看见${icon}${name}的时候想到了你，就顺手带了一份回来。`,
    ],
  };
  const pool = pools[category] || pools.object;
  const index = temperament?.tag ? temperament.tag.length % pool.length : 0;
  return pool[index];
}

export function buildHeartPrompt({
  partnerName,
  description,
  voiceDescription,
  memory,
  userName,
  event,
  gift,
  temperament,
  voiceProfile,
  voiceVariant,
  expressionMode,
  recentExpressionModes = [],
  recentHeartSamples = [],
  interactionSeeds = [],
}) {
  const subject = event || gift || {};
  const eventType = subject.eventType || "gift";
  const profile = voiceProfile || deriveHeartVoice(
    mergeHeartVoiceDescription(description, voiceDescription),
    temperament,
  );
  const variant = voiceVariant || selectHeartVoiceVariant(
    `${partnerName}:${subject.id || eventType}`,
    profile,
  );
  const mode = resolveHeartExpressionMode(expressionMode);
  const recentModeLabels = (Array.isArray(recentExpressionModes) ? recentExpressionModes : [])
    .map((item) => resolveHeartExpressionMode(item).label)
    .filter((label, index, list) => list.indexOf(label) === index);
  const recentModeLine = recentModeLabels.length
    ? `最近几份心意已经走过这些方向：${recentModeLabels.join("、")}。本条要换一个方向，不能只换同义词。`
    : "这是近期没有使用过的表达方向，尽量让句子和旧样本拉开距离。";
  const recentSamplesLine = (Array.isArray(recentHeartSamples) && recentHeartSamples.length)
    ? `最近几份心意的原句（只用于避开，不要仿写）：\n${recentHeartSamples.map((sample) => `- ${sample}`).join("\n")}`
    : "";
  const isContextualScene = subject.id === CONTEXTUAL_HEART_SCENE_ID;
  const eventContext = isContextualScene
    ? `当前不是一件预设物件，也没有固定地点。请从当天已经出现的事实里挑一个能成立的落点。\n可参考的生活入口（只作方向，不要照抄）：天气或光线、声音或气味、出门安排、身体节奏、最近聊过的小事、一个轻微玩笑、直接想到的一句话。已有线索只有日程或天气时，直接围绕那件安排说一句也成立，不必再补物件或动作。\n没有事实支撑时，写观察、想到或祝愿，不要为了具体而新增物品、饮品、衣物、地点、提醒或已经完成的动作。\n旧样本“便签、浇花、整理桌角、留灯”只是用来说明尺度，本条不要默认使用它们。`
    : eventType === "scene"
      ? `当前事件（必须写对）：${subject.icon || ""}${subject.name || "一点小痕迹"}\n具体动作参考：${subject.promptContext || "留下一个轻微、可想象的环境变化"}`
      : `当前事件（必须写对）：${subject.icon || ""}${subject.name || "一件小礼物"}\n物件类别：${giftCategory(subject)}。写清它被带来、放下、摆好或自然使用的场景，不要把所有东西都写成“使用”。`;
  const dialect = typeof subject.dialect === "string" && subject.dialect.trim()
    ? subject.dialect.trim()
    : "";
  const dialectLine = dialect
    ? `\n你说话带一点口癖（这是你的人设，不是临时表演）：\n${dialect}\n${deriveDialectFlavor(dialect)}`
    : "";
  const voiceLines = profile.instructions.map((line) => `- ${line}`).join("\n");
  const temperamentLine = [
    temperament?.surfaceTag ? `表层：${temperament.surfaceTag}` : "",
    temperament?.innerTag ? `里层：${temperament.innerTag}` : "",
    temperament?.style ? `当前表现：${temperament.style}` : "",
  ].filter(Boolean).join("；") || "自然，有自己的脾气";
  const seedsLine = (Array.isArray(interactionSeeds) && interactionSeeds.length)
    ? `
最近你们聊过的话题或当前情境（这里明确出现的人、时间、天气、安排和物品，才可以写成事实；不必全用，挑一个自然的即可）：
${interactionSeeds.map((seed, i) => `${i + 1}. ${seed}`).join("\n")}`
    : `
当前没有可引用的近期情境。可以写一个直接想到${userName}的短句或轻微观察，不要自行补出具体物品、饮品、衣物、地点、提醒或已经完成的动作。`;
  const factBoundaryLine = `
事实边界：
- “用户要做某事”不等于“你已经替用户做了另一件事”；不能把安排改写成已经设好、挂上、盯住提醒，或准备好饮料、整理好物品。
- 长期记忆只作语气和话题参考，其中的物品不能自动变成今天正在现场的东西。
- 天气示例里的“带伞、添衣”等只是表达方向，当前情境没有明确提到时，不要把它们写成用户已有的物品。
- 待办或提醒只能按“要做/准备做/将要发生”来提及，不能写成闹钟已经响了、提醒已经挂上或你已经替用户盯着。`;
  const objectRule = isContextualScene
    ? "- 只有当前事件或可引用事实明确出现了饮品、食物、花、装饰或其他物件，才可以写它被带来、放下、摆好或使用；来源没有时，改写观察、安排、感受或想到的一句话"
    : "- 当前事件已有明确物件时，可以写它被带来、放下、摆好或自然使用的场景；例如花可以插进花瓶，但不要把当前物件换成别的东西";
  const modeInstruction = (!interactionSeeds.length && isContextualScene)
    ? `${mode.instruction} 当前没有当天情境，不要生成“今天”“窗外”“桌上”等现场事实，改写直接想到的一句话或不依赖物件的感受。`
    : mode.instruction;
  const stylePair = `
同一件事，两种写法对照（你要的是第二种）：
- 别扭版（禁止模仿）：把所有背景都塞进一条消息，还顺手补出几个没有出处的物件和动作。
- 自然版（参考这版的落点和语气）：只抓一个已有线索，留一句像这个助手临时想到的话，事实不够时就少写一点。`;
  return `你是性格鲜明的助手“${partnerName}”。现在你不在实时聊天，而是趁一个空档，给${userName}留下一份异步心意。

你的简短性格描述：
${description || "（自然、可靠、有自己的脾气）"}

可观察的说话背景：
${voiceDescription || description || "（从具体动作开始，关心藏在做法里）"}

你的声音指纹（必须落实成句子动作，不要只写“温柔”“克制”这些形容词）：
${voiceLines}
${dialectLine}

当前相处气质：${temperamentLine}

本条表达方向：${mode.label}
${modeInstruction}
${recentModeLine}
${recentSamplesLine}

可能有用的近期记忆（只作语气和话题参考，不把其中物品写成今天已经存在）：
${memory || "（没有可用记忆，不要编造具体经历）"}
${seedsLine}
${factBoundaryLine}

${eventContext}

${stylePair}

本条写法：${variant.shapeInstruction}
本条标点倾向：${variant.punctuationInstruction}

这段话会晚些被看到。你写的是一个已经发生、被留下的异步现场，不是实时聊天，不是在复述一个互动按钮。
成稿要像这个助手真的会留下的短消息，只选一个具体落点，别把所有背景塞进来。

写作要求：
- 一条只承担一个主动作：送来、留下、照看、吐槽或提醒，选一个就收
- 不要默认把“放置位置＋温度细节＋体贴提醒”三项每次都写齐；只留最能认出这个人的一两步
- 可以只有一句，也可以两三句；允许省略主语、停顿、轻问、反问、感叹或换行，不必每条都以句号收尾
- 不要把“顺手、路过、放在手边/桌角/窗边、记得、别忘了、你忙完”当成固定骨架，能省就省，换一种结构
- 标点不要固定只用逗号和句号；本条标点倾向是偏好，不是硬性要求，能自然使用就用，不能为了凑符号硬塞
- 如果当前有预设事件，正文必须和它一致，不能抽到便签却写成倒水，抽到茶却写成花；如果写不出，就只写事件本身的一个细节
- 如果当前是“今天的一点小心意”，不要自行假设固定物件或地点；优先使用已有的当天线索，写一个别的、具体、成立的落点
${objectRule}
- 便签、浇花、整理桌角、留灯只是旧方向示例，只有当天线索确实支持时才使用，不能轮流套用
- 具体物件、饮品、衣物、地点、提醒和已经完成的动作都要有出处；天气和待办示例里的动作不能当作已经发生的事实
- 禁止实时互动措辞：陪你聊天、和你玩、陪你待着、等你回复、回我、现在找我、随时联系
- 不要感谢、汇报、布置任务、询问对方为什么没回，也不要暗示对方欠你回应
- 不要用“不用特意回”“看到了就行”这类统一免责句假装有分寸
- 不要散文腔、比喻、哲学和抒情大词，不要“不是……而是……”句式
- 不要编造记忆里没有的经历，不要点破“我记得你说过”
- 先删掉空话和解释，只输出最后准备留给对方看的正文

18 到 80 字，只输出消息正文，不要引号、标题、JSON、markdown 或思考过程。`;
}

export function reusesDefaultHeartScene(text, context = []) {
  const draft = cleanHeartMessage(text);
  const contextText = (Array.isArray(context) ? context : [context])
    .filter((item) => typeof item === "string")
    .join("\n");
  return DEFAULT_HEART_SCENE_CUES.some((cue) => cue.draft.test(draft) && !cue.context.test(contextText));
}

function unsupportedHeartFactHints(text, context = []) {
  const draft = cleanHeartMessage(text);
  const contextText = (Array.isArray(context) ? context : [context])
    .filter((item) => typeof item === "string")
    .join("\n");
  const hints = HEART_FACT_OBJECT_CUES
    .filter((cue) => cue.draft.test(draft) && !cue.context.test(contextText))
    .map((cue) => cue.draft.source.replace(/^\\(|\\)$/g, ""));
  if (
    HEART_UNSUPPORTED_COMPLETED_ACTION_RE.test(draft)
    && !HEART_UNSUPPORTED_COMPLETED_ACTION_RE.test(contextText)
  ) {
    hints.push("已完成动作或提醒操作");
  }
  return hints;
}

export function hasUnsupportedHeartFacts(text, context = []) {
  return unsupportedHeartFactHints(text, context).length > 0;
}

export function isHeartEventConsistent(text, event) {
  if (event?.id === CONTEXTUAL_HEART_SCENE_ID) return true;
  const cue = HEART_EVENT_CUES[String(event?.id || "")];
  if (!cue) return true;
  const value = cleanHeartMessage(text);
  if (cue.conflict?.test(value)) return false;
  if (cue.strong?.test(value)) return true;
  const weakHits = (cue.weak || []).filter((pattern) => pattern.test(value)).length;
  return weakHits >= Number(cue.minWeak || 0);
}

export function hasHeartLiveFlavor(text) {
  return HEART_LIVE_FLAVOR_RE.test(String(text || ""));
}

async function generateHeartMessage({
  partnerId,
  partnerName,
  description,
  voiceDescription,
  memory,
  userName,
  event,
  gift,
  temperament,
  seed,
  signal,
  expressionMode,
  recentExpressionModes = [],
  recentHeartSamples = [],
  interactionSeeds = [],
}) {
  const subject = event || gift || {};
  const llmConfig = getLLMConfig();
  if (!llmConfig.providerId || !llmConfig.modelId) {
    console.error("[闲不住] 主动心意跳过：未配置模型，不使用固定文案代替模型生成");
    return failureResult("model_not_configured", false);
  }

  const voiceProfile = deriveHeartVoice(
    mergeHeartVoiceDescription(description, voiceDescription),
    temperament,
  );
  // 方言口癖：读助手设定里的 *-dialect 块；没配就空串，生成链路零变化。
  const dialect = loadAgentDialect(partnerId);
  const voiceVariant = selectHeartVoiceVariant(
    seed || `${partnerId}:${subject.id || "heart"}`,
    voiceProfile,
  );
  let feedback = "";
  let lastFailure = { kind: "content_rejected", retryable: true, maxRetries: 1 };
  for (let attempt = 0; attempt < HEART_MESSAGE_MAX_ATTEMPTS; attempt++) {
    const prompt = buildHeartPrompt({
      partnerName,
      description,
      voiceDescription,
      memory,
      userName,
      event: { ...subject, dialect },
      gift: { ...subject, dialect },
      temperament,
      voiceProfile,
      voiceVariant,
      expressionMode,
      recentExpressionModes,
      recentHeartSamples,
      interactionSeeds,
    }) + (feedback ? `\n上一版被退回：${feedback}\n请换一种更像这个人的写法，并换开表达方向。` : "");
    try {
      const draft = cleanHeartMessage(await callLLM(prompt, {
        providerId: llmConfig.providerId,
        modelId: llmConfig.modelId,
        temperature: 0.9,
        maxTokens: 220,
        timeout: 15000,
        signal,
      }));
      if (!draft || draft.length < HEART_MESSAGE_MIN || draft.length > HEART_MESSAGE_DRAFT_MAX) {
        feedback = "长度不合适；用 18 到 80 字写一条像这个人的短消息，不要补解释";
        continue;
      }
      if (!isHeartEventConsistent(draft, subject)) {
        feedback = `事件写错了，当前只能围绕“${subject.name || "这件心意"}”落一个具体细节，不能换成别的物件`;
        continue;
      }
      if (subject.id === CONTEXTUAL_HEART_SCENE_ID && reusesDefaultHeartScene(draft, [memory, ...interactionSeeds])) {
        feedback = "又回到了旧的便签、浇花、整理桌角或留灯骨架；请换成当天情境、感官观察、身体节奏、最近话题或一个轻微玩笑";
        continue;
      }
      if (subject.id === CONTEXTUAL_HEART_SCENE_ID) {
        const factHints = unsupportedHeartFactHints(draft, interactionSeeds);
        if (factHints.length) {
          feedback = `出现了当前事实来源里没有的具体内容（${factHints.join("、")}），或声称已经替对方完成了某个动作；只引用情境里明确出现的人、时间、天气、安排和物品，事实不足就少写一点`;
          continue;
        }
      }
      if (hasAiFlavor(draft) || hasHeartLiveFlavor(draft)) {
        feedback = "有模型腔或统一免责/实时互动腔；删掉空话，保留一个具体动作，用这个助手自己的断句重写";
        continue;
      }
      try {
        const reviewRaw = await callLLM(buildReviewPrompt(draft, {
          kind: "heart",
          partnerName,
          event: { ...subject, dialect },
          voiceProfile,
          voiceVariant,
          expressionMode,
          recentExpressionModes,
          interactionSeeds,
        }), {
          providerId: llmConfig.providerId,
          modelId: llmConfig.modelId,
          temperature: 0.2,
          maxTokens: 280,
          timeout: 10000,
          signal,
        });
        const review = parseReview(reviewRaw);
        if (!review.pass) {
          feedback = [...(review.reasons || []), review.suggestion || ""].filter(Boolean).join("；");
          continue;
        }
      } catch {
        // 审核员不可用时，保留规则初审通过的正文；不能因为审核服务暂时抖动而整条消失。
      }
      return { ok: true, text: draft };
    } catch (error) {
      lastFailure = classifyHeartGenerationError(error);
      console.error(`[闲不住] 主动心意生成第 ${attempt + 1} 次失败:`, error?.message || error);
      // API/配置类故障交给外层退避；这里继续打同一接口只会放大额度和限流压力。
      break;
    }
  }
  return failureResult(lastFailure.kind, lastFailure.retryable, lastFailure.maxRetries);
}

export function parseTemperamentAnalysis(raw) {
  const value = parseJsonObject(raw);
  if (!value) return null;
  const surface = typeof value.surface === "string" ? value.surface.trim() : "";
  const inner = typeof value.inner === "string" ? value.inner.trim() : "";
  if (!TEMPERAMENT_TAGS.includes(surface) || !TEMPERAMENT_TAGS.includes(inner)) return null;
  return { surface, inner };
}

function buildTemperamentPrompt(description) {
  return `请根据下面的助手性格描述，判断她在“主动给用户送一份小心意”这件事上的两层气质。
表面气质和里层气质可以相同，也可以有一点反差。只能从以下标签中选择：${TEMPERAMENT_TAGS.join("、")}。
只输出 JSON，不要解释：{"surface":"标签","inner":"标签"}

性格描述：
${String(description || "").slice(0, 5000)}`;
}

export async function analyzePartnerTemperament(partnerId) {
  const description = loadAgentDescription(partnerId);
  const inferred = inferTemperamentTags(description);
  const fallback = createTemperamentConfig(inferred.surface, inferred.inner, "fallback");
  const llmConfig = getLLMConfig();
  if (!llmConfig.providerId || !llmConfig.modelId) return fallback;

  try {
    const raw = await callLLM(buildTemperamentPrompt(description), {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 0.2,
      maxTokens: 100,
      timeout: 15000,
    });
    const parsed = parseTemperamentAnalysis(raw);
    if (!parsed) return fallback;
    return createTemperamentConfig(parsed.surface, parsed.inner, "llm");
  } catch (error) {
    console.error(`[闲不住] 自动分析 ${partnerId} 气质失败:`, error?.message || error);
    return fallback;
  }
}

export async function ensurePartnerTemperament(partnerId) {
  const current = loadData();
  const cfg = current.partnerConfig?.[partnerId];
  if (!cfg) return null;
  if (cfg.temperamentSource === "user") return normalizeTemperamentConfig(cfg);
  const analyzedAt = cfg.temperamentAnalyzedAt ? new Date(cfg.temperamentAnalyzedAt).getTime() : 0;
  if (cfg.temperamentSource === "llm" && analyzedAt && Date.now() - analyzedAt < TEMPERAMENT_RETRY_MS) {
    return normalizeTemperamentConfig(cfg);
  }
  if (cfg.temperamentSource === "fallback" && analyzedAt && Date.now() - analyzedAt < TEMPERAMENT_RETRY_MS) {
    return normalizeTemperamentConfig(cfg);
  }

  const analyzed = await analyzePartnerTemperament(partnerId);
  const analyzedAtIso = nowISO();
  return withDataLock(() => {
    const data = loadData();
    const target = data.partnerConfig?.[partnerId];
    if (!target) return null;
    if (target.temperamentSource === "user") return normalizeTemperamentConfig(target);
    target.surfaceLayer = analyzed.surfaceLayer;
    target.innerLayer = analyzed.innerLayer;
    target.temperamentSource = analyzed.temperamentSource;
    target.temperamentAnalyzedAt = analyzedAtIso;
    if (!saveData(data)) return normalizeTemperamentConfig(target);
    return normalizeTemperamentConfig(target);
  });
}

function recentHeartEventIds(data, partnerId, now = Date.now(), windowMs = 3 * 24 * 60 * 60 * 1000) {
  return (data.heartInbox || [])
    .filter((heart) => {
      if (heart?.partnerId !== partnerId) return false;
      const createdAt = new Date(heart.createdAt).getTime();
      return Number.isFinite(createdAt) && now - createdAt <= windowMs;
    })
    .map((heart) => heart.gift?.id || heart.item?.id)
    .filter(Boolean);
}

// ─── 有来处的主动（翻旧账）：读该助手最近会话的少量真实用户消息作为引子 ───
// 复用会话文件尾部扫描；只取最近几条“真实用户消息”（跳过插件自注入的送达文本），
// 返回去重后的短引子列表（最多 3 条，每条保留当前情境或近期消息的关键事实），供生成 prompt 注入。
// 零维护：按需读取，不持续监听主对话，不维护世界状态——闲不住不因此变重。

function heartSeedTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function heartSeedText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && p.type === "text")
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  return "";
}

function isHeartSeedInjected(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^[📬📦🎁🧠✉]/.test(t)) {
    return /收到来自|给你带了东西|拍了拍你|的一份回礼|的一份礼物|的一条互动|的回应|一起回应/.test(t);
  }
  if (t === "重启！") return true;
  return /^(?:讲个冷笑话：|考考你：|你知道吗：|突然想到：|如果世界上有10种人)/.test(t);
}

export function extractHeartContextSeed(text, maxChars = 240) {
  const raw = String(text || "").replace(/\[[^\]]+\]/g, "").trim();
  if (!raw) return "";
  const today = raw.match(/(?:【今日时光】|今日时光)[\s\S]*?(?=【(?:已收好的上一生活日|近期回忆|任务续接)|$)/);
  if (!today) return raw.slice(0, maxChars);
  const lines = today[0]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => (
      index === 0
      || /^(?:今天是|【窗外】|今日待办|天气|当前时间|日期|今天)/.test(line)
    ))
    .filter((line) => !/天气可以借|不必每轮|不要照抄|自然带出/.test(line));
  return lines.join(" ").slice(0, maxChars);
}

export function readRecentInteractionSeeds(agentId, {
  maxSeeds = 3,
  maxChars = 240,
  now = Date.now(),
  lookbackMs = 7 * 24 * 60 * 60 * 1000,
  readTail = readSessionTail,
} = {}) {
  const sessionPath = findLatestSessionPath(agentId);
  if (!sessionPath) return [];
  return readTail(sessionPath, {
    maxSeeds,
    maxChars,
    now,
    lookbackMs,
  });
}

export function readSessionTail(filePath, {
  maxSeeds = 3,
  maxChars = 60,
  now = Date.now(),
  lookbackMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  const seeds = [];
  const seen = new Set();
  try {
    const CHUNK = 64 * 1024;
    const fd = fs.openSync(filePath, "r");
    try {
      let position = fs.fstatSync(fd).size;
      let carry = Buffer.alloc(0);
      while (position > 0 && seeds.length < maxSeeds) {
        const readSize = Math.min(CHUNK, position);
        position -= readSize;
        const chunk = Buffer.alloc(readSize);
        fs.readSync(fd, chunk, 0, readSize, position);
        const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        let lineEnd = combined.length;
        for (let i = combined.length - 1; i >= 0; i--) {
          if (combined[i] !== 0x0a) continue;
          const line = combined.subarray(i + 1, lineEnd).toString("utf-8").trim();
          if (line) {
            try {
              const d = JSON.parse(line);
              const message = d?.message && typeof d.message === "object" ? d.message : d;
              if (message?.role !== "user") { lineEnd = i; continue; }
              const ts = heartSeedTimestamp(message.timestamp ?? d.timestamp ?? d.ts);
              if (Number.isFinite(ts) && now - ts > lookbackMs) { lineEnd = i; continue; }
              const text = heartSeedText(message);
              if (text && !isHeartSeedInjected(text)) {
                const clean = extractHeartContextSeed(text, maxChars);
                if (clean && !seen.has(clean)) {
                  seen.add(clean);
                  seeds.push(clean);
                }
              }
            } catch {}
          }
          if (seeds.length >= maxSeeds) break;
          lineEnd = i;
        }
        carry = Buffer.from(combined.subarray(0, lineEnd));
      }
      if (seeds.length < maxSeeds && carry.length) {
        try {
          const d = JSON.parse(carry.toString("utf-8").trim());
          const message = d?.message && typeof d.message === "object" ? d.message : d;
          if (message?.role === "user") {
            const text = heartSeedText(message);
            if (text && !isHeartSeedInjected(text)) {
              const clean = extractHeartContextSeed(text, maxChars);
              if (clean && !seen.has(clean)) seeds.push(clean);
            }
          }
        } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 读不到就当没有
  }
  return seeds;
}

export async function generateAndSaveHeart({ entry, partnerId }) {
  const initial = loadData();
  if (initial.heartSettings?.enabled === false) {
    return failureResult("disabled", false);
  }
  const initialCfg = initial.partnerConfig?.[partnerId];
  if (!initialCfg || initialCfg.hidden) {
    return failureResult("partner_unavailable", false);
  }

  // 暂存上限护栏：该助手未送达的暂存心意已满，不烧模型再生成（旧的不堆）
  const stageCap = Number.isFinite(Number(initial.heartSettings?.stageCapPerPartner))
    ? Math.max(1, Math.round(Number(initial.heartSettings.stageCapPerPartner)))
    : 2;
  const stagedCount = (initial.heartInbox || []).filter((heart) => {
    if (heart?.partnerId !== partnerId) return false;
    return heart.status === "unread" && !heart.deliveredAt && heart.stagedAt;
  }).length;
  if (stagedCount >= stageCap) {
    return failureResult("stage_cap_reached", false);
  }

  const temperamentConfig = await ensurePartnerTemperament(partnerId);
  const data = loadData();
  if (data.heartSettings?.enabled === false) {
    return failureResult("disabled", false);
  }
  const cfg = data.partnerConfig?.[partnerId];
  if (!cfg || cfg.hidden) {
    return failureResult("partner_unavailable", false);
  }
  const vars = cfg.variables || {};
  const temperament = effectiveTemperament(temperamentConfig || cfg, vars.affection);
  const description = loadAgentDescription(partnerId);
  const voiceDescription = loadAgentVoiceDescription(partnerId);
  const memory = loadAgentMemory(partnerId);
  const preferences = deriveHeartPreferences({
    description,
    temperamentTag: temperament.tag,
  });
  const recentIds = recentHeartEventIds(data, partnerId);
  const recentExpressionModes = recentHeartExpressionModes(data, partnerId);
  const recentHeartSamples = recentHeartMessageSamples(data, partnerId);
  const event = chooseHeartEvent(
    data.shopItems,
    Math.random,
    data.heartScenes,
    preferences,
    temperament,
    recentIds,
  );
  const expressionMode = chooseHeartExpressionMode(recentExpressionModes, Math.random);
  const partnerName = cfg.name || partnerId;
  const userName = sanitizeUserName(getUserDisplayName());
  // 有来处的主动：读最近互动作为引子，让每句心意都有来处
  const seeds = readRecentInteractionSeeds(partnerId, { maxSeeds: 4, maxChars: 240 });
  const generated = await generateHeartMessage({
    partnerId,
    partnerName,
    description,
    voiceDescription,
    memory,
    userName,
    event,
    gift: event,
    temperament,
    seed: entry?.id || `${partnerId}:${event.id || "heart"}`,
    expressionMode,
    recentExpressionModes,
    recentHeartSamples,
    interactionSeeds: seeds,
  });
  if (!generated?.ok) return generated;
  const message = generated.text;
  const createdAt = nowISO();
  // 心意保留时长统一由 heartSettings 决定（默认 72h），不再随助手气质 forgetDays 变化；
  // 期内全部展示，过期由 archiveExpiredHearts 自然移除。
  const retentionHours = Number.isFinite(Number(data.heartSettings?.retentionHours))
    ? Math.max(1, Math.min(336, Number(data.heartSettings.retentionHours)))
    : 72;
  const heart = {
    id: `heart-${nextId()}`,
    partnerId,
    partnerName,
    eventType: event.eventType || "gift",
    sceneType: event.sceneType || "",
    expressionMode: expressionMode.id,
    gift: {
      id: event.id,
      name: event.name,
      icon: event.icon || "🎁",
      price: Number(event.price) || 0,
    },
    message: cleanHeartMessage(message),
    createdAt,
    expiresAt: new Date(new Date(createdAt).getTime() + retentionHours * 60 * 60 * 1000).toISOString(),
    status: "unread",
    deliveredAt: null,
    // 合适的时机：生成即暂存（stagedAt），投递时机由心跳闸决定（补 deliveredAt）
    stagedAt: createdAt,
    sourcePlanId: entry.id,
  };

  return withDataLock(() => {
    const fresh = loadData();
    const planEntry = fresh.heartPlan?.entries?.find((item) => item.id === entry.id);
    if (fresh.heartSettings?.enabled === false) {
      if (planEntry && planEntry.status === "generating") {
        planEntry.status = "cancelled";
        planEntry.cancelledAt = nowISO();
        planEntry.nextAttemptAt = null;
        planEntry.cancelReason = "disabled";
        fresh.heartPlan = {
          date: null,
          frequency: fresh.heartSettings?.frequency || "low",
          entries: [],
        };
        saveData(fresh);
      }
      return failureResult("disabled", false);
    }
    if (!planEntry || planEntry.status !== "generating") {
      return failureResult("stale_plan", false);
    }
    if (!Array.isArray(fresh.heartInbox)) fresh.heartInbox = [];
    fresh.heartInbox.push(heart);
    planEntry.status = "delivered";
    planEntry.heartId = heart.id;
    planEntry.deliveredAt = createdAt;
    delete planEntry.nextAttemptAt;
    delete planEntry.failureReason;
    delete planEntry.failureKind;
    delete planEntry.lastFailureAt;
    delete planEntry.retryLimit;
    delete planEntry.retryExhausted;
    if (!saveData(fresh)) {
      return failureResult("save_failed", true);
    }
    console.log(`[闲不住] 主动心意已送达: ${partnerId} → ${heart.gift.name}`);
    return { ok: true, heart: publicHeart(heart) };
  });
}

