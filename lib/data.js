// 闲不住 — 数据层
// 原子读写，唯一数据源。所有路由和工具通过这里读写数据，绝不重复实现。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    // ─── 漂流瓶旧数据（2026-08-10 起：独立插件迁移用，闲不住不再推进/展示） ───
    bottles: [], // 旧瓶子数据，保留待独立漂流瓶插件一次性迁移
    sea: { lastTick: null }, // 旧海状态，保留待迁移
    // ─── 风铃悬浮球偏好（2026-08-10 新增） ───
    fengling: { autoStart: true }, // 打开闲不住页面时是否自动启动风铃
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
      {
        id: "bg_warm",
        type: "cardBg",
        name: "暖白卡面",
        icon: "🌾",
        price: 500,
      },
      {
        id: "bg_cool",
        type: "cardBg",
        name: "淡蓝卡面",
        icon: "💧",
        price: 500,
      },
      {
        id: "title",
        type: "title",
        name: "自定义称号",
        icon: "🏷️",
        price: 500,
      },
      {
        id: "title_edit",
        type: "titleEdit",
        name: "改称号卡",
        icon: "✏️",
        price: 300,
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
      // 确保 decorationItems 按默认顺序重排（头像框在前、卡面/称号在后），
      // 兼容旧数据缺项、乱序、重复；未知的自定义条目保持原相对顺序排末尾
      const defaultDeco = defaultData().decorationItems || [];
      const decoMap = {};
      for (const diItem of data.decorationItems || []) {
        if (!decoMap[diItem.id]) decoMap[diItem.id] = diItem;
      }
      const reorderedDeco = [];
      const placedIds = {};
      for (const def of defaultDeco) {
        const item = decoMap[def.id];
        if (item) {
          reorderedDeco.push(item);
          placedIds[def.id] = true;
        }
      }
      for (const diItem of data.decorationItems || []) {
        if (!placedIds[diItem.id]) {
          reorderedDeco.push(diItem);
          placedIds[diItem.id] = true;
        }
      }
      data.decorationItems = reorderedDeco;
      // 初始化每个助手的变量（兼容旧数据）
      ensureVariables(data);
      // 检查每日重置
      if (checkDailyReset(data)) {
        console.log("[闲不住] 执行每日重置");
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
        ensureVariables(data);
        return data;
      }
    } catch {}
  }
  return defaultData();
}

// ─── 确保每个助手有变量（兼容旧数据） ───
function ensureVariables(data) {
  for (const [id, cfg] of Object.entries(data.partnerConfig || {})) {
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

// ─── 原子写入（无 BOM + 每日重置检查） ───
export function saveData(data) {
  try {
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
  } catch (e) {
    console.error("[闲不住] 写入失败:", e.message);
  }
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
    if (!hadActivityYesterday && vars.affection > 0) {
      vars.affection = Math.max(0, vars.affection - 1);
      console.log(`[闲不住] 好感疏远衰减: ${partnerId} 昨天无互动，好感 -1`);
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
export function nowISO() {
  const now = new Date();
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

// ─── 从会话文件尾部向前解析最后一条用户消息的时间（ms），找不到返回 null ───
function getLastUserMsgTime(filePath) {
  const parseLine = (lineBuffer) => {
    const line = lineBuffer.toString("utf-8").trim();
    if (!line) return null;
    try {
      const d = JSON.parse(line);
      if (d?.type === "message" && d?.message?.role === "user") {
        return normalizeMessageTimestamp(d.message.timestamp ?? d.timestamp);
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

// ─── 查找目标助手的最近会话 ───
// 按「最后一条用户消息」的时间判断活跃窗口（mtime 会被推送/助手回复扰动，不可靠）；
// 没有用户消息的会话兜底用 mtime。
function findLatestSession(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return { path: "", time: -Infinity, hasUser: false };
    }

    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) {
      return { path: "", time: -Infinity, hasUser: false };
    }

    let userPath = "";
    let userTime = -Infinity;
    let fallbackPath = "";
    let fallbackTime = -Infinity;
    for (const f of files) {
      const full = path.join(sessionsDir, f);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs > fallbackTime) {
        fallbackTime = stat.mtimeMs;
        fallbackPath = full;
      }
      const lastUserTime = getLastUserMsgTime(full);
      if (lastUserTime !== null && lastUserTime > userTime) {
        userTime = lastUserTime;
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
