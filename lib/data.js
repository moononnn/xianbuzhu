// 闲不住 — 数据层
// 原子读写，唯一数据源。所有路由和工具通过这里读写数据，绝不重复实现。
// ⚠️ 文件预算豁免（>500 行）：本文件是数据全集聚合层（默认数据/读写/每日重置/计算函数），
//    拆分反而破坏「唯一数据源」的内聚性；新代码应优先放对应业务文件（providers/prompts/responses/notes/variables/events），
//    只有数据读写本身才住这里。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeHeartRhythm,
  normalizeTemperamentConfig,
} from "./temperament.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const DATA_DIR = path.join(HANA_HOME, "data", "work-visit");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const DATA_TMP = DATA_FILE + ".tmp";

// ─── 默认变量值 ───
export const DEFAULT_VARIABLES = {
  energy: 100, // 精力 0~100（每日重置满格）
  mood: 60, // 心情 0~100
  affection: 0, // 好感 -20~100
};

// ─── 伙伴状态衣柜 ───
// 公共池只放短句；伙伴自己写的新状态归入 partnerConfig[id].customStatuses。
// 高级公共状态的定义仍在公共池，解锁记录放在 partnerConfig[id].unlockedStatuses 中，按伙伴分别拥有。
// 状态按生活场景分组（group），自动状态判断先定场景再下发对应子集，避免大池子全量塞给模型。
// 每组一两个免费成员让伙伴尝鲜，其余为付费解锁（unlockCost>0）。
// 免费/付费：unlockCost 为 0 且 unlocked:true 表示免费公共；unlockCost>0 表示需解锁。
export const STATUS_UNLOCK_COST = 800;
// 顺序与 DEFAULT_PUBLIC_STATUSES 中付费项出现顺序一致（仅作“是否付费”判定，顺序不影响语义）
export const PAID_PUBLIC_STATUS_IDS = Object.freeze([
  // 陪伴
  "cuddly",
  "thinking-of-you",
  // 做事·沉浸
  "hengchi-hengchi",
  "little-top",
  "busy-now",
  "cant-stop",
  "maliao",
  "round-round",
  "sorting-things",
  // 日常·闲散
  "cozy",
  "lazy",
  "blank",
  "recharging",
  // 小情绪·活人感
  "low-battery",
  "tired",
  "dont-wanna-move",
  "sigh",
  "hurry-up",
  "mind-wander",
  "fish-online",
  // 心情
  "genki",
  "yummy-happy",
  "wilted",
  "heart-tired",
  // 整活·收藏梗
  "pretend-calm",
  "brain-meeting",
  "loading-failed",
  "standby",
  "power-saving",
  "read-not-reply",
]);

