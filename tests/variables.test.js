// 闲不住 — 变量系统单元测试（node:test）
// 覆盖：心情推演（computeMoodShift）、原因生成（buildMoodReason）、
//       模糊描述（describeMood/describeEnergy/buildMoodContext）、范围约束（clampVariable）
// 运行：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMoodShift,
  buildMoodReason,
  describeMood,
  describeEnergy,
  describeAffection,
  buildMoodContext,
  clampVariable,
  recordEvent,
  getAffectionStage,
  performDailyReset,
  calcWorkConsumption,
  syncWorkDeduction,
  getToday,
} from "../lib/data.js";
import { shouldTriggerNote, isNoteOnCooldown, hasAiFlavor, parseReview } from "../lib/llm.js";

// ─── computeMoodShift：昨日事件 → 心情修正 ───

test("computeMoodShift: 无事件或空数组 = 0（由调用方走自主漂移）", () => {
  assert.equal(computeMoodShift(undefined), 0);
  assert.equal(computeMoodShift([]), 0);
});

test("computeMoodShift: 礼物按价格分档", () => {
  assert.equal(computeMoodShift([{ type: "gift", price: 120 }]), 6);
  assert.equal(computeMoodShift([{ type: "gift", price: 100 }]), 6);
  assert.equal(computeMoodShift([{ type: "gift", price: 70 }]), 4);
  assert.equal(computeMoodShift([{ type: "gift", price: 50 }]), 4);
  assert.equal(computeMoodShift([{ type: "gift", price: 30 }]), 2);
  assert.equal(computeMoodShift([{ type: "gift", price: 25 }]), 1);
  assert.equal(computeMoodShift([{ type: "gift", price: 0 }]), 1);
});

test("computeMoodShift: 恶作剧不降心情（朋友开玩笑），互动 +1，充电 +3", () => {
  assert.equal(computeMoodShift([{ type: "prank" }]), 0);
  assert.equal(computeMoodShift([{ type: "interact" }]), 1);
  assert.equal(computeMoodShift([{ type: "recharge" }]), 3);
});

test("computeMoodShift: 组合计算与上限 clamp", () => {
  // 大礼物 + 互动 + 充电 = 6+1+3 = 10
  assert.equal(
    computeMoodShift([
      { type: "gift", price: 120 },
      { type: "interact" },
      { type: "recharge" },
    ]),
    10,
  );
  // 恶作剧不影响，无负值
  assert.equal(
    computeMoodShift([{ type: "prank" }, { type: "prank" }, { type: "prank" }]),
    0,
  );
  // 很多大礼物不超过上限 12
  assert.equal(
    computeMoodShift([
      { type: "gift", price: 120 },
      { type: "gift", price: 120 },
      { type: "gift", price: 120 },
      { type: "gift", price: 120 },
    ]),
    12,
  );
});

// ─── buildMoodReason：昨日事件 → 原因一句话 ───

test("buildMoodReason: 空数组 = 不编造原因", () => {
  assert.equal(buildMoodReason([]), "");
});

test("buildMoodReason: 礼物优先，且取最贵的", () => {
  const events = [
    { type: "interact", price: 0 },
    { type: "gift", itemName: "小饼干", price: 30 },
    { type: "gift", itemName: "一束花", price: 120 },
  ];
  assert.equal(buildMoodReason(events), "昨天收到了一束花");
});

test("buildMoodReason: 无礼物时互动优先于充电", () => {
  assert.equal(
    buildMoodReason([{ type: "interact" }, { type: "recharge" }]),
    "昨天有人来陪着待了会儿",
  );
});

test("buildMoodReason: 只有互动 / 只有充电", () => {
  assert.equal(
    buildMoodReason([{ type: "interact" }]),
    "昨天有人来陪着待了会儿",
  );
  assert.equal(
    buildMoodReason([{ type: "recharge" }]),
    "昨天被充了电，精神头不错",
  );
});

// ─── 模糊描述 ───

test("describeMood: 各档位边界", () => {
  assert.equal(describeMood(100), "心情很好");
  assert.equal(describeMood(80), "心情很好");
  assert.equal(describeMood(79), "心情不错");
  assert.equal(describeMood(65), "心情不错");
  assert.equal(describeMood(64), "心情平稳");
  assert.equal(describeMood(40), "心情平稳");
  assert.equal(describeMood(39), "有点闷");
  assert.equal(describeMood(25), "有点闷");
  assert.equal(describeMood(24), "心情很差");
  assert.equal(describeMood(0), "心情很差");
});

