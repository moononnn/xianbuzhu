// 闲不住 — 变量系统单元测试（node:test）
// 覆盖：心情推演（computeMoodShift）、原因生成（buildMoodReason）、
//       模糊描述（describeMood/describeEnergy/buildMoodContext）、范围约束（clampVariable）
// 运行：node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMoodShift,
  buildMoodReason,
  describeMood,
  describeEnergy,
  describeAffection,
  buildMoodContext,
  clampVariable,
  recordEvent,
} from '../lib/data.js';

// ─── computeMoodShift：昨日事件 → 心情修正 ───

test('computeMoodShift: 无事件或空数组 = 0（由调用方走自主漂移）', () => {
  assert.equal(computeMoodShift(undefined), 0);
  assert.equal(computeMoodShift([]), 0);
});

test('computeMoodShift: 礼物按价格分档', () => {
  assert.equal(computeMoodShift([{ type: 'gift', price: 120 }]), 6);
  assert.equal(computeMoodShift([{ type: 'gift', price: 100 }]), 6);
  assert.equal(computeMoodShift([{ type: 'gift', price: 70 }]), 4);
  assert.equal(computeMoodShift([{ type: 'gift', price: 50 }]), 4);
  assert.equal(computeMoodShift([{ type: 'gift', price: 30 }]), 2);
  assert.equal(computeMoodShift([{ type: 'gift', price: 25 }]), 1);
  assert.equal(computeMoodShift([{ type: 'gift', price: 0 }]), 1);
});

test('computeMoodShift: 恶作剧不降心情（朋友开玩笑），互动 +1，充电 +3', () => {
  assert.equal(computeMoodShift([{ type: 'prank' }]), 0);
  assert.equal(computeMoodShift([{ type: 'interact' }]), 1);
  assert.equal(computeMoodShift([{ type: 'recharge' }]), 3);
});

test('computeMoodShift: 组合计算与上限 clamp', () => {
  // 大礼物 + 互动 + 充电 = 6+1+3 = 10
  assert.equal(computeMoodShift([
    { type: 'gift', price: 120 },
    { type: 'interact' },
    { type: 'recharge' },
  ]), 10);
  // 恶作剧不影响，无负值
  assert.equal(computeMoodShift([
    { type: 'prank' }, { type: 'prank' }, { type: 'prank' },
  ]), 0);
  // 很多大礼物不超过上限 12
  assert.equal(computeMoodShift([
    { type: 'gift', price: 120 }, { type: 'gift', price: 120 },
    { type: 'gift', price: 120 }, { type: 'gift', price: 120 },
  ]), 12);
});

// ─── buildMoodReason：昨日事件 → 原因一句话 ───

test('buildMoodReason: 空数组 = 不编造原因', () => {
  assert.equal(buildMoodReason([]), '');
});

test('buildMoodReason: 礼物优先，且取最贵的', () => {
  const events = [
    { type: 'interact', price: 0 },
    { type: 'gift', itemName: '小饼干', price: 30 },
    { type: 'gift', itemName: '一束花', price: 120 },
  ];
  assert.equal(buildMoodReason(events), '昨天收到了一束花');
});

test('buildMoodReason: 无礼物时互动优先于充电', () => {
  assert.equal(buildMoodReason([
    { type: 'interact' }, { type: 'recharge' },
  ]), '昨天有人来陪着待了会儿');
});

test('buildMoodReason: 只有互动 / 只有充电', () => {
  assert.equal(buildMoodReason([{ type: 'interact' }]), '昨天有人来陪着待了会儿');
  assert.equal(buildMoodReason([{ type: 'recharge' }]), '昨天被充了电，精神头不错');
});

// ─── 模糊描述 ───

test('describeMood: 各档位边界', () => {
  assert.equal(describeMood(100), '心情很好');
  assert.equal(describeMood(80), '心情很好');
  assert.equal(describeMood(79), '心情不错');
  assert.equal(describeMood(65), '心情不错');
  assert.equal(describeMood(64), '心情平稳');
  assert.equal(describeMood(40), '心情平稳');
  assert.equal(describeMood(39), '有点闷');
  assert.equal(describeMood(25), '有点闷');
  assert.equal(describeMood(24), '心情很差');
  assert.equal(describeMood(0), '心情很差');
});

test('describeEnergy: 各档位边界', () => {
  assert.equal(describeEnergy(100), '精力充沛');
  assert.equal(describeEnergy(70), '精力充沛');
  assert.equal(describeEnergy(69), '还行');
  assert.equal(describeEnergy(40), '还行');
  assert.equal(describeEnergy(39), '有点累');
  assert.equal(describeEnergy(20), '有点累');
  assert.equal(describeEnergy(19), '累坏了');
});

test('describeAffection: 各档位边界（关系进度也模糊化，不给数字）', () => {
  assert.equal(describeAffection(100), '你们亲密无间');
  assert.equal(describeAffection(81), '你们亲密无间');
  assert.equal(describeAffection(80), '你们已经很亲近');
  assert.equal(describeAffection(51), '你们已经很亲近');
  assert.equal(describeAffection(50), '你们正在慢慢熟悉');
  assert.equal(describeAffection(21), '你们正在慢慢熟悉');
  assert.equal(describeAffection(20), '你们还不算熟');
  assert.equal(describeAffection(0), '你们还不算熟');
  assert.equal(describeAffection(-5), '你们之间有点疏远');
  assert.equal(describeAffection(-20), '你们之间有点疏远');
});

test('buildMoodContext: 带原因/不带原因/空 vars', () => {
  assert.equal(buildMoodContext(null), '');
  const withReason = buildMoodContext({ mood: 70, energy: 50, affection: 30, moodReason: '昨天收到了一束花' });
  assert.ok(withReason.includes('心情不错'));
  assert.ok(withReason.includes('昨天收到了一束花'));
  assert.ok(withReason.includes('你们正在慢慢熟悉'));
  const noReason = buildMoodContext({ mood: 70, energy: 50, affection: 30 });
  assert.ok(!noReason.includes('昨天收到了一束花'));
});

test('buildMoodContext: 注入文本零数字', () => {
  const text = buildMoodContext({ mood: 88, energy: 95, affection: 98, moodReason: '昨天收到了一束花' });
  // 不应出现任何数字（好感度数值、心情数值、精力数值都不能有）
  assert.ok(!/\d/.test(text), '注入文本不应包含数字: ' + text);
});

// ─── recordEvent：今日事件记录结构 ───

test('recordEvent: 追加事件到今日 partners，兼容无记录', () => {
  const data = {
    days: {},
    partnerConfig: { hanako: { name: '小花' } },
  };
  recordEvent(data, 'hanako', { type: 'gift', itemId: 'flower', itemName: '一枝花', price: 70 });
  recordEvent(data, 'hanako', { type: 'prank', itemId: 'unplug', itemName: '关机键', price: 0 });
  const todayKey = Object.keys(data.days)[0];
  const events = data.days[todayKey].partners.hanako.events;
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'gift');
  assert.equal(events[0].itemName, '一枝花');
  assert.equal(events[0].price, 70);
  assert.ok(events[0].ts);
});

// ─── clampVariable：范围约束 ───

test('clampVariable: 越界值被收敛', () => {
  const vars = { energy: 150, mood: -10, affection: -50 };
  clampVariable(vars);
  assert.equal(vars.energy, 100);
  assert.equal(vars.mood, 0);
  assert.equal(vars.affection, -20);
  const vars2 = { energy: 0, mood: 0, affection: 200 };
  clampVariable(vars2);
  assert.equal(vars2.energy, 0);
  assert.equal(vars2.affection, 100);
});
