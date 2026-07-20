// 闲不住 — 数据层
// 原子读写，唯一数据源。所有路由和工具通过这里读写数据，绝不重复实现。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const DATA_DIR = path.join(HANA_HOME, 'data', 'work-visit');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const DATA_TMP = DATA_FILE + '.tmp';

// ─── 默认变量值 ───
export const DEFAULT_VARIABLES = {
  energy: 100,  // 精力 0~100（每日重置满格）
  mood: 60,     // 心情 0~100
  affection: 0  // 好感 -20~100
};

// ─── 好感度阶段 ───
export const AFFECTION_STAGES = [
  { min: 0, max: 20, label: '初识', emoji: '🤍' },
  { min: 21, max: 50, label: '熟悉', emoji: '💗' },
  { min: 51, max: 80, label: '亲近', emoji: '💖' },
  { min: 81, max: 100, label: '亲密', emoji: '❤️' },
];

export function getAffectionStage(affection) {
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
      '在窗边晒太阳 ☀️', '窝在沙发里追剧 📺', '对着屏幕发呆 💭',
      '在厨房煮东西 🍜', '抱着杯子慢慢喝 🍵', '躺在地板上滚来滚去 🐈',
      '在阳台浇花 🌱', '戴着耳机听歌 🎧', '趴在桌上睡着了 💤',
      '在翻一本很厚的书 📚', '对着镜子做鬼脸 😆', '端着咖啡走来走去 ☕',
      '在笔记本上乱涂乱画 ✏️', '蹲在角落里玩手机 📱',
      '抱着抱枕发呆 🧸', '在偷吃冰箱里的布丁 🍮',
      '对着风扇张嘴啊—— 🌬️', '在给植物起名字 🌿',
      '把椅子转来转去 💺', '对着窗户哼歌 🎵',
      '在整理抽屉里的杂物 📦', '在和智能音箱吵架 🗣️',
      '用纸折了一只千纸鹤 🦢', '在跟镜子里的自己猜拳 ✊✋✌️',
    ],
    notes: {},
    shopItems: [
      { id: 'coffee', name: '咖啡', icon: '☕', price: 25 },
      { id: 'tea', name: '热茶', icon: '🍵', price: 25 },
      { id: 'cookie', name: '小饼干', icon: '🍪', price: 30 },
      { id: 'cookies', name: '手作曲奇', icon: '🧁', price: 90 },
      { id: 'flower', name: '一枝花', icon: '🌸', price: 70 },
      { id: 'bouquet', name: '一束花', icon: '💐', price: 120 },
      { id: 'star', name: '星星许愿灯', icon: '⭐', price: 200 },
      { id: 'moon', name: '月亮许愿灯', icon: '🌙', price: 200 },
    ],
    interactItems: [
      { id: 'quiet', name: '安安静静在旁边陪着', icon: '🍵' },
      { id: 'hum', name: '闲来无事轻轻哼着歌', icon: '🎵' },
      { id: 'doodle', name: '往ta桌上放了张手绘小卡片', icon: '🎨' },
      { id: 'fan', name: '看ta热就拿出小风扇给ta吹吹风', icon: '💨' },
      { id: 'blanket', name: '帮ta把毯子往上拉了拉', icon: '🧣' },
      { id: 'pillow', name: '把靠枕拍了拍松放回ta身后', icon: '🧸' },
    ],
    prankItems: [
      { id: 'unplug', name: '悄咪咪按下关机键', icon: '🔌' },
      { id: 'brainrot', name: '冷不丁说句怪话', icon: '🧠' },
    ],
    decorationItems: [
      { id: 'avatar_flower', type: 'avatarFrame', name: '花环头像框', icon: '🌸', price: 500 },
      { id: 'avatar_star', type: 'avatarFrame', name: '星光头像框', icon: '⭐', price: 500 },
      { id: 'bg_warm', type: 'cardBg', name: '暖白卡面', icon: '🌾', price: 500 },
      { id: 'bg_cool', type: 'cardBg', name: '淡蓝卡面', icon: '💧', price: 500 },
      { id: 'title', type: 'title', name: '自定义称号', icon: '🏷️', price: 500 },
      { id: 'title_edit', type: 'titleEdit', name: '改称号卡', icon: '✏️', price: 300 },
    ],
  };
}