test("describeEnergy: 各档位边界", () => {
  assert.equal(describeEnergy(100), "精力充沛");
  assert.equal(describeEnergy(70), "精力充沛");
  assert.equal(describeEnergy(69), "还行");
  assert.equal(describeEnergy(40), "还行");
  assert.equal(describeEnergy(39), "有点累");
  assert.equal(describeEnergy(20), "有点累");
  assert.equal(describeEnergy(19), "累坏了");
});

test("describeAffection: 各档位边界（关系进度也模糊化，不给数字）", () => {
  assert.equal(describeAffection(100), "你们亲密无间");
  assert.equal(describeAffection(81), "你们亲密无间");
  assert.equal(describeAffection(80), "你们已经很亲近");
  assert.equal(describeAffection(51), "你们已经很亲近");
  assert.equal(describeAffection(50), "你们正在慢慢熟悉");
  assert.equal(describeAffection(21), "你们正在慢慢熟悉");
  assert.equal(describeAffection(20), "你们还不算熟");
  assert.equal(describeAffection(0), "你们还不算熟");
  assert.equal(describeAffection(-5), "你们之间有点疏远");
  assert.equal(describeAffection(-20), "你们之间有点疏远");
});

test("buildMoodContext: 带原因/不带原因/空 vars", () => {
  assert.equal(buildMoodContext(null), "");
  const withReason = buildMoodContext({
    mood: 70,
    energy: 50,
    affection: 30,
    moodReason: "昨天收到了一束花",
  });
  assert.ok(withReason.includes("心情不错"));
  assert.ok(withReason.includes("昨天收到了一束花"));
  assert.ok(withReason.includes("你们正在慢慢熟悉"));
  const noReason = buildMoodContext({ mood: 70, energy: 50, affection: 30 });
  assert.ok(!noReason.includes("昨天收到了一束花"));
});

test("buildMoodContext: 注入文本零数字", () => {
  const text = buildMoodContext({
    mood: 88,
    energy: 95,
    affection: 98,
    moodReason: "昨天收到了一束花",
  });
  // 不应出现任何数字（好感度数值、心情数值、精力数值都不能有）
  assert.ok(!/\d/.test(text), "注入文本不应包含数字: " + text);
});

// ─── recordEvent：今日事件记录结构 ───

test("recordEvent: 追加事件到今日 partners，兼容无记录", () => {
  const data = {
    days: {},
    partnerConfig: { hanako: { name: "小花" } },
  };
  recordEvent(data, "hanako", {
    type: "gift",
    itemId: "flower",
    itemName: "一枝花",
    price: 70,
  });
  recordEvent(data, "hanako", {
    type: "prank",
    itemId: "unplug",
    itemName: "关机键",
    price: 0,
  });
  const todayKey = Object.keys(data.days)[0];
  const events = data.days[todayKey].partners.hanako.events;
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "gift");
  assert.equal(events[0].itemName, "一枝花");
  assert.equal(events[0].price, 70);
  assert.ok(events[0].ts);
});

// ─── shouldTriggerNote：小纸条触发判断（回归测试：曾因嵌在 pending 分支永不触发） ───

test("shouldTriggerNote: 无必出档，互动 2%，礼物按价格阶梯下调", (t) => {
  // ≥150 是 50% 档，不再必出
  t.mock.method(Math, "random", () => 0.49);
  assert.equal(shouldTriggerNote({ type: "gift", price: 150 }), true);
  t.mock.method(Math, "random", () => 0.51);
  assert.equal(shouldTriggerNote({ type: "gift", price: 150 }), false);
  // ≥100 是 30% 档
  t.mock.method(Math, "random", () => 0.29);
  assert.equal(shouldTriggerNote({ type: "gift", price: 100 }), true);
  t.mock.method(Math, "random", () => 0.31);
  assert.equal(shouldTriggerNote({ type: "gift", price: 100 }), false);
  // ≥50 是 12% 档
  t.mock.method(Math, "random", () => 0.11);
  assert.equal(shouldTriggerNote({ type: "gift", price: 50 }), true);
  t.mock.method(Math, "random", () => 0.13);
  assert.equal(shouldTriggerNote({ type: "gift", price: 50 }), false);
  // 低价 8% 档
  t.mock.method(Math, "random", () => 0.07);
  assert.equal(shouldTriggerNote({ type: "gift", price: 10 }), true);
  t.mock.method(Math, "random", () => 0.09);
  assert.equal(shouldTriggerNote({ type: "gift", price: 10 }), false);
  // 互动/恶作剧 2% 档
  t.mock.method(Math, "random", () => 0.01);
  assert.equal(shouldTriggerNote({ type: "interact" }), true);
  assert.equal(shouldTriggerNote({ type: "prank" }), true);
  t.mock.method(Math, "random", () => 0.03);
  assert.equal(shouldTriggerNote({ type: "interact" }), false);
  assert.equal(shouldTriggerNote({ type: "unknown" }), false);
});