export const DEFAULT_PUBLIC_STATUSES = [
  // 陪伴：免费两个
  { id: "available", text: "有空", icon: "🟢", category: "陪伴", tone: "mint", scope: "public", unlockCost: 0, unlocked: true, group: "company" },
  { id: "keep-company", text: "陪你", icon: "🍵", category: "陪伴", tone: "mint", scope: "public", unlockCost: 0, unlocked: true, group: "company" },
  { id: "waiting-you", text: "等你", icon: "⏳", category: "陪伴", tone: "mint", scope: "public", unlockCost: 0, unlocked: true, group: "company" },
  { id: "cuddly", text: "贴贴", icon: "🫂", category: "陪伴", tone: "mint", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "company" },
  { id: "thinking-of-you", text: "念着你", icon: "💭", category: "陪伴", tone: "mint", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "company" },
  // 做事·沉浸：专注/忙碌 免费
  { id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", scope: "public", unlockCost: 0, unlocked: true, group: "work" },
  { id: "busy", text: "忙碌", icon: "⏳", category: "做事", tone: "focus", scope: "public", unlockCost: 0, unlocked: true, group: "work" },
  { id: "hengchi-hengchi", text: "吭哧吭哧", icon: "💪", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  { id: "little-top", text: "小陀螺", icon: "🌀", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  { id: "busy-now", text: "忙着呢", icon: "🗯️", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  { id: "cant-stop", text: "停不下来", icon: "🏃", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  { id: "maliao", text: "麻溜的", icon: "⚡", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  { id: "round-round", text: "团团转", icon: "💫", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  { id: "sorting-things", text: "理顺中", icon: "📝", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "work" },
  // 日常·闲散：休息/悠哉哉/暂离 免费
  { id: "resting", text: "休息", icon: "🍵", category: "日常", tone: "quiet", scope: "public", unlockCost: 0, unlocked: true, group: "leisure" },
  { id: "leisurely", text: "悠哉哉", icon: "🌿", category: "日常", tone: "mint", scope: "public", unlockCost: 0, unlocked: true, group: "leisure" },
  { id: "away", text: "暂离", icon: "🌤️", category: "日常", tone: "quiet", scope: "public", unlockCost: 0, unlocked: true, group: "leisure" },
  { id: "do-not-disturb", text: "勿扰", icon: "🔕", category: "日常", tone: "rose", scope: "public", unlockCost: 0, unlocked: true, group: "leisure" },
  { id: "dozing", text: "打盹", icon: "😴", category: "日常", tone: "quiet", scope: "public", unlockCost: 0, unlocked: true, group: "leisure" },
  { id: "cozy", text: "惬意", icon: "🍃", category: "日常", tone: "mint", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "leisure" },
  { id: "lazy", text: "懒洋洋", icon: "🌊", category: "日常", tone: "mint", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "leisure" },
  { id: "blank", text: "放空", icon: "☁️", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "leisure" },
  { id: "recharging", text: "充电", icon: "🔌", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "leisure" },
  // 小情绪·活人感：被迫营业 免费门面
  { id: "forced-work", text: "被迫营业", icon: "🎪", category: "日常", tone: "rose", scope: "public", unlockCost: 0, unlocked: true, group: "mood-work" },
  { id: "low-battery", text: "低电量", icon: "🔋", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  { id: "tired", text: "乏了", icon: "😮‍💨", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  { id: "dont-wanna-move", text: "不想动", icon: "🛋️", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  { id: "sigh", text: "日常叹气", icon: "🍃", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  { id: "hurry-up", text: "赶工", icon: "⏰", category: "做事", tone: "focus", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  { id: "mind-wander", text: "精神出走", icon: "👻", category: "日常", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  { id: "fish-online", text: "在线摸鱼", icon: "🐠", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood-work" },
  // 心情：发呆/灵感/想静静 免费
  { id: "dazed", text: "发呆", icon: "☁️", category: "心情", tone: "quiet", scope: "public", unlockCost: 0, unlocked: true, group: "mood" },
  { id: "inspiration", text: "灵感", icon: "💡", category: "心情", tone: "rose", scope: "public", unlockCost: 0, unlocked: true, group: "mood" },
  { id: "stay-a-while", text: "想静静", icon: "🫧", category: "心情", tone: "quiet", scope: "public", unlockCost: 0, unlocked: true, group: "mood" },
  { id: "excited", text: "雀跃", icon: "✨", category: "心情", tone: "rose", scope: "public", unlockCost: 0, unlocked: true, group: "mood" },
  { id: "genki", text: "元气", icon: "🌈", category: "心情", tone: "mint", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood" },
  { id: "yummy-happy", text: "美滋滋", icon: "🍡", category: "心情", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood" },
  { id: "wilted", text: "蔫了", icon: "🥀", category: "心情", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood" },
  { id: "heart-tired", text: "心累", icon: "💧", category: "心情", tone: "quiet", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "mood" },
  // 整活·收藏梗
  { id: "muddling", text: "摸鱼", icon: "🐟", category: "整活", tone: "rose", scope: "public", unlockCost: 0, unlocked: true, group: "fun" },
  { id: "pretend-calm", text: "假装镇定", icon: "🎭", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "fun" },
  { id: "brain-meeting", text: "脑内开会", icon: "🧠", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "fun" },
  { id: "loading-failed", text: "思路卡住", icon: "🌀", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "fun" },
  { id: "standby", text: "待机", icon: "📺", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "fun" },
  { id: "power-saving", text: "省电模式", icon: "🔋", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "fun" },
  { id: "read-not-reply", text: "已读不回", icon: "🔕", category: "整活", tone: "rose", scope: "public", unlockCost: STATUS_UNLOCK_COST, unlocked: false, group: "fun" },
];

export const STATUS_DURATION_OPTIONS = [
  { id: "today", label: "今天" },
  { id: "hour", label: "1 小时" },
  { id: "four_hours", label: "4 小时" },
  { id: "until_changed", label: "直到换掉" },
];

// 伙伴状态不是随机抽卡：同一伙伴的自动更新需要有间隔，普通日控制在 2~3 次，
// 只有发生明显事件/情绪档位变化时才放宽到 4~5 次。
export const STATUS_SOFT_LIMIT = 3;
export const STATUS_HARD_LIMIT = 5;
export const STATUS_MIN_INTERVAL_MS = 90 * 60 * 1000;
export const STATUS_ROUTINE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_STATUS_HISTORY = 12;

export const DEFAULT_HEART_SETTINGS = {
  frequency: "low", // low / medium / high；内部参数不展示给用户
  retentionHours: 72, // 心意保留时长（小时）：期内全部展示，过期自动消失
  // 合适的时机：心意生成后先暂存，等闸放行再投递（风铃响）
  stageCapPerPartner: 2, // 每助手未送达暂存上限；满了不再新生成（旧的不堆）
  stageTTLHours: 24, // 暂存保质期：超过后按淡忘处理（不吞、不堆积）
};

// ─── 好感度阶段 ───
export const AFFECTION_STAGES = [
  { min: -20, max: -1, label: "疏远", emoji: "💔" },
  { min: 0, max: 20, label: "初识", emoji: "🤍" },
  { min: 21, max: 50, label: "熟悉", emoji: "💗" },
  { min: 51, max: 80, label: "亲近", emoji: "💖" },
  { min: 81, max: 100, label: "亲密", emoji: "❤️" },
];

export function getAffectionStage(affection) {
  if (!Number.isFinite(affection)) return AFFECTION_STAGES[1]; // NaN/非法值兑底为「初识」
  for (const s of AFFECTION_STAGES) {
    if (affection >= s.min && affection <= s.max) return s;
  }
  return AFFECTION_STAGES[0];
}

// ─── 默认数据 ───
export function defaultData() {
  return {
    days: {},
    jar: 0,
    pendingVisits: [],
    lastResetDate: null,
    partnerConfig: {},
    idlePool: [
      "在窗边晒太阳 ☀️",
      "窝在沙发里追剧 📺",
      "对着屏幕发呆 💭",
      "在厨房煮东西 🍜",
      "抱着杯子慢慢喝 🍵",
      "躺在地板上滚来滚去 🐈",
      "在阳台浇花 🌱",
      "戴着耳机听歌 🎧",
      "趴在桌上睡着了 💤",
      "在翻一本很厚的书 📚",
      "对着镜子做鬼脸 😆",
      "端着咖啡走来走去 ☕",
      "在笔记本上乱涂乱画 ✏️",
      "蹲在角落里玩手机 📱",
      "抱着抱枕发呆 🧸",
      "在偷吃冰箱里的布丁 🍮",
      "对着风扇张嘴啊—— 🌬️",
      "在给植物起名字 🌿",
      "把椅子转来转去 💺",
      "对着窗户哼歌 🎵",
      "在整理抽屉里的杂物 📦",
      "在和智能音箱吵架 🗣️",
      "用纸折了一只千纸鹤 🦢",
      "在跟镜子里的自己猜拳 ✊✋✌️",
    ],
    notes: {},
    // ─── 伙伴状态衣柜 ───
    statusLibrary: {
      public: DEFAULT_PUBLIC_STATUSES.map((status) => ({ ...status })),
    },
    // ─── 双向互动：心动计划 + 主动心意信箱 ───
    heartSettings: { ...DEFAULT_HEART_SETTINGS },
    heartPlan: { date: null, frequency: "low", entries: [] },
    heartInbox: [],
    lastReadHeartsTs: 0,
    // ─── 漂流瓶旧数据（2026-08-10 起：独立插件迁移用，闲不住不再推进/展示） ───
    bottles: [], // 旧瓶子数据，保留待独立漂流瓶插件一次性迁移
    sea: { lastTick: null }, // 旧海状态，保留待迁移
    // ─── 风铃悬浮球偏好（2026-08-10 新增） ───
    fengling: { autoStart: true }, // 打开闲不住页面时是否自动启动风铃
    pinnedTarget: null, // 风铃手动固定的对话；null=跟随最近
    shopItems: [
      { id: "coffee", name: "咖啡", icon: "☕", price: 25 },
      { id: "tea", name: "热茶", icon: "🍵", price: 25 },
      { id: "cookie", name: "小饼干", icon: "🍪", price: 30 },
      { id: "cookies", name: "手作曲奇", icon: "🧁", price: 90 },
      { id: "flower", name: "一枝花", icon: "🌸", price: 70 },
      { id: "bouquet", name: "一束花", icon: "💐", price: 120 },
      { id: "star", name: "星星许愿灯", icon: "⭐", price: 200 },
      { id: "moon", name: "月亮许愿灯", icon: "🌙", price: 200 },
    ],
    interactItems: [
      { id: "quiet", name: "安安静静在旁边陪着", icon: "🍵" },
      { id: "hum", name: "闲来无事轻轻哼着歌", icon: "🎵" },
      { id: "doodle", name: "往ta桌上放了张手绘小卡片", icon: "🎨" },
      { id: "fan", name: "看ta热就拿出小风扇给ta吹吹风", icon: "💨" },
      { id: "blanket", name: "帮ta把毯子往上拉了拉", icon: "🧣" },
      { id: "pillow", name: "把靠枕拍了拍松放回ta身后", icon: "🧸" },
    ],
    prankItems: [
      { id: "unplug", name: "悄咪咪按下关机键", icon: "🔌" },
      { id: "brainrot", name: "冷不丁说句怪话", icon: "🧠" },
    ],
    decorationItems: [
      {
        id: "avatar_flower",
        type: "avatarFrame",
        name: "花环头像框",
        icon: "🌸",
        price: 500,
      },
      {
        id: "avatar_star",
        type: "avatarFrame",
        name: "星光头像框",
        icon: "⭐",
        price: 500,
      },
      {
        id: "avatar_moon",
        type: "avatarFrame",
        name: "月亮头像框",
        icon: "🌙",
        price: 500,
      },
      {
        id: "avatar_heart",
        type: "avatarFrame",
        name: "爱心头像框",
        icon: "💗",
        price: 500,
      },
      {
        id: "avatar_cloud",
        type: "avatarFrame",
        name: "云朵头像框",
        icon: "☁️",
        price: 500,
      },
      {
        id: "avatar_note",
        type: "avatarFrame",
        name: "音符头像框",
        icon: "🎵",
        price: 500,
      },
      {
        id: "avatar_bow",
        type: "avatarFrame",
        name: "蝴蝶结头像框",
        icon: "🎀",
        price: 500,
      },
      {
        id: "avatar_pinwheel",
        type: "avatarFrame",
        name: "风车头像框",
        icon: "🌀",
        price: 500,
      },
    ],
  };
}

// ─── 原子读取（处理 BOM + 每日重置） ───
export function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      let raw = fs.readFileSync(DATA_FILE, "utf-8");
      // 移除 UTF-8 BOM
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const data = { ...defaultData(), ...JSON.parse(raw) };
      // 确保 decorationItems 按默认顺序重排（头像框）。
      // 兼容旧数据缺项、乱序、重复；卡面和称号是已移除的无效分类，连同旧数据一起清掉。
      const decorationItemsChanged = normalizeDecorationItems(data);
      // 初始化每个助手的变量、状态衣柜、装饰和双层性格（兼容旧数据）
      ensureVariables(data);
      ensureStatusState(data);
      const partnerDecorationsChanged = ensureDecorationState(data);
      ensureHeartState(data);
      // 检查每日重置
      if (checkDailyReset(data) || decorationItemsChanged || partnerDecorationsChanged) {
        if (decorationItemsChanged || partnerDecorationsChanged) {
          console.log("[闲不住] 已清理旧卡面/称号装饰数据");
        }
        saveData(data);
      }
      return data;
    }
  } catch (e) {
    console.error("[闲不住] 读取失败:", e.message);
    const bak = DATA_FILE + ".bak";
    try {
      if (fs.existsSync(bak)) {
        let rawBak = fs.readFileSync(bak, "utf-8");
        if (rawBak.charCodeAt(0) === 0xfeff) rawBak = rawBak.slice(1);
        const data = { ...defaultData(), ...JSON.parse(rawBak) };
        normalizeDecorationItems(data);
        ensureVariables(data);
        ensureStatusState(data);
        ensureDecorationState(data);
        ensureHeartState(data);
        return data;
      }
    } catch {}
  }
  return defaultData();
}

// ─── 确保每个助手有变量（兼容旧数据） ───
function ensureVariables(data) {
  for (const [, cfg] of Object.entries(data.partnerConfig || {})) {
    if (!cfg.variables) {
      cfg.variables = { ...DEFAULT_VARIABLES };
    } else {
      // 补缺失字段
      for (const [k, v] of Object.entries(DEFAULT_VARIABLES)) {
        if (cfg.variables[k] === undefined) cfg.variables[k] = v;
      }
    }
  }
}

const STATUS_CATEGORIES = new Set(["日常", "心情", "做事", "陪伴", "整活", "自定义"]);
const STATUS_TONES = new Set(["mint", "focus", "quiet", "rose"]);
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_CUSTOM_STATUSES = 30;
const LEGACY_CARD_DECORATION_IDS = new Set(["bg_warm", "bg_cool", "title", "title_edit"]);

function isLegacyCardDecorationItem(item) {
  return Boolean(
    item
    && (item.type === "cardBg" || item.type === "title" || item.type === "titleEdit" || LEGACY_CARD_DECORATION_IDS.has(item.id)),
  );
}

function uniqueStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

// 统一收敛装饰数据。旧格式、已移除的 cardBg 和已下架的称号都在这里处理，
// 只保留仍然有实际效果的头像框，避免每个路由各写一套迁移。
export function normalizeDecorationState(value) {
  const source = value && typeof value === "object" ? value : {};
  const owned = source.owned && typeof source.owned === "object" ? source.owned : {};
  const equipped = source.equipped && typeof source.equipped === "object" ? source.equipped : {};
  const avatarFrame = typeof source.avatarFrame === "string" ? source.avatarFrame.trim() : "";
  const avatarOwned = uniqueStringList(owned.avatarFrame);
  if (avatarFrame && !avatarOwned.includes(avatarFrame)) avatarOwned.push(avatarFrame);

  const equippedAvatar = typeof equipped.avatarFrame === "string" ? equipped.avatarFrame.trim() : avatarFrame;
  if (equippedAvatar && !avatarOwned.includes(equippedAvatar)) avatarOwned.push(equippedAvatar);

  return {
    owned: { avatarFrame: avatarOwned },
    equipped: {
      avatarFrame: equippedAvatar && avatarOwned.includes(equippedAvatar) ? equippedAvatar : null,
    },
  };
}

export function ensureDecorationState(data) {
  if (!data || typeof data !== "object") return false;
  let changed = false;
  for (const cfg of Object.values(data.partnerConfig || {})) {
    if (!cfg || typeof cfg !== "object" || !cfg.decorations) continue;
    const before = JSON.stringify(cfg.decorations);
    const normalized = normalizeDecorationState(cfg.decorations);
    cfg.decorations = normalized;
    if (before !== JSON.stringify(normalized)) changed = true;
  }
  return changed;
}

function normalizeDecorationItems(data) {
  const original = Array.isArray(data?.decorationItems) ? data.decorationItems : [];
  const savedItems = original.filter((item) => item && !isLegacyCardDecorationItem(item));
  const defaultDeco = (defaultData().decorationItems || []).filter((item) => !isLegacyCardDecorationItem(item));
  const decoMap = {};
  for (const item of savedItems) {
    if (typeof item.id === "string" && !decoMap[item.id]) decoMap[item.id] = item;
  }
  const reorderedDeco = [];
  const placedIds = new Set();
  for (const def of defaultDeco) {
    const item = decoMap[def.id];
    if (item) {
      reorderedDeco.push(item);
      placedIds.add(def.id);
    }
  }
  for (const item of savedItems) {
    if (typeof item.id === "string" && !placedIds.has(item.id)) {
      reorderedDeco.push(item);
      placedIds.add(item.id);
    }
  }
  data.decorationItems = reorderedDeco;
  return JSON.stringify(original) !== JSON.stringify(reorderedDeco);
}

function isPaidPublicStatusId(statusId) {
  return PAID_PUBLIC_STATUS_IDS.includes(statusId);
}

function normalizeStatusAccess(statusId, value, scope) {
  if (scope !== "public") return { unlockCost: 0, unlocked: true };
  const paid = isPaidPublicStatusId(statusId);
  return {
    unlockCost: paid ? STATUS_UNLOCK_COST : 0,
    // 仅作为旧版全局解锁数据的兼容字段；新数据以伙伴自己的 unlockedStatuses 为准。
    unlocked: paid ? value?.unlocked === true : true,
  };
}

function normalizeStatusText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_STATUS_TEXT_LENGTH);
}

function normalizeStatusIcon(value) {
  if (typeof value !== "string") return "✨";
  const icon = value.replace(/[\r\n]+/g, "").trim().slice(0, 8);
  return icon || "✨";
}

function normalizeStatusCategory(value) {
  return STATUS_CATEGORIES.has(value) ? value : "自定义";
}

function normalizeStatusTone(value, category = "自定义") {
  if (STATUS_TONES.has(value)) return value;
  if (category === "做事") return "focus";
  if (category === "心情") return "quiet";
  if (category === "整活") return "rose";
  return "mint";
}

function isSafeStatusId(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value);
}

function newStatusId() {
  return `custom-${Date.now().toString(36)}-${nextId().toString(36)}`;
}

function normalizeStatusDefinition(value, scope = "custom", fallbackId = "") {
  if (!value || typeof value !== "object") return null;
  const text = normalizeStatusText(value.text || value.label || value.name);
  if (!text) return null;
  const id = isSafeStatusId(value.id) ? value.id : (isSafeStatusId(fallbackId) ? fallbackId : newStatusId());
  const category = normalizeStatusCategory(value.category);
  return {
    id,
    text,
    icon: normalizeStatusIcon(value.icon),
    category,
    tone: normalizeStatusTone(value.tone, category),
    scope,
    ...normalizeStatusAccess(id, value, scope),
  };
}

export function ensureStatusState(data) {
  if (!data || typeof data !== "object") return data;
  const library = data.statusLibrary && typeof data.statusLibrary === "object"
    ? data.statusLibrary
    : {};
  const byId = new Map();
  for (const item of Array.isArray(library.public) ? library.public : []) {
    const normalized = normalizeStatusDefinition(item, "public");
    if (normalized && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
  }

  const publicStatuses = [];
  for (const defaultStatus of DEFAULT_PUBLIC_STATUSES) {
    const saved = byId.get(defaultStatus.id);
    const access = normalizeStatusAccess(defaultStatus.id, saved || defaultStatus, "public");
    // 公共池的文字/图标/色调跟随新版短状态，保留旧数据里的解锁字段与其他兼容信息。
    const savedWithCurrentCopy = saved
      ? {
        ...saved,
        text: defaultStatus.text,
        icon: defaultStatus.icon,
        category: defaultStatus.category,
        tone: defaultStatus.tone,
      }
      : null;
    publicStatuses.push(saved
      ? { ...defaultStatus, ...savedWithCurrentCopy, ...access, scope: "public" }
      : { ...defaultStatus, ...access });
    byId.delete(defaultStatus.id);
  }
  for (const saved of byId.values()) {
    publicStatuses.push({ ...saved, scope: "public" });
  }
  data.statusLibrary = { ...library, public: publicStatuses };

  for (const cfg of Object.values(data.partnerConfig || {})) {
    if (!cfg || typeof cfg !== "object") continue;
    // 所有伙伴都必须有显式的按伙伴解锁记录：有字段就清理过滤（只保留在架的付费项），
    // 没有字段的（老数据从未迁移/从未解锁过的伙伴）补一个空数组。
    // 这样 isStatusUnlockedForPartner 永远不会回退读旧版全局 unlocked 标记，
    // 避免未付费伙伴免费继承解锁，也保证解锁记录严格按伙伴隔离。
    if (Object.prototype.hasOwnProperty.call(cfg, "unlockedStatuses")) {
      const ids = Array.isArray(cfg.unlockedStatuses) ? cfg.unlockedStatuses : [];
      cfg.unlockedStatuses = [...new Set(ids.filter((id) => isPaidPublicStatusId(id)))];
    } else {
      cfg.unlockedStatuses = [];
    }
    const custom = [];
    const seen = new Set();
    for (const item of Array.isArray(cfg.customStatuses) ? cfg.customStatuses : []) {
      const normalized = normalizeStatusDefinition(item, "custom");
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      custom.push(normalized);
    }
    cfg.customStatuses = custom.slice(0, MAX_CUSTOM_STATUSES);
  }
  return data;
}

function statusDto(status, unlockedOverride) {
  const scope = status.scope || "custom";
  const defaultUnlocked = scope !== "public" || status.unlocked !== false;
  const category = status.category || "自定义";
  // 公共状态的场景分组定义在代码（DEFAULT_PUBLIC_STATUSES），反查补进输出，不落盘
  const publicDefault = scope === "public"
    ? DEFAULT_PUBLIC_STATUSES.find((item) => item.id === status.id)
    : null;
  return {
    id: status.id,
    text: status.text,
    icon: status.icon || "✨",
    category,
    tone: normalizeStatusTone(status.tone, category),
    scope,
    unlockCost: scope === "public" ? (status.unlockCost || 0) : 0,
    unlocked: typeof unlockedOverride === "boolean" ? unlockedOverride : defaultUnlocked,
    ...(publicDefault?.group ? { group: publicDefault.group } : {}),
  };
}

function partnerStatusUnlocks(data, partnerId) {
  const cfg = data?.partnerConfig?.[partnerId];
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.unlockedStatuses)) return null;
  return new Set(cfg.unlockedStatuses.filter((id) => isPaidPublicStatusId(id)));
}

function isStatusUnlockedForPartner(data, partnerId, status) {
  const cost = Number(status?.unlockCost) || 0;
  if (!status || cost <= 0) return true;
  const unlocks = partnerStatusUnlocks(data, partnerId);
  // 没有新字段时继续读旧版全局标记，给尚未迁移的旧数据留兼容窗口。
  return unlocks ? unlocks.has(status.id) : status.unlocked === true;
}

export function getPublicStatusCollection(data, partnerId = "") {
  ensureStatusState(data);
  return (data.statusLibrary?.public || []).map((item) => (
    statusDto(item, isStatusUnlockedForPartner(data, partnerId, item))
  ));
}

export function getStatusCatalog(data, partnerId) {
  const publicStatuses = getPublicStatusCollection(data, partnerId);
  const customStatuses = (data.partnerConfig?.[partnerId]?.customStatuses || []).map((item) => statusDto(item));
  return { publicStatuses, customStatuses };
}

export function unlockPublicStatus(data, partnerId, statusId, now = Date.now()) {
  if (!data || typeof data !== "object" || !isSafeStatusId(partnerId) || !isSafeStatusId(statusId)) {
    return { ok: false, error: "无效的助手或状态 ID" };
  }
  const config = data.partnerConfig || {};
  if (!Object.prototype.hasOwnProperty.call(config, partnerId)) {
    return { ok: false, error: "助手不存在" };
  }
  const partner = config[partnerId];
  if (!partner || typeof partner !== "object") return { ok: false, error: "助手不存在" };
  if (partner.hidden) return { ok: false, error: "这位伙伴当前不在闲不住列表里" };

  ensureStatusState(data);
  const status = (data.statusLibrary?.public || []).find((item) => item.id === statusId);
  if (!status) return { ok: false, error: "这条状态不存在" };
  const cost = Number(status.unlockCost) || 0;
  const unlocks = partnerStatusUnlocks(data, partnerId);
  const legacyOwned = !unlocks && status.unlocked === true;
  if (cost <= 0 || unlocks?.has(statusId) || legacyOwned) {
    return {
      ok: true,
      alreadyOwned: true,
      cost: 0,
      status: statusDto(status, true),
    };
  }
  if ((data.jar || 0) < cost) return { ok: false, error: `还差 ${cost - (data.jar || 0)} 光粒，攒够再来解锁吧` };

  if (!Array.isArray(partner.unlockedStatuses)) partner.unlockedStatuses = [];
  if (!partner.unlockedStatuses.includes(statusId)) partner.unlockedStatuses.push(statusId);
  data.jar -= cost;
  return {
    ok: true,
    alreadyOwned: false,
    cost,
    jar: data.jar,
    status: statusDto(status, true),
  };
}

function statusExpiry(duration, now = Date.now()) {
  if (duration === "hour") return new Date(now + 60 * 60 * 1000).toISOString();
  if (duration === "four_hours") return new Date(now + 4 * 60 * 60 * 1000).toISOString();
  return null;
}

function statusTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusDuration(status) {
  return STATUS_DURATION_OPTIONS.some((item) => item.id === status?.duration)
    ? status.duration
    : "today";
}

function statusExpiryTimestamp(status, duration = statusDuration(status)) {
  const explicit = statusTimestamp(status?.expiresAt);
  if (Number.isFinite(explicit)) return explicit;
  const setAt = statusTimestamp(status?.setAt);
  if (!Number.isFinite(setAt)) return null;
  if (duration === "hour") return setAt + 60 * 60 * 1000;
  if (duration === "four_hours") return setAt + 4 * 60 * 60 * 1000;
  return null;
}

function normalizeCurrentStatus(current, now) {
  if (!current || typeof current !== "object") return null;
  // 已挂着的旧公共状态也跟随当前短文案，避免用户要等它自然过期才看见新版标签。
  const publicDefinition = DEFAULT_PUBLIC_STATUSES.find((item) => item.id === current.id);
  const text = normalizeStatusText(publicDefinition?.text || current.text);
  if (!text) return null;
  const duration = statusDuration(current);
  const explicitExpiry = statusTimestamp(current.expiresAt);
  const expiry = statusExpiryTimestamp(current, duration);
  if (Number.isFinite(expiry) && expiry <= now) return null;
  const category = normalizeStatusCategory(publicDefinition?.category || current.category);
  return {
    id: isSafeStatusId(current.id) ? current.id : "",
    text,
    icon: normalizeStatusIcon(publicDefinition?.icon || current.icon),
    category,
    tone: normalizeStatusTone(publicDefinition?.tone || current.tone, category),
    scope: publicDefinition ? "public" : (current.scope === "public" ? "public" : "custom"),
    source: current.source === "autonomous"
      ? "autonomous"
      : current.source === "partner"
        ? "partner"
        : current.source === "baseline"
          ? "baseline"
          : "user",
    duration,
    setAt: current.setAt || null,
    expiresAt: Number.isFinite(explicitExpiry)
      ? (current.expiresAt || new Date(explicitExpiry).toISOString())
      : (Number.isFinite(expiry) ? new Date(expiry).toISOString() : null),
  };
}

// 跨日只接续仍在寿命内的状态；duration=today 到新的一天就自然结束。
// 最近一天的已结束/已清除状态会挡住更早状态，避免旧状态“复活”。
function findCarryableStatus(data, partnerId, currentDate, now) {
  const dates = Object.keys(data?.days || {})
    .filter((date) => date < currentDate)
    .sort()
    .reverse();
  for (const date of dates) {
    const partnerDay = data.days?.[date]?.partners?.[partnerId];
    if (!partnerDay || typeof partnerDay !== "object") continue;
    if (partnerDay.statusClearedAt) return null;
    const hasStatus = Object.prototype.hasOwnProperty.call(partnerDay, "status");
    if (hasStatus && (!partnerDay.status || typeof partnerDay.status !== "object")) return null;
    if (!hasStatus && Array.isArray(partnerDay.statusHistory) && partnerDay.statusHistory.length > 0) {
      // 旧版 clear 会保留 history 但删除 status，不能让更早的状态复活。
      return null;
    }
    if (!hasStatus) continue;
    const duration = statusDuration(partnerDay.status);
    if (duration === "today") return null;
    return normalizeCurrentStatus(partnerDay.status, now);
  }
  return null;
}

function baselineStatus(data, partnerId) {
  const config = data?.partnerConfig?.[partnerId];
  if (!config || config.hidden) return null;
  const status = DEFAULT_PUBLIC_STATUSES.find((item) => item.id === "stay-a-while");
  return {
    id: status.id,
    text: status.text,
    icon: status.icon,
    category: status.category,
    tone: status.tone,
    scope: "public",
    source: "baseline",
    duration: "today",
    setAt: null,
    expiresAt: null,
  };
}

function statusMoodBand(value) {
  const mood = Number(value);
  if (!Number.isFinite(mood)) return "steady";
  if (mood >= 65) return "bright";
  if (mood < 40) return "low";
  return "steady";
}

function statusEnergyBand(value) {
  const energy = Number(value);
  if (!Number.isFinite(energy)) return "normal";
  if (energy >= 70) return "high";
  if (energy < 40) return "low";
  return "normal";
}

function statusHistoryFor(partnerDay) {
  const history = Array.isArray(partnerDay?.statusHistory)
    ? partnerDay.statusHistory.filter((item) => item && typeof item === "object")
    : [];
  const valid = history.filter((item) => Number.isFinite(statusTimestamp(item.setAt)));
  if (valid.length > 0) return valid.slice(-MAX_STATUS_HISTORY);
  const legacy = partnerDay?.status;
  if (legacy && typeof legacy === "object" && Number.isFinite(statusTimestamp(legacy.setAt))) {
    return [{
      ...legacy,
      setAt: legacy.setAt,
      source: "legacy",
      moodBand: "",
      energyBand: "",
    }];
  }
  return [];
}

function appendStatusHistory(partnerDay, entry) {
  const history = statusHistoryFor(partnerDay);
  history.push(entry);
  partnerDay.statusHistory = history.slice(-MAX_STATUS_HISTORY);
}

function statusReasonLabel(reason) {
  if (reason === "new-day") return "今天还没有挂过状态";
  if (reason === "event") return "刚刚有值得记一笔的互动";
  if (reason === "mood-change") return "心情档位有了变化";
  if (reason === "energy-change") return "精力档位有了变化";
  if (reason === "activity-change") return "正在做的事情有了变化";
  if (reason === "conversation") return "主对话里刚刚发生了值得回应的事";
  if (reason === "routine") return "距离上次状态已经有一段时间";
  if (reason === "cooldown") return "距离上次更新还不够久";
  if (reason === "soft-limit") return "今天已经换过几次，等明显变化再换";
  if (reason === "daily-limit") return "今天的状态次数已经到上限";
  return "当前没有明显变化";
}

export function getStatusUpdateContext(data, partnerId, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const partnerDay = data?.days?.[todayStr()]?.partners?.[partnerId] || {};
  const history = statusHistoryFor(partnerDay);
  const current = getCurrentStatus(data, partnerId, now);
  const last = history.at(-1) || null;
  // 继承的跨日状态不计入今天次数，但它的设置时间仍参与冷却和事件边界。
  const lastForTiming = last || (current?.source !== "baseline" ? current : null);
  const lastChangedMs = statusTimestamp(lastForTiming?.setAt);
  const elapsedMs = Number.isFinite(lastChangedMs) ? Math.max(0, now - lastChangedMs) : null;
  const cfg = data?.partnerConfig?.[partnerId] || {};
  const vars = cfg.variables || {};
  const moodBand = statusMoodBand(vars.mood);
  const energyBand = statusEnergyBand(vars.energy);
  const moodChanged = Boolean(last?.moodBand && last.moodBand !== moodBand);
  const energyChanged = Boolean(last?.energyBand && last.energyBand !== energyBand);
  const events = Array.isArray(partnerDay.events) ? partnerDay.events : [];
  const recentEvents = events
    .map((event) => ({ event, time: statusTimestamp(event?.ts) }))
    .filter(({ time }) => Number.isFinite(time) && (!Number.isFinite(lastChangedMs) || time > lastChangedMs))
    .slice(-3)
    .map(({ event }) => ({
      type: typeof event.type === "string" ? event.type : "event",
      itemName: normalizeStatusText(event.itemName || ""),
    }));
  const eventSinceLast = recentEvents.length > 0;
  const conversationMeaningful = options.conversationMeaningful === true;
  const activityChanged = options.activityChanged === true;
  const strongSignal = moodChanged
    || energyChanged
    || eventSinceLast
    || conversationMeaningful
    || activityChanged;
  const changesToday = history.length;
  const cooldownRemainingMs = Number.isFinite(elapsedMs)
    ? Math.max(0, STATUS_MIN_INTERVAL_MS - elapsedMs)
    : 0;

  let canUpdate = false;
  let reason = "not-due";
  if (changesToday >= STATUS_HARD_LIMIT) {
    reason = "daily-limit";
  } else if (Number.isFinite(elapsedMs) && elapsedMs < STATUS_MIN_INTERVAL_MS) {
    reason = "cooldown";
  } else if (changesToday === 0) {
    canUpdate = true;
    reason = "new-day";
  } else if (changesToday >= STATUS_SOFT_LIMIT && !strongSignal) {
    reason = "soft-limit";
  } else if (moodChanged) {
    canUpdate = true;
    reason = "mood-change";
  } else if (energyChanged) {
    canUpdate = true;
    reason = "energy-change";
  } else if (activityChanged) {
    canUpdate = true;
    reason = "activity-change";
  } else if (eventSinceLast) {
    canUpdate = true;
    reason = "event";
  } else if (conversationMeaningful) {
    canUpdate = true;
    reason = "conversation";
  } else if (!Number.isFinite(elapsedMs) || elapsedMs >= STATUS_ROUTINE_INTERVAL_MS) {
    canUpdate = changesToday < STATUS_SOFT_LIMIT;
    reason = canUpdate ? "routine" : "soft-limit";
  }

  return {
    current,
    statusCleared: Boolean(partnerDay?.statusClearedAt),
    canUpdate,
    reason,
    reasonText: statusReasonLabel(reason),
    changesToday,
    softLimit: STATUS_SOFT_LIMIT,
    hardLimit: STATUS_HARD_LIMIT,
    lastChangedAt: lastForTiming?.setAt || null,
    minutesSinceLastChange: Number.isFinite(elapsedMs) ? Math.floor(elapsedMs / 60000) : null,
    cooldownRemainingMinutes: Math.ceil(cooldownRemainingMs / 60000),
    moodText: describeMood(vars.mood),
    energyText: describeEnergy(vars.energy),
    moodBand,
    energyBand,
    moodChanged,
    energyChanged,
    eventSinceLast,
    recentEvents,
    recentStatusHistory: history.slice(-3).map((item) => ({
      id: item.id || "",
      text: normalizeStatusText(item.text || ""),
    })),
    conversationMeaningful,
    activityChanged,
  };
}

export function getCurrentStatus(data, partnerId, now = Date.now()) {
  const date = todayStr();
  const todayPartner = data?.days?.[date]?.partners?.[partnerId];
  const hasTodayStatus = Object.prototype.hasOwnProperty.call(todayPartner || {}, "status");
  if (todayPartner?.status && typeof todayPartner.status === "object") {
    // 今日已有记录时，以今日记录为准；即使它刚过期，也不能让更早的状态复活。
    return normalizeCurrentStatus(todayPartner.status, now);
  }
  if (todayPartner?.statusClearedAt || hasTodayStatus) return null;
  // 兼容旧版本：清除状态只留下历史、没有 tombstone 时，今天仍应保持清空。
  if (Array.isArray(todayPartner?.statusHistory) && todayPartner.statusHistory.length > 0) return null;

  const inherited = findCarryableStatus(data, partnerId, date, now);
  if (inherited) return inherited;

  // 新的一天先给一个不制造事实的中性占位，后台模型成功后再换成真实短句。
  return baselineStatus(data, partnerId);
}

export function setPartnerStatus(data, partnerId, input = {}) {
  if (!data || typeof data !== "object" || !isSafeStatusId(partnerId)) {
    return { ok: false, error: "无效的助手 ID" };
  }
  ensureStatusState(data);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const source = input.source === "autonomous"
    ? "autonomous"
    : input.source === "partner"
      ? "partner"
      : "user";
  const trigger = typeof input.trigger === "string" ? input.trigger.slice(0, 40) : source;
  const partnerSignal = source === "partner" && input.trigger !== "routine";
  const today = getToday(data);
  if (!today.partners[partnerId]) {
    today.partners[partnerId] = {
      contributed: false,
      narrative: "",
      effortLP: 0,
    };
  }
  const partnerDay = today.partners[partnerId];
  const beforeContext = getStatusUpdateContext(data, partnerId, {
    now,
    conversationMeaningful: partnerSignal,
    activityChanged: input.activityChanged === true,
  });
  const currentBefore = beforeContext.current;
  const persistStatus = input.persist !== false;

  if (input.clear === true) {
    // 记录当天的明确清除，避免跨日继承或默认占位立刻回来。
    delete partnerDay.status;
    partnerDay.statusClearedAt = nowISO(now);
    if (!currentBefore) {
      return {
        ok: true,
        current: null,
        unchanged: true,
        statusContext: getStatusUpdateContext(data, partnerId, { now }),
      };
    }
    // 清除是收起当前展示，不会制造新的状态文案；允许伙伴随时清掉，
    // 但保留上一条历史，防止“清掉再立刻换一条”绕过更新节奏。
    return {
      ok: true,
      current: null,
      statusContext: getStatusUpdateContext(data, partnerId, { now }),
    };
  }

  let definition = null;
  let customToAdd = null;
  const requestedId = isSafeStatusId(input.statusId) ? input.statusId : "";
  if (requestedId) {
    const catalog = getStatusCatalog(data, partnerId);
    definition = [...catalog.publicStatuses, ...catalog.customStatuses]
      .find((item) => item.id === requestedId) || null;
    if (!definition) return { ok: false, error: "这条状态已经不在衣柜里，请刷新后再试" };
  } else {
    const text = normalizeStatusText(input.text || input.status);
    if (!text) return { ok: false, error: "请提供状态文字或状态 ID" };
    const icon = normalizeStatusIcon(input.icon);
    const category = normalizeStatusCategory(input.category);
    const tone = normalizeStatusTone(input.tone, category);
    const cfg = data.partnerConfig?.[partnerId];
    const existing = cfg?.customStatuses?.find((item) => item.text === text && item.icon === icon);
    if (existing) {
      definition = statusDto({ ...existing, scope: "custom" });
    } else {
      if (cfg && persistStatus && (cfg.customStatuses || []).length >= MAX_CUSTOM_STATUSES) {
        return { ok: false, error: "这位伙伴的专属状态已经有点多了，先收拾一下衣柜吧" };
      }
      customToAdd = {
        id: newStatusId(),
        text,
        icon,
        category,
        tone,
        scope: "custom",
      };
      definition = customToAdd;
    }
  }

  const nextDefinition = statusDto(definition);
  if (nextDefinition.scope === "public" && nextDefinition.unlocked === false && source !== "autonomous") {
    return {
      ok: false,
      error: "这条状态还没解锁，请先去装饰商店的状态收藏看看",
      current: currentBefore,
      statusContext: beforeContext,
    };
  }
  if (
    currentBefore
    && currentBefore.text === nextDefinition.text
    && currentBefore.icon === nextDefinition.icon
    && currentBefore.category === nextDefinition.category
    && currentBefore.tone === nextDefinition.tone
    && currentBefore.source !== "baseline"
  ) {
    return { ok: true, current: currentBefore, unchanged: true, statusContext: beforeContext };
  }

  if ((source === "partner" || source === "autonomous") && !beforeContext.canUpdate) {
    return {
      ok: false,
      error: beforeContext.reasonText,
      current: currentBefore,
      statusContext: beforeContext,
    };
  }

  const cfg = data.partnerConfig?.[partnerId];
  delete partnerDay.statusClearedAt;
  if (customToAdd && cfg && persistStatus) cfg.customStatuses.push(customToAdd);
  const duration = STATUS_DURATION_OPTIONS.some((item) => item.id === input.duration)
    ? input.duration
    : "today";
  const setAt = nowISO(now);
  appendStatusHistory(partnerDay, {
    ...nextDefinition,
    duration,
    setAt,
    source,
    trigger,
    moodBand: beforeContext.moodBand,
    energyBand: beforeContext.energyBand,
  });
  partnerDay.status = {
    ...nextDefinition,
    source,
    duration,
    setAt,
    expiresAt: statusExpiry(duration, now),
  };
  return {
    ok: true,
    current: getCurrentStatus(data, partnerId, now),
    statusContext: getStatusUpdateContext(data, partnerId, { now }),
  };
}

// ─── 确保双向互动数据结构（兼容旧数据） ───
export function ensureHeartState(data) {
  const settings = data.heartSettings && typeof data.heartSettings === "object"
    ? data.heartSettings
    : {};
  data.heartSettings = {
    ...DEFAULT_HEART_SETTINGS,
    ...settings,
    frequency: ["low", "medium", "high"].includes(settings.frequency)
      ? settings.frequency
      : DEFAULT_HEART_SETTINGS.frequency,
    retentionHours: Number.isFinite(Number(settings.retentionHours))
      && Number(settings.retentionHours) >= 1
      && Number(settings.retentionHours) <= 336
      ? Math.round(Number(settings.retentionHours))
      : DEFAULT_HEART_SETTINGS.retentionHours,
  };
  // 不提供独立回复/回礼界面；普通动作自动承接当前心意，清掉旧 returning 状态。
  delete data.heartSettings.returnGiftEnabled;

  data.heartSettings.stageCapPerPartner = Number.isFinite(Number(settings.stageCapPerPartner))
    && Number(settings.stageCapPerPartner) >= 1
    && Number(settings.stageCapPerPartner) <= 10
    ? Math.round(Number(settings.stageCapPerPartner))
    : DEFAULT_HEART_SETTINGS.stageCapPerPartner;
  data.heartSettings.stageTTLHours = Number.isFinite(Number(settings.stageTTLHours))
    && Number(settings.stageTTLHours) >= 1
    && Number(settings.stageTTLHours) <= 168
    ? Math.round(Number(settings.stageTTLHours))
    : DEFAULT_HEART_SETTINGS.stageTTLHours;

  if (!data.heartPlan || typeof data.heartPlan !== "object") {
    data.heartPlan = { date: null, frequency: data.heartSettings.frequency, entries: [] };
  }
  if (!Array.isArray(data.heartPlan.entries)) data.heartPlan.entries = [];
  if (!Array.isArray(data.heartInbox)) data.heartInbox = [];
  if (!Number.isFinite(Number(data.lastReadHeartsTs))) data.lastReadHeartsTs = 0;

  for (const heart of data.heartInbox) {
    if (heart?.status === "returning") {
      heart.status = heart.previousStatus === "read" ? "read" : "unread";
    }
    delete heart.previousStatus;
    delete heart.returningAt;
    delete heart.returnedGiftId;
    delete heart.returnedAt;
  }

  for (const cfg of Object.values(data.partnerConfig || {})) {
    const normalized = normalizeTemperamentConfig(cfg, cfg?.description || "");
    cfg.surfaceLayer = normalized.surfaceLayer;
    cfg.innerLayer = normalized.innerLayer;
    cfg.temperamentSource = normalized.temperamentSource;
    cfg.temperamentAnalyzedAt = normalized.temperamentAnalyzedAt;
    cfg.heartRhythm = normalizeHeartRhythm(normalized.heartRhythm);
  }
  return data;
}

// ─── 原子写入（无 BOM + 每日重置检查） ───
// 返回 true/false：写盘失败（磁盘满/权限/rename 失败/文件被锁）时返回 false 并保留日志，
// 调用方（尤其 API 层）应据此避免向用户谎报成功，而不是吞掉错误继续返回 success: true。
export function saveData(data) {
  try {
    ensureStatusState(data);
    ensureHeartState(data);
    // 写入前检查每日重置
    if (checkDailyReset(data)) {
      console.log("[闲不住] 写入时触发每日重置");
    }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_TMP, JSON.stringify(data, null, 2), "utf-8");
    // 先备份旧版本（.bak 永远是上次成功写入的内容），再原子替换
    if (fs.existsSync(DATA_FILE)) {
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch {}
    }
    fs.renameSync(DATA_TMP, DATA_FILE);
    return true;
  } catch (e) {
    console.error("[闲不住] 写入失败:", e.message);
    return false;
  }
}

// ─── 数据写锁：load-modify-save 串行化 ───
// 统一锁放在数据层：所有读-改-写路径（API 接口、核心动作、后台任务）共用同一把锁，
// 防止「一份旧快照跨越异步等待后覆盖其他写操作」的竞态。锁内请勿再嵌套调用 withDataLock（会死锁）。
let _dataLock = Promise.resolve();
export function withDataLock(fn) {
  const run = _dataLock.then(fn);
  _dataLock = run.catch(() => {});
  return run;
}

// ─── 每日重置检查 ───
function checkDailyReset(data) {
  const ts = todayStr();
  if (data.lastResetDate === ts) return false;

  const now = new Date();
  const bj = new Date(now.getTime() + 480 * 60000);
  const hour = bj.getUTCHours();

  // 北京时间 >= 4:00 才触发重置
  if (hour < 4) return false;

  performDailyReset(data);
  data.lastResetDate = ts;
  return true;
}

// ─── 通宵惩罚（纯函数，可测） ───
// 按个人昨日光粒算：谁熬夜干活谁困，躺平的人满血；上限 30
// 口径与实时工作消耗统一：每 30 光粒扣 1 精力
function calcOvernightPenalty(effortLP) {
  return Math.min(Math.floor((effortLP || 0) / 30), 30);
}

function hasActiveHeartForDecay(data, partnerId, now = Date.now()) {
  return (data.heartInbox || []).some((heart) => {
    if (heart?.partnerId !== partnerId) return false;
    if (!["unread", "read"].includes(heart.status)) return false;
    const expiresAt = new Date(heart.expiresAt).getTime();
    return !Number.isFinite(expiresAt) || expiresAt > now;
  });
}

// ─── 执行每日重置 ───
// yesterdayStr 可注入（测试用），默认取北京时间昨天
export function performDailyReset(data, yesterdayStr) {
  if (!yesterdayStr) {
    const now = new Date();
    const bj = new Date(now.getTime() + 480 * 60000);
    const yd = new Date(bj);
    yd.setUTCDate(yd.getUTCDate() - 1);
    const pad = (n) => String(n).padStart(2, "0");
    yesterdayStr = `${yd.getUTCFullYear()}-${pad(yd.getUTCMonth() + 1)}-${pad(yd.getUTCDate())}`;
  }

  const yesterdayData = data.days?.[yesterdayStr];

  for (const [partnerId, cfg] of Object.entries(data.partnerConfig || {})) {
    const vars = cfg.variables;
    if (!vars) continue;

    // 精力：重置到 100（减去个人通宵惩罚），不低于 30
    const ownEffort = yesterdayData?.partners?.[partnerId]?.effortLP || 0;
    const overnightPenalty = calcOvernightPenalty(ownEffort);
    vars.energy = Math.max(
      30,
      Math.min(100, DEFAULT_VARIABLES.energy - overnightPenalty),
    );

    // 心情：事件驱动 + 自主漂移 + 温和回归
    // 有昨日事件：事件影响决定走向（礼物/互动/充电是锦上添花）；
    // 没事件：自主漂移 ±12（她过自己的日子），不给原因（不编造、不惩罚）
    let baseMood = vars.mood ?? 50;
    const yesterdayEvents = yesterdayData?.partners?.[partnerId]?.events;
    if (yesterdayEvents && yesterdayEvents.length > 0) {
      baseMood += computeMoodShift(yesterdayEvents);
      baseMood += Math.random() * 10 - 5; // 小微扰 ±5
      vars.moodReason = buildMoodReason(yesterdayEvents);
    } else {
      baseMood += Math.random() * 24 - 12; // 自主漂移 ±12（自然分化，偶尔有人不太开心）
      vars.moodReason = "";
    }
    // 温和回归：只在边缘拉回（很嗨才降温，很低才打气）
    // 长期分布：平稳约 6 成、不错约 3 成、偶尔有点闷约 1 成
    if (baseMood > 75) baseMood -= 8;
    else if (baseMood < 38) baseMood += 5;
    vars.mood = Math.round(Math.max(0, Math.min(100, baseMood)));

    // 好感疏远衰减：如果昨天没有任何互动，好感 -1（不低于 0）
    const hadActivityYesterday =
      yesterdayData?.partners?.[partnerId] !== undefined;
    if (
      !hadActivityYesterday
      && vars.affection > 0
      && !hasActiveHeartForDecay(data, partnerId)
    ) {
      vars.affection = Math.max(0, vars.affection - 1);
      console.log(`[闲不住] 好感疏远衰减: ${partnerId} 昨天无互动，好感 -1`);
    } else if (!hadActivityYesterday && hasActiveHeartForDecay(data, partnerId)) {
      // 主动心意还在有效期内时不额外扣关系进度，避免无回应同时承受两套惩罚。
      console.log(`[闲不住] 好感疏远衰减暂缓: ${partnerId} 仍有一份有效心意`);
    }

    if (vars.affection === undefined)
      vars.affection = DEFAULT_VARIABLES.affection;
  }

  console.log(`[闲不住] 每日重置完成（通宵惩罚按个人光粒，上限 -30 精力）`);
}

// ─── 工作消耗计算（基于光粒映射） ───
// workStats: { toolCalls, charsOutput, fileOps, subagentDispatches, milestones }
export function calcWorkConsumption(workStats) {
  const lightParticles = calcLightParticles(workStats);
  // 每 30 光粒消耗 1 精力（2026-08-07 调低：原 10 光粒/精力对高强度聊天太狠）
  return Math.round(lightParticles / 30);
}

// ─── 同步今天的工作消耗扣减（实时扣 + 事件兑底共用） ───
// 按当天已扣标记（_workDeducted）只扣新增差额，避免重复扣
// 返回是否发生了扣减（调用方可据此决定是否写盘）
export function syncWorkDeduction(data, partnerId, workConsumption) {
  const today = getToday(data);
  if (!today.partners[partnerId]) {
    today.partners[partnerId] = {
      contributed: false,
      narrative: "",
      effortLP: 0,
    };
  }
  const partnerDay = today.partners[partnerId];
  const previouslyDeducted = partnerDay._workDeducted || 0;
  const additionalDeduction = workConsumption - previouslyDeducted;
  if (additionalDeduction > 0) {
    const cfg = data.partnerConfig?.[partnerId];
    if (cfg?.variables) {
      cfg.variables.energy -= additionalDeduction;
      clampVariable(cfg.variables);
    }
    partnerDay._workDeducted = workConsumption;
    return true;
  }
  return false;
}

// ─── 工具函数 ───
let _idCounter = Date.now();
export function nextId() {
  return ++_idCounter;
}

// ─── 北京时间日期字符串 ───
export function todayStr() {
  const now = new Date();
  const bj = new Date(now.getTime() + 480 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`;
}

export function getToday(data) {
  const ts = todayStr();
  if (!data.days[ts]) {
    data.days[ts] = {
      date: ts,
      partners: {},
      baseLP: 100,
      totalLP: 100,
      claimed: 0,
    };
  }
  return data.days[ts];
}

// ─── 光粒计算 ───
export function calcLightParticles(stats) {
  const toolLP = Math.round((stats.toolCalls || 0) * 0.3);
  const charLP = Math.min(Math.floor((stats.charsOutput || 0) / 100), 50);
  const fileLP = (stats.fileOps || 0) * 2;
  const subLP = (stats.subagentDispatches || 0) * 3;
  const milLP = (stats.milestones || []).length * 5;
  return toolLP + charLP + fileLP + subLP + milLP;
}

// ─── 昨日事件摘要 → 心情修正（纯函数，可测） ───
// events: [{ type, itemId, price }]；无事件 = 0（没事件时由调用方走自主漂移）
// 上限 [0, 12]：礼物按价格分档、互动小确幸、充电被照顾；
// 恶作剧不降心情（朋友间开玩笑，不是讨厌），当天玩闹效果在 VARIABLE_RULES 即时生效
export function computeMoodShift(events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  let shift = 0;
  for (const e of events) {
    if (e.type === "gift") {
      const p = e.price || 0;
      if (p >= 100) shift += 6;
      else if (p >= 50) shift += 4;
      else if (p >= 30) shift += 2;
      else shift += 1;
    } else if (e.type === "interact") {
      shift += 1;
    } else if (e.type === "recharge") {
      shift += 3;
    }
  }
  return Math.max(0, Math.min(12, shift));
}

// ─── 昨日事件摘要 → 心情原因一句话（可注入给 agent） ───
// 优先级：礼物 > 互动 > 充电；无事件返回 ''（不编造原因）
// 没来不是惩罚：没事件时调用方不调本函数，走自主漂移且不给原因
export function buildMoodReason(events) {
  if (!Array.isArray(events) || events.length === 0) return "";
  let bestGift = null;
  let interactCount = 0;
  let rechargeCount = 0;
  for (const e of events) {
    if (e.type === "gift") {
      if (!bestGift || (e.price || 0) > (bestGift.price || 0)) bestGift = e;
    } else if (e.type === "interact") interactCount++;
    else if (e.type === "recharge") rechargeCount++;
  }
  if (bestGift) return `昨天收到了${bestGift.itemName || "一份礼物"}`;
  if (interactCount > 0) return "昨天有人来陪着待了会儿";
  if (rechargeCount > 0) return "昨天被充了电，精神头不错";
  return "";
}

// ─── 记录今日事件（供次日心情推演） ───
export function recordEvent(data, partnerId, event) {
  const today = getToday(data);
  if (!today.partners[partnerId]) {
    today.partners[partnerId] = {
      contributed: false,
      narrative: "",
      effortLP: 0,
    };
  }
  if (!today.partners[partnerId].events) today.partners[partnerId].events = [];
  today.partners[partnerId].events.push({
    type: event.type,
    itemId: event.itemId || "",
    itemName: event.itemName || "",
    price: event.price || 0,
    ts: nowISO(),
  });
}

// ─── 心情/精力模糊描述（注入用，不给硬数值，给 agent 留演绎空间） ───
export function describeMood(mood) {
  if (mood >= 80) return "心情很好";
  if (mood >= 65) return "心情不错";
  if (mood >= 40) return "心情平稳";
  if (mood >= 25) return "有点闷";
  return "心情很差";
}

export function describeEnergy(energy) {
  if (energy >= 70) return "精力充沛";
  if (energy >= 40) return "还行";
  if (energy >= 20) return "有点累";
  return "累坏了";
}

// ─── 好感度模糊描述（关系进度也模糊化：角色卡同样会定义关系，数字会双轨打架） ───
export function describeAffection(affection) {
  if (affection >= 81) return "你们亲密无间";
  if (affection >= 51) return "你们已经很亲近";
  if (affection >= 21) return "你们正在慢慢熟悉";
  if (affection >= 0) return "你们还不算熟";
  return "你们之间有点疏远";
}

// ─── 注入用上下文：心情（带原因）+ 精力 + 关系描述（全模糊，零数字） ───
// 示例：心情不错（昨天收到了一束花），精力还行，你们已经很亲近
export function buildMoodContext(vars) {
  if (!vars) return "";
  let moodText = describeMood(vars.mood);
  if (vars.moodReason) moodText += `（${vars.moodReason}）`;
  return `${moodText}，${describeEnergy(vars.energy)}，${describeAffection(vars.affection)}`;
}

// ─── 变量值范围约束 ───
export function clampVariable(vars) {
  if (vars.energy !== undefined)
    vars.energy = Math.max(0, Math.min(100, vars.energy));
  if (vars.mood !== undefined)
    vars.mood = Math.max(0, Math.min(100, vars.mood));
  if (vars.affection !== undefined)
    vars.affection = Math.max(-20, Math.min(100, vars.affection));
  return vars;
}

// ─── 北京时间 ISO 字符串（带 +08:00 偏移） ───
export function nowISO(at = Date.now()) {
  const now = new Date(at);
  const bj = new Date(now.getTime() + 480 * 60000);
  return bj.toISOString().replace("Z", "+08:00");
}

function normalizeMessageTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// ─── 识别闲不住自己 session:send 推进去的送达文本 ───
// 这些消息会被 Hana 记成 role=user，但它们不是用户亲手发的。用来区分
// "真实活跃"和"自己推送造成的假活跃"。匹配 buildVisitPushText 的全部模板。
export function isSelfInjectedPushText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^[📬📦🎁🧠✉]/.test(t)) {
    return /收到来自|给你带了东西|拍了拍你|的一份回礼|的一份礼物|的一条互动|的回应|一起回应/.test(t);
  }
  if (t === "重启！") return true;
  // brainrot 普通推送沿用生成文本，没有统一 emoji 前缀；识别其固定输出格式。
  return /^(?:讲个冷笑话：|考考你：|你知道吗：|突然想到：|如果世界上有10种人)/.test(t);
}

function extractMessageText(message) {
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

// ─── 从会话文件尾部向前解析最后一条"真实用户消息"的时间（ms），找不到返回 null ───
// 与 getLastUserMsgTime 同款尾部扫描，但会跳过闲不住自己注入的送达文本：
// 自注入消息顶 user 身份会刷新窗口时间戳，若按它判活跃，被推过的窗口会永远"最新"
// （越推越锁死）。只认用户亲手打的字，避免把自家推送当活跃信号。
function getLastRealUserMsgTime(filePath) {
  const parseLine = (lineBuffer) => {
    const line = lineBuffer.toString("utf-8").trim();
    if (!line) return null;
    try {
      const d = JSON.parse(line);
      const message = d?.message && typeof d.message === "object" ? d.message : d;
      if (message?.role === "user") {
        if (isSelfInjectedPushText(extractMessageText(message))) return null;
        return normalizeMessageTimestamp(message.timestamp ?? d.timestamp ?? d.ts);
      }
    } catch {
      // 坏行跳过
    }
    return null;
  };

  try {
    const CHUNK_SIZE = 64 * 1024;
    const fd = fs.openSync(filePath, "r");
    try {
      let position = fs.fstatSync(fd).size;
      let carry = Buffer.alloc(0);
      while (position > 0) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;
        const chunk = Buffer.alloc(readSize);
        fs.readSync(fd, chunk, 0, readSize, position);
        const combined = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        let lineEnd = combined.length;

        for (let i = combined.length - 1; i >= 0; i--) {
          if (combined[i] !== 0x0a) continue;
          const time = parseLine(combined.subarray(i + 1, lineEnd));
          if (time !== null) return time;
          lineEnd = i;
        }
        carry = Buffer.from(combined.subarray(0, lineEnd));
      }
      return parseLine(carry);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 读不到就当没有
  }
  return null;
}

// ─── 粗筛：返回 sessionsDir 下按 mtime 降序的前 maxScan 个 jsonl 候选 ───
// 不读文件内容，只 stat 拿 mtime。最后一条用户消息必然发生在最近读写过的文件里，
// 所以只对候选读尾部找最后用户消息，不必扫全部会话文件（对 hanako 这种几百文件的助手省 90%+ IO）。
function recentSessionCandidates(sessionsDir, maxScan = 60) {
  let entries = [];
  let files;
  try {
    files = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const de of files) {
    if (!de.isFile() || !de.name.toLowerCase().endsWith(".jsonl")) continue;
    const full = path.join(sessionsDir, de.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    entries.push({ full, mtime: st.mtimeMs, size: st.size });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, maxScan);
}

// ─── 查找目标助手的最近会话 ───
// 按「最后一条用户消息」的时间判断活跃窗口（mtime 会被推送/助手回复扰动，不可靠）；
// 没有用户消息的会话兜底用 mtime。
// 只对 mtime 最近的前 MAX_SCAN_CANDIDATES 个候选读尾部，不做全量扫描。
const MAX_SCAN_CANDIDATES = 60;
function findLatestSession(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return { path: "", time: -Infinity, hasUser: false };
    }

    const candidates = recentSessionCandidates(sessionsDir, MAX_SCAN_CANDIDATES);
    if (candidates.length === 0) {
      return { path: "", time: -Infinity, hasUser: false };
    }

    let userPath = "";
    let userTime = -Infinity;
    let fallbackPath = "";
    let fallbackTime = -Infinity;
    for (const { full, mtime } of candidates) {
      if (mtime > fallbackTime) {
        fallbackTime = mtime;
        fallbackPath = full;
      }
      const lastRealUserTime = getLastRealUserMsgTime(full);
      if (lastRealUserTime !== null && lastRealUserTime > userTime) {
        userTime = lastRealUserTime;
        userPath = full;
      }
    }
    if (userPath) return { path: userPath, time: userTime, hasUser: true };
    return { path: fallbackPath, time: fallbackTime, hasUser: false };
  } catch (e) {
    console.error("[闲不住] 查找最新会话失败:", e?.message || e);
    return { path: "", time: -Infinity, hasUser: false };
  }
}

export function findLatestSessionPath(agentId) {
  return findLatestSession(agentId).path;
}

// ─── 在所有伙伴中找用户最后操作过的会话窗口 ───
export function findMostActiveAgentId(agentIds) {
  let userBestId = null;
  let userBestTime = -Infinity;
  let fallbackId = null;
  let fallbackTime = -Infinity;
  for (const agentId of agentIds || []) {
    if (typeof agentId !== "string" || !agentId) continue;
    const session = findLatestSession(agentId);
    if (!session.path) continue;
    if (session.hasUser && session.time > userBestTime) {
      userBestId = agentId;
      userBestTime = session.time;
    } else if (!session.hasUser && session.time > fallbackTime) {
      fallbackId = agentId;
      fallbackTime = session.time;
    }
  }
  return userBestId || fallbackId;
}

// ─── 闲不住小提示列表（随机展示，不剧透但留线索） ───
const TIPS = [
  "💡 说不定会有意外之喜哦，多试试看吧",
  "💡 请及时领取光粒，未及时领取的光粒第二天会有衰减哦",
  "💡 互动和送礼都会获得对应助手的回应，试试看吧",
  "💡 恶作剧时你的助手会有意想不到的反应……",
  "💡 有时候静悄悄的陪伴，反而是最暖的",
  "💡 不同的助手的回应风格不太一样，可以换着试试",
  "💡 每天来看看，说不定会有新的发现",
];

// ─── 随机取一条 tip ───
export function randomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

// ─── 充电提示池 ───
const RECHARGE_TIPS = [
  "伸了个懒腰，活力满满 ⚡",
  "满电啦！又可以陪你到处逛了 ✨",
  "充好了~刚才其实已经有点困了嘿嘿",
  "感觉全身充满了力量！💪",
  "⚡ 叮——电量 100%",
  "精神抖擞，电量满格 🌟",
  "充完电感觉又能再战三百回合！",
  "像刚喝完一杯冰美式，清醒了 ☕",
];

export function getRechargeTip() {
  return RECHARGE_TIPS[Math.floor(Math.random() * RECHARGE_TIPS.length)];
}

// ─── 充电状态查询/标记 ───
export function isRechargedToday(data, partnerId) {
  const today = getToday(data);
  const pd = today.partners[partnerId];
  return pd?.recharged === true;
}

export function markRechargedToday(data, partnerId) {
  const today = getToday(data);
  if (!today.partners[partnerId]) {
    today.partners[partnerId] = {
      contributed: false,
      narrative: "",
      effortLP: 0,
    };
  }
  today.partners[partnerId].recharged = true;
}

// ─── 随机摸鱼 ───
export function randomIdle(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