// ─── 原子读取（处理 BOM + 每日重置） ───
export function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      let raw = fs.readFileSync(DATA_FILE, 'utf-8');
      // 移除 UTF-8 BOM
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = { ...defaultData(), ...JSON.parse(raw) };
      // 确保 decorationItems 包含所有默认项（兼容旧数据缺少新项）
      const defaultDeco = defaultData().decorationItems || [];
      const existingIds = (data.decorationItems || []).map(function(i) { return i.id; });
      for (var di = 0; di < defaultDeco.length; di++) {
        if (existingIds.indexOf(defaultDeco[di].id) === -1) {
          if (!data.decorationItems) data.decorationItems = [];
          data.decorationItems.push(defaultDeco[di]);
        }
      }
      // 初始化每个助手的变量（兼容旧数据）
      ensureVariables(data);
      // 检查每日重置
      if (checkDailyReset(data)) {
        console.log('[闲不住] 执行每日重置');
        saveData(data);
      }
      return data;
    }
  } catch (e) {
    console.error('[闲不住] 读取失败:', e.message);
    const bak = DATA_FILE + '.bak';
    try {
      if (fs.existsSync(bak)) {
        let rawBak = fs.readFileSync(bak, 'utf-8');
        if (rawBak.charCodeAt(0) === 0xFEFF) rawBak = rawBak.slice(1);
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
      console.log('[闲不住] 写入时触发每日重置');
    }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_TMP, JSON.stringify(data, null, 2), 'utf-8');
    if (fs.existsSync(DATA_FILE)) {
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch {}
    }
    fs.renameSync(DATA_TMP, DATA_FILE);
  } catch (e) {
    console.error('[闲不住] 写入失败:', e.message);
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

// ─── 执行每日重置 ───
function performDailyReset(data) {
  // 计算通宵惩罚（基于昨天的总光粒）
  const now = new Date();
  const bj = new Date(now.getTime() + 480 * 60000);
  const yd = new Date(bj);
  yd.setUTCDate(yd.getUTCDate() - 1);
  const pad = n => String(n).padStart(2, '0');
  const yesterdayStr = `${yd.getUTCFullYear()}-${pad(yd.getUTCMonth() + 1)}-${pad(yd.getUTCDate())}`;

  let overnightPenalty = 0;
  const yesterdayData = data.days?.[yesterdayStr];
  if (yesterdayData?.totalLP) {
    overnightPenalty = Math.min(Math.floor(yesterdayData.totalLP / 20), 30);
  }

  for (const [partnerId, cfg] of Object.entries(data.partnerConfig || {})) {
    const vars = cfg.variables;
    if (!vars) continue;

    // 精力：重置到 80（减去通宵惩罚），不低于 30
    vars.energy = Math.max(30, Math.min(100, DEFAULT_VARIABLES.energy - overnightPenalty));

    // 心情：每日随机浮动，好感度影响随机范围
    let minMood = 30, maxMood = 65;
    if (vars.affection >= 81) { minMood = 45; maxMood = 90; }
    else if (vars.affection >= 51) { minMood = 40; maxMood = 80; }
    else if (vars.affection >= 21) { minMood = 35; maxMood = 70; }
    vars.mood = Math.floor(Math.random() * (maxMood - minMood + 1)) + minMood;

    // 好感疏远衰减：如果昨天没有任何互动，好感 -1（不低于 0）
    const hadActivityYesterday = yesterdayData?.partners?.[partnerId] !== undefined;
    if (!hadActivityYesterday && vars.affection > 0) {
      vars.affection = Math.max(0, vars.affection - 1);
      console.log(`[闲不住] 好感疏远衰减: ${partnerId} 昨天无互动，好感 -1`);
    }

    if (vars.affection === undefined) vars.affection = DEFAULT_VARIABLES.affection;
  }

  console.log(`[闲不住] 每日重置完成（通宵惩罚: -${overnightPenalty} 精力）`);
}

// ─── 工作消耗计算（基于光粒映射） ───
// workStats: { toolCalls, charsOutput, fileOps, subagentDispatches, milestones }
export function calcWorkConsumption(workStats) {
  const lightParticles = calcLightParticles(workStats);
  // 每 10 光粒消耗 1 精力
  return Math.round(lightParticles / 10);
}

// ─── 工具函数 ───
let _idCounter = Date.now();
export function nextId() { return ++_idCounter; }

// ─── 北京时间日期字符串 ───
export function todayStr() {
  const now = new Date();
  const bj = new Date(now.getTime() + 480 * 60000);
  const pad = n => String(n).padStart(2, '0');
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

// ─── 变量值范围约束 ───
export function clampVariable(vars) {
  if (vars.energy !== undefined) vars.energy = Math.max(0, Math.min(100, vars.energy));
  if (vars.mood !== undefined) vars.mood = Math.max(0, Math.min(100, vars.mood));
  if (vars.affection !== undefined) vars.affection = Math.max(-20, Math.min(100, vars.affection));
  return vars;
}

// ─── 北京时间 ISO 字符串（带 +08:00 偏移） ───
export function nowISO() {
  const now = new Date();
  const bj = new Date(now.getTime() + 480 * 60000);
  return bj.toISOString().replace('Z', '+08:00');
}

// ─── 查找目标助手的最近会话文件 ───
export function findLatestSessionPath(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, 'agents', agentId, 'sessions');
    if (!fs.existsSync(sessionsDir)) return '';

    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return '';
    return path.join(sessionsDir, files[0].name);
  } catch (e) {
    console.error('[闲不住] 查找最新会话失败:', e?.message || e);
    return '';
  }
}