test("isNoteOnCooldown: 8 小时内最后一张纸条算冷却，超过不算", () => {
  const now = Date.now();
  const H = 60 * 60 * 1000;
  assert.equal(isNoteOnCooldown(undefined, now), false);
  assert.equal(isNoteOnCooldown([], now), false);
  // 正好 8 小时前，冷却已过
  assert.equal(isNoteOnCooldown([{ createdAt: new Date(now - 8 * H).toISOString() }], now), false);
  // 7 小时前，冷却中
  assert.equal(isNoteOnCooldown([{ createdAt: new Date(now - 7 * H).toISOString() }], now), true);
  // 刚生成，冷却中
  assert.equal(isNoteOnCooldown([{ createdAt: new Date(now - 1000).toISOString() }], now), true);
  // 旧数据没有 createdAt，不阻塞
  assert.equal(isNoteOnCooldown([{ content: "x" }], now), false);
  // 取最新的那条判断（数组乱序时也正确）
  const old = new Date(now - 9 * H).toISOString();
  const fresh = new Date(now - 1000).toISOString();
  assert.equal(isNoteOnCooldown([{ createdAt: old }, { createdAt: fresh }], now), true);
});

test("hasAiFlavor: 命中 AI 八股词返回 true", () => {
  assert.equal(hasAiFlavor("像一阕未写完的宋词"), false); // 单独「像」不杀，交给审核员
  assert.equal(hasAiFlavor("仿佛下一秒就要碎掉"), true);
  assert.equal(hasAiFlavor("一丝不悦"), true);
  assert.equal(hasAiFlavor("她不是害怕，而是一种更深的情绪"), true);
  assert.equal(hasAiFlavor("某种说不清的东西在胸口翻涌"), true);
  assert.equal(hasAiFlavor("种下会呼吸的哲学"), true);
  assert.equal(hasAiFlavor("嘴角的弧度"), true);
  assert.equal(hasAiFlavor("今天你送的糖我吃了，挺甜的"), false);
  assert.equal(hasAiFlavor(""), false);
});

test("parseReview: 解析审核员 JSON 回复，无法解析时保守不通过", () => {
  assert.deepEqual(parseReview('{"pass":true}'), { pass: true, reasons: [], suggestion: "" });
  const rejected = parseReview('{"pass":false,"reasons":["感谢体","太煽情"],"suggestion":"用大白话重写"}');
  assert.equal(rejected.pass, false);
  assert.ok(rejected.reasons.includes("太煽情"));
  assert.equal(rejected.suggestion, "用大白话重写");
  assert.equal(parseReview("乱七八糟的输出").pass, false);
  assert.equal(parseReview("").pass, false);
});

test("parseReview: 兼容 markdown 代码块、带引号值、纯文本通过/不通过", () => {
  // markdown 代码块包裹
  assert.equal(parseReview('```json\n{"pass":true}\n```').pass, true);
  // pass 值带引号
  assert.equal(parseReview('{"pass":"false","reasons":["太煽情"],"suggestion":"改"}').pass, false);
  // 纯文本通过/不通过
  assert.equal(parseReview("这张纸条写得不错，通过").pass, true);
  assert.equal(parseReview("不通过，太煽情了").pass, false);
  // 英文 ok / fail
  assert.equal(parseReview("ok, pass").pass, true);
});

test("getAffectionStage: 负好感返回疏远（与 describeAffection 口径一致）", () => {
  assert.equal(getAffectionStage(-1).label, "疏远");
  assert.equal(getAffectionStage(-20).label, "疏远");
  assert.equal(getAffectionStage(-5).emoji, "💔");
  assert.equal(getAffectionStage(0).label, "初识");
  assert.equal(getAffectionStage(100).label, "亲密");
});

test("getAffectionStage: NaN/非法值兜底为初识", () => {
  assert.equal(getAffectionStage(NaN).label, "初识");
  assert.equal(getAffectionStage(undefined).label, "初识");
});

// ─── performDailyReset：通宵惩罚按个人光粒（2026-08-06 修正：不再按全员合计连坐） ───

