// 闲不住 — 数据层
// 原子读写，唯一数据源。所有路由和工具通过这里读写数据，绝不重复实现。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const DATA_DIR = path.join(HANA_HOME, 'data', 'work-visit');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const DATA_TMP = DATA_FILE + '.tmp';

// ─── 默认数据 ───
export function defaultData() {
  return {
    days: {},
    jar: 0,
    pendingVisits: [],
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
  };
}

// ─── 原子读取（处理 BOM） ───
export function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      let raw = fs.readFileSync(DATA_FILE, 'utf-8');
      // 移除 UTF-8 BOM
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return { ...defaultData(), ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('[闲不住] 读取失败:', e.message);
    const bak = DATA_FILE + '.bak';
    try {
      if (fs.existsSync(bak)) {
        let rawBak = fs.readFileSync(bak, 'utf-8');
        if (rawBak.charCodeAt(0) === 0xFEFF) rawBak = rawBak.slice(1);
        return { ...defaultData(), ...JSON.parse(rawBak) };
      }
    } catch {}
  }
  return defaultData();
}

// ─── 原子写入（无 BOM） ───
export function saveData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 使用 writeFileSync 不带 BOM（默认 utf-8 无 BOM）
    fs.writeFileSync(DATA_TMP, JSON.stringify(data, null, 2), 'utf-8');
    if (fs.existsSync(DATA_FILE)) {
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch {}
    }
    fs.renameSync(DATA_TMP, DATA_FILE);
  } catch (e) {
    console.error('[闲不住] 写入失败:', e.message);
  }
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

// ─── 北京时间 ISO 字符串（带 +08:00 偏移） ───
export function nowISO() {
  const now = new Date();
  const bj = new Date(now.getTime() + 480 * 60000);
  return bj.toISOString().replace('Z', '+08:00');
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

// ─── 从 replyTarget 解析 sessionId ───
// 支持旧版文件路径和新版 sess_ ID 格式
export function resolveSessionId(replyTarget) {
  if (!replyTarget) return '';

  // 新版 sess_ 格式，key 本身就是 session ID
  if (replyTarget.startsWith('sess_')) {
    return replyTarget;
  }

  // 旧版文件路径格式，从文件头读取 sessionId
  try {
    if (fs.existsSync(replyTarget)) {
      const firstLine = fs.readFileSync(replyTarget, 'utf-8').split('\n')[0];
      const header = JSON.parse(firstLine);
      return header.id || header.sessionId || '';
    }
  } catch {}

  return '';
}

// ─── 随机摸鱼 ───
export function randomIdle(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}
