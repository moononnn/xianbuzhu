// lib/variables.js — 助手变量数值规则（从原 llm.js 拆出）
// 职责：事件 → 变量（精力/心情/好感）变化的声明式规则表、耦合计算、审计日志
// 注意：这里是纯数值计算，不涉及任何 LLM 调用——它原本误住在 llm.js 里（错抽屉教训）

import { clampVariable, nowISO } from "./data.js";

// ─── 变量变化规则表（声明式配置） ───
const VARIABLE_RULES = {
  // 互动
  quiet: { energy: -3, mood: 5, affection: 1 },
  hum: { energy: -5, mood: 3, affection: 0.5 },
  doodle: { energy: -8, mood: 8, affection: 2 },
  fan: { energy: -4, mood: 4, affection: 0.5 },
  blanket: { energy: -3, mood: 6, affection: 0.5 },
  pillow: { energy: -3, mood: 4, affection: 0.5 },
  // 恶作剧（消耗精力，但玩闹性质让心情微升）
  unplug: { energy: -10, mood: 3 },
  brainrot: { energy: -3, mood: 5 },
  // 礼物
  coffee: { energy: 10, mood: 3, affection: 1 },
  tea: { energy: 10, mood: 3, affection: 1 },
  cookie: { energy: 5, mood: 3, affection: 1 },
  cookies: { energy: 8, mood: 9, affection: 3 },
  flower: { energy: 0, mood: 7, affection: 2 },
  bouquet: { energy: 0, mood: 12, affection: 4 },
  star: { energy: 0, mood: 20, affection: 7 },
  moon: { energy: 0, mood: 20, affection: 7 },
};

// 礼物基础回应消耗
const GIFT_BASE_ENERGY_COST = -5;

// ─── 根据事件类型修改变量（配置表驱动 + 变量耦合） ───
export function applyVariableChanges(vars, visit) {
  if (!vars) return;

  const rule = VARIABLE_RULES[visit.itemId];
  if (!rule) {
    console.log(`[闲不住] 未知事件: ${visit.itemId}`);
    return;
  }

  // 保存变化前的值用于耦合计算
  const energyBefore = vars.energy;
  const moodBefore = vars.mood;

  if (visit.type === "gift") {
    // 礼物：基础回应消耗 + 礼物自身效果
    vars.energy += GIFT_BASE_ENERGY_COST + (rule.energy || 0);
    vars.mood += rule.mood || 0;
    vars.affection += rule.affection || 0;
  } else {
    // 互动/恶作剧：直接应用规则
    vars.energy += rule.energy || 0;
    vars.mood += rule.mood || 0;
    vars.affection += rule.affection || 0;
  }

  // 变量耦合：低谷放大器
  // 精力 < 30 时，心情增量打 5 折（只对正增量生效；恶作剧除外——
  // 朋友间开玩笑的开心不打折，与"恶作剧不降心情"承诺一致）
  if (visit.type !== "prank" && energyBefore < 30 && rule.mood > 0) {
    const moodGain = vars.mood - moodBefore;
    vars.mood = moodBefore + Math.round(moodGain * 0.5);
  }
  // 心情 < 20 时，精力消耗 +50%（只对负消耗生效）
  if (moodBefore < 20 && rule.energy < 0) {
    const energyLoss = energyBefore - vars.energy;
    vars.energy = energyBefore - Math.round(energyLoss * 1.5);
  }

  // 约束变量范围
  clampVariable(vars);
}

// ─── 变量变更审计日志 ───
let _varLog = [];
export function logVariableChange(partnerId, visit, varsBefore, varsAfter) {
  _varLog.push({
    time: nowISO(),
    partnerId,
    eventType: visit.type,
    eventItem: visit.itemId,
    before: { ...varsBefore },
    after: { ...varsAfter },
  });
  // 只保留最近 100 条
  if (_varLog.length > 100) _varLog = _varLog.slice(-100);
}

export function getVariableLog() {
  return _varLog;
}