function makeResetFixture() {
  return {
    days: {
      "2026-08-05": {
        date: "2026-08-05",
        baseLP: 100,
        totalLP: 508,
        partners: {
          hanako: { contributed: false, narrative: "", effortLP: 403 },
          helperC: { contributed: false, narrative: "", effortLP: 0 },
        },
      },
    },
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 96 } },
      helperC: { name: "伙伴B", variables: { energy: 100, mood: 60, affection: 10 } },
    },
  };
}

test("performDailyReset: 通宵惩罚按个人光粒，干活多的扣、躺平满血", () => {
  const data = makeResetFixture();
  performDailyReset(data, "2026-08-05");
  // 昨天 hanako 403 光粒 → 403/30 = 13 → 精力 87（2026-08-07 调低系数后）
  assert.equal(data.partnerConfig.hanako.variables.energy, 87);
  // 昨天 helperC 0 光粒 → 满血 100
  assert.equal(data.partnerConfig.helperC.variables.energy, 100);
});

test("performDailyReset: 无昨日记录/无 effortLP 字段 = 不扣（兼容旧数据）", () => {
  const data = {
    days: {},
    partnerConfig: {
      helperA: { name: "伙伴A", variables: { energy: 100, mood: 60, affection: 38 } },
    },
  };
  performDailyReset(data, "2026-08-05");
  assert.equal(data.partnerConfig.helperA.variables.energy, 100);
});

test("performDailyReset: 光粒封顶 30 惩罚（超高光粒），精力不低于 30", () => {
  const data = {
    days: {
      "2026-08-05": {
        date: "2026-08-05",
        baseLP: 100,
        totalLP: 100,
        partners: {
          hanako: { contributed: false, narrative: "", effortLP: 9999 },
        },
      },
    },
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 96 } },
    },
  };
  performDailyReset(data, "2026-08-05");
  assert.equal(data.partnerConfig.hanako.variables.energy, 70); // 100-30 封顶
});

test("performDailyReset: 边界光粒（29 不扣，30 扣 1）", () => {
  const mk = (effort) => ({
    days: {
      "2026-08-05": {
        date: "2026-08-05",
        baseLP: 100,
        totalLP: 100,
        partners: { hanako: { contributed: false, narrative: "", effortLP: effort } },
      },
    },
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 96 } },
    },
  });
  const d1 = mk(29);
  performDailyReset(d1, "2026-08-05");
  assert.equal(d1.partnerConfig.hanako.variables.energy, 100);
  const d2 = mk(30);
  performDailyReset(d2, "2026-08-05");
  assert.equal(d2.partnerConfig.hanako.variables.energy, 99);
});

test("calcWorkConsumption: 每 30 光粒扣 1 精力，零工作量不扣", () => {
  assert.equal(calcWorkConsumption({ toolCalls: 0, charsOutput: 0, fileOps: 0, subagentDispatches: 0 }), 0);
  // 100 次工具调用 = 30 光粒 → 1 精力
  assert.equal(calcWorkConsumption({ toolCalls: 100, charsOutput: 0, fileOps: 0, subagentDispatches: 0 }), 1);
  // 15 次文件操作 = 30 光粒 → 1 精力
  assert.equal(calcWorkConsumption({ toolCalls: 0, charsOutput: 0, fileOps: 15, subagentDispatches: 0 }), 1);
});

test("syncWorkDeduction: 只扣新增差额，幂等不重复扣，消耗回落不补", () => {
  const data = {
    days: {},
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 96 } },
    },
  };
  // 第一次：消耗 17，扣 17
  assert.equal(syncWorkDeduction(data, "hanako", 17), true);
  assert.equal(data.partnerConfig.hanako.variables.energy, 83);
  const today = getToday(data);
  assert.equal(today.partners.hanako._workDeducted, 17);
  // 第二次同消耗：不再扣（幂等）
  assert.equal(syncWorkDeduction(data, "hanako", 17), false);
  assert.equal(data.partnerConfig.hanako.variables.energy, 83);
  // 消耗增长：只扣差额 3
  assert.equal(syncWorkDeduction(data, "hanako", 20), true);
  assert.equal(data.partnerConfig.hanako.variables.energy, 80);
  // 消耗回落：不扣不减
  assert.equal(syncWorkDeduction(data, "hanako", 15), false);
  assert.equal(data.partnerConfig.hanako.variables.energy, 80);
});

// ─── clampVariable：范围约束 ───

test("clampVariable: 越界值被收敛", () => {
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
