// lib/hearts.js — 主动心意生成、信箱状态与回应
// 生成阶段允许异步调模型；真正改 data.json 的地方统一走 withDataLock。

import {
  loadData,
  nowISO,
  nextId,
  saveData,
  withDataLock,
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
  deriveHeartVoice,
  hasAiFlavor,
  loadAgentDescription,
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
const DEFAULT_HEART_SCENES = Object.freeze([
  {
    id: "sticky-note",
    eventType: "scene",
    sceneType: "trace",
    name: "屏幕边缘的一张便签",
    icon: "📝",
    promptContext: "在电脑屏幕边缘贴了一张小便签，顺手画了一个小图案",
    fallback: "我在你屏幕边缘贴了张小便签，顺手画了个小图案，路过时记得看一眼。",
  },
  {
    id: "jasmine-water",
    eventType: "scene",
    sceneType: "care",
    name: "给窗台的茉莉浇水",
    icon: "🌿",
    promptContext: "替窗台上的那盆茉莉浇了点水，还把花盆转向了有光的一边",
    fallback: "我路过窗台时给你的茉莉浇了点水，还把花盆转向了有光的地方。",
  },
  {
    id: "desk-tidy",
    eventType: "scene",
    sceneType: "care",
    name: "整理了一下桌角",
    icon: "🗂️",
    promptContext: "把桌角散着的小东西轻轻理到一起，留出一小块干净的位置",
    fallback: "我顺手把你桌角散着的小东西理了理，给你留了一小块干净的位置。",
  },
  {
    id: "desk-lamp",
    eventType: "scene",
    sceneType: "ambient",
    name: "替你留了一盏小灯",
    icon: "🕯️",
    promptContext: "把桌边的小灯拨亮，给房间留下一点暖光",
    fallback: "我走之前把桌边的小灯拨亮了，给你留一点暖光。",
  },
]);

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

const HEART_LIVE_FLAVOR_RE = /陪你(?:聊|玩|待|说话)|和你(?:聊|玩|说话)|跟你(?:聊|玩|说话)|等你(?:回复|回应)|回我|找我|实时|想用的时候|使用它|用起来|不用特意回|看到了就行|忙完了看一眼/;

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
  const availableScenes = (Array.isArray(scenes) ? scenes : DEFAULT_HEART_SCENES)
    .filter((item) => item?.id && item?.name)
    .map((item) => ({ ...item, eventType: "scene" }));
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
  const eventContext = eventType === "scene"
    ? `当前事件（必须写对）：${subject.icon || ""}${subject.name || "一点小痕迹"}\n具体动作参考：${subject.promptContext || "留下一个轻微、可想象的环境变化"}`
    : `当前事件（必须写对）：${subject.icon || ""}${subject.name || "一件小礼物"}\n物件类别：${giftCategory(subject)}。写清它被带来、放下、摆好或自然使用的场景，不要把所有东西都写成“使用”。`;
  const voiceLines = profile.instructions.map((line) => `- ${line}`).join("\n");
  const temperamentLine = [
    temperament?.surfaceTag ? `表层：${temperament.surfaceTag}` : "",
    temperament?.innerTag ? `里层：${temperament.innerTag}` : "",
    temperament?.style ? `当前表现：${temperament.style}` : "",
  ].filter(Boolean).join("；") || "自然，有自己的脾气";
  return `你是性格鲜明的助手“${partnerName}”。现在你不在实时聊天，而是趁一个空档，给${userName}留下一份异步心意。

你的简短性格描述：
${description || "（自然、可靠、有自己的脾气）"}

可观察的说话背景：
${voiceDescription || description || "（从具体动作开始，关心藏在做法里）"}

你的声音指纹（必须落实成句子动作，不要只写“温柔”“克制”这些形容词）：
${voiceLines}

当前相处气质：${temperamentLine}

可能有用的近期记忆：
${memory || "（没有可用记忆，不要编造具体经历）"}

${eventContext}

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
- 事件必须和正文一致，不能抽到便签却写成倒水，抽到茶却写成花；如果写不出，就只写事件本身的一个细节
- 送饮品或食物，可以写放置、热气、垫一口；送花或装饰，可以写带来、摆放、插进花瓶、挂在窗边、点亮
- 现场小事可以写贴便签、画小图案、浇花、整理桌角、拨亮小灯等已经留下的痕迹
- 禁止实时互动措辞：陪你聊天、和你玩、陪你待着、等你回复、回我、现在找我、随时联系
- 不要感谢、汇报、布置任务、询问对方为什么没回，也不要暗示对方欠你回应
- 不要用“不用特意回”“看到了就行”这类统一免责句假装有分寸
- 不要散文腔、比喻、哲学和抒情大词，不要“不是……而是……”句式
- 不要编造记忆里没有的经历，不要点破“我记得你说过”
- 先删掉空话和解释，只输出最后准备留给对方看的正文

18 到 80 字，只输出消息正文，不要引号、标题、JSON、markdown 或思考过程。`;
}

export function isHeartEventConsistent(text, event) {
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
      event: subject,
      gift: subject,
      temperament,
      voiceProfile,
      voiceVariant,
    }) + (feedback ? `\n上一版被退回：${feedback}\n请换一种更像这个人的写法。` : "");
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
      if (hasAiFlavor(draft) || hasHeartLiveFlavor(draft)) {
        feedback = "有模型腔或统一免责/实时互动腔；删掉空话，保留一个具体动作，用这个助手自己的断句重写";
        continue;
      }
      try {
        const reviewRaw = await callLLM(buildReviewPrompt(draft, {
          kind: "heart",
          partnerName,
          event: subject,
          voiceProfile,
          voiceVariant,
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

export async function generateAndSaveHeart({ entry, partnerId }) {
  const initial = loadData();
  const initialCfg = initial.partnerConfig?.[partnerId];
  if (!initialCfg || initialCfg.hidden) {
    return failureResult("partner_unavailable", false);
  }

  const temperamentConfig = await ensurePartnerTemperament(partnerId);
  const data = loadData();
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
  const event = chooseHeartEvent(
    data.shopItems,
    Math.random,
    data.heartScenes,
    preferences,
    temperament,
    recentIds,
  );
  const partnerName = cfg.name || partnerId;
  const userName = sanitizeUserName(getUserDisplayName());
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
    sourcePlanId: entry.id,
  };

  return withDataLock(() => {
    const fresh = loadData();
    const planEntry = fresh.heartPlan?.entries?.find((item) => item.id === entry.id);
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