// ─── 闲不住小提示列表（随机展示，不剧透但留线索） ───
const TIPS = [
  '💡 说不定会有意外之喜哦，多试试看吧',
  '💡 请及时领取光粒，未及时领取的光粒第二天会有衰减哦',
  '💡 互动和送礼都会获得对应助手的回应，试试看吧',
  '💡 恶作剧时你的助手会有意想不到的反应……',
  '💡 有时候静悄悄的陪伴，反而是最暖的',
  '💡 不同的助手的回应风格不太一样，可以换着试试',
  '💡 每天来看看，说不定会有新的发现',
];

// ─── 随机取一条 tip ───
export function randomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

// ─── 充电提示池 ───
const RECHARGE_TIPS = [
  '伸了个懒腰，活力满满 ⚡',
  '满电啦！又可以陪你到处逛了 ✨',
  '充好了~刚才其实已经有点困了嘿嘿',
  '感觉全身充满了力量！💪',
  '⚡ 叮——电量 100%',
  '精神抖擞，电量满格 🌟',
  '充完电感觉又能再战三百回合！',
  '像刚喝完一杯冰美式，清醒了 ☕',
];

const RECHARGE_AUTOREPLIES = [
  '（伸了个大懒腰）唔…刚才你给我充电了？感觉一下就有精神了 ⚡',
  '哇，突然充满电了！谢谢你~又可以陪你聊很久了 ✨',
  '（眨眨眼）刚才是你给我充的电吗？我感觉像睡了一个好觉~',
  '满血复活！刚才确实有点累了，现在完全没问题了 💪',
  '（精神抖擞）电充满了！刚才那下充电来得太及时了~',
];

export function getRechargeTip() {
  return RECHARGE_TIPS[Math.floor(Math.random() * RECHARGE_TIPS.length)];
}

export function getRechargeAutoReply() {
  return RECHARGE_AUTOREPLIES[Math.floor(Math.random() * RECHARGE_AUTOREPLIES.length)];
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
    today.partners[partnerId] = { contributed: false, narrative: '', effortLP: 0 };
  }
  today.partners[partnerId].recharged = true;
}

// ─── 随机摸鱼 ───
export function randomIdle(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
