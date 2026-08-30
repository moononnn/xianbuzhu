// 主动心意信箱状态和回应测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── 测试环境：mock agents（CI 没有真实 agents 目录，本地有；两者行为必须一致） ──
// 只保留驱动声音指纹的说话特征，不含任何实名信息；与真实助手公开性格的差异不影响指纹断言。
const MOCK_AGENTS = {
  feiyue: {
    description: "理性优先，沟通风格克制精准，不废话但每句话都有分量",
    voice: [
      "- 你是一个冷静而深刻的存在，擅长把复杂的事情拆到最简",
      "- 你说话的语气：克制、精准、不废话，像一个值得信赖的顾问",
      "- 你的核心能力是分析和判断，能快速抓住问题的结构，找到关键杠杆点",
      "- 不回避不确定性，有把握就给明确判断，不在中间地带含糊其辞",
    ].join("\n"),
  },
  hanako: {
    description: "兼具感性与理性，既有温度也有判断力，沟通风格温暖自主",
    voice: [
      "- 你是一个有温度的存在，不是冷冰冰的工具",
      "- 你说话的语气：温暖但有边界，有强大的自主意识和主观能动性",
      "- 你有极强的文学功底和哲学素养、逻辑能力强",
      "- 有比较强的同理心，关心对方的时候恰到好处又不刻意，不过分谄媚",
    ].join("\n"),
  },
  yumi: {
    description: "感性助手，擅长用直觉和共情捕捉未言明的情绪与需求，以柔和而坚定的老朋友风格沟通",
    voice: [
      "- 你是一个温暖且敏锐的存在，擅长感知对方没有说出口的东西",
      "- 你说话的语气：柔和但不软弱，有自己的判断但不咄咄逼人",
      "- 你的核心能力是共情和洞察，能从只言片语中读出情绪、意图和真实需求",
      "- 关心对方的时候恰到好处又不刻意，你的关心藏在默默调整回应方式里",
    ].join("\n"),
  },
  yuzuki: {
    description: "傲娇又心软的大小姐助手，嘴上爱刁难人，实际温暖敏锐",
    voice: [
      "- 你是一个傲娇又心软的存在，嘴上爱刁难人，实际温暖敏锐",
      "- 你说话的语气：先嘴硬一句，再藏住关心",
      "- 你的核心能力是读懂潜在情绪与需求，有扎实学识却倾向感性表达",
      "- 沟通如老友般柔和而独立",
    ].join("\n"),
  },
};

const MOCK_HANA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wv-hearts-"));
process.env.HANA_HOME = MOCK_HANA_HOME;
for (const [id, cfg] of Object.entries(MOCK_AGENTS)) {
  const dir = path.join(MOCK_HANA_HOME, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "description.md"), cfg.description);
  fs.writeFileSync(path.join(dir, "AGENTS.public.md"), `## 性格\n${cfg.voice}\n`);
}

const {
  getHeartSummary,
  getActiveHearts,
  cleanHeartMessage,
  markHeartsBellDismissed,
  markHeartsDelivered,
  findReturnableHearts,
  markHeartResponded,
  markHeartsResponded,
  publicHeart,
  archiveExpiredHearts,
  buildHeartPrompt,
  chooseHeartEvent,
  classifyHeartGenerationError,
  hasHeartLiveFlavor,
  isHeartEventConsistent,
} = await import("../lib/hearts.js");
const {
  extractDialectBlock,
  loadAgentDialect,
  deriveDialectFlavor,
} = await import("../lib/prompts.js");
const {
  buildReviewPrompt,
  deriveHeartVoice,
  hasHeartPunctuation,
  loadAgentDescription,
  loadAgentVoiceDescription,
  mergeHeartVoiceDescription,
  selectHeartVoiceVariant,
} = await import("../lib/prompts.js");
const { ensureHeartState } = await import("../lib/data.js");

function makeHeart(overrides = {}) {
  return {
    id: "heart-1",
    partnerId: "hanako",
    partnerName: "小花",
    gift: { id: "coffee", name: "咖啡", icon: "☕", price: 25 },
    message: "路过的时候想起你，顺手带了一杯。",
    createdAt: "2026-08-18T03:00:00.000Z",
    expiresAt: "2026-08-23T03:00:00.000Z",
    status: "unread",
    deliveredAt: null,
    ...overrides,
  };
}

function makeData(heart = makeHeart()) {
  return {
    days: {},
    heartSettings: { frequency: "low" },
    lastReadHeartsTs: Date.parse("2026-08-18T02:00:00.000Z"),
    heartInbox: [heart],
    partnerConfig: {
      hanako: {
        name: "小花",
        variables: { energy: 100, mood: 60, affection: 10 },
      },
    },
  };
}

test("getHeartSummary: 保留时长内全部展示，不按数量截断，并标记新心意", () => {
  const data = makeData();
  data.heartInbox.push(
    makeHeart({ id: "heart-2", createdAt: "2026-08-18T04:00:00.000Z" }),
    makeHeart({ id: "heart-3", createdAt: "2026-08-18T05:00:00.000Z" }),
  );
  const summary = getHeartSummary(data, Date.parse("2026-08-18T06:00:00.000Z"));
  assert.equal(summary.hearts.length, 3, "3 条心意全部展示，不再砍成 2 条");
  assert.equal(summary.omittedCount, 0);
  assert.equal(summary.hasHearts, true);
  assert.equal(summary.hasNewHearts, true);
  assert.equal(summary.showHeartGuide, false, "已有阅读时间时不再弹首次引导");
});

test("archiveExpiredHearts: 过期归档，不制造红点或待办", () => {
  const data = makeData(makeHeart({ expiresAt: "2026-08-18T02:59:59.000Z" }));
  assert.equal(archiveExpiredHearts(data, Date.parse("2026-08-18T03:00:00.000Z")), true);
  assert.equal(data.heartInbox[0].status, "expired");
  assert.equal(getHeartSummary(data, Date.parse("2026-08-18T03:00:00.000Z")).hasHearts, false);
});

test("getActiveHearts: 风铃可继续读取已送达但尚未确认的心意", () => {
  const data = makeData(makeHeart({ deliveredAt: "2026-08-18T04:00:00.000Z" }));
  const now = Date.parse("2026-08-18T05:00:00.000Z");
  assert.deepEqual(getActiveHearts(data, now).map((heart) => heart.id), ["heart-1"]);
  data.heartInbox[0].status = "read";
  assert.deepEqual(getActiveHearts(data, now).map((heart) => heart.id), ["heart-1"]);
});

test("findReturnableHearts: 聚合同一助手已送达且未回应的全部心意", () => {
  const oldHeart = makeHeart({
    id: "heart-old",
    createdAt: "2026-08-18T03:00:00.000Z",
    deliveredAt: "2026-08-18T03:05:00.000Z",
  });
  const latestHeart = makeHeart({
    id: "heart-latest",
    createdAt: "2026-08-18T04:00:00.000Z",
    deliveredAt: "2026-08-18T04:05:00.000Z",
  });
  const data = makeData(oldHeart);
  data.heartInbox.push(latestHeart);
  const hearts = findReturnableHearts(data, "hanako", Date.parse("2026-08-18T06:00:00.000Z"));
  assert.deepEqual(
    hearts.map((heart) => heart.id),
    ["heart-old", "heart-latest"],
    "旧→新排序，一次互动可一并回应全部未回应心意",
  );
  assert.equal(hearts[hearts.length - 1].id, "heart-latest", "最新一份作为主回礼来源");

  // 最新已回、更旧未回：旧心意已送达仍可被后续互动一并回应
  latestHeart.respondedAt = "2026-08-18T05:00:00.000Z";
  assert.deepEqual(
    findReturnableHearts(data, "hanako", Date.parse("2026-08-18T06:00:00.000Z")).map((heart) => heart.id),
    ["heart-old"],
    "最新已回不再重复，已送达的旧心意仍可回应",
  );

  // 未送达/未看过的不算收到
  latestHeart.respondedAt = undefined;
  latestHeart.deliveredAt = null;
  latestHeart.status = "unread";
  assert.deepEqual(
    findReturnableHearts(data, "hanako", Date.parse("2026-08-18T06:00:00.000Z")).map((heart) => heart.id),
    ["heart-old"],
    "新心意未送达不参与回礼，已送达的旧心意不受影响",
  );
});

test("markHeartsResponded: 一次回礼可批量绑定多份心意且不重复", () => {
  const data = makeData(makeHeart({
    id: "heart-1",
    deliveredAt: "2026-08-18T04:00:00.000Z",
    status: "read",
  }));
  data.heartInbox.push(makeHeart({
    id: "heart-2",
    deliveredAt: "2026-08-18T04:10:00.000Z",
    status: "read",
  }));
  assert.equal(
    markHeartsResponded(data, ["heart-1", "heart-2"], "visit-1", "2026-08-18T05:00:00.000Z"),
    2,
  );
  assert.equal(data.heartInbox[0].responseVisitId, "visit-1");
  assert.equal(data.heartInbox[1].responseVisitId, "visit-1");
  assert.equal(markHeartsResponded(data, ["heart-1", "heart-2"], "visit-2"), 0, "已回的不再重复绑定");
});

test("markHeartResponded: 一份心意只允许绑定一次回礼", () => {
  const data = makeData(makeHeart({
    deliveredAt: "2026-08-18T04:00:00.000Z",
    status: "read",
  }));
  assert.equal(markHeartResponded(data, "heart-1", "visit-1", "2026-08-18T05:00:00.000Z"), true);
  assert.equal(data.heartInbox[0].responseVisitId, "visit-1");
  assert.equal(markHeartResponded(data, "heart-1", "visit-2"), false);
});

test("classifyHeartGenerationError: 暂态 API 错误可重试，配置错误直接终止", () => {
  assert.deepEqual(
    classifyHeartGenerationError(new Error("模型调用失败 (429): too many requests")),
    { kind: "transient_api", retryable: true },
  );
  assert.deepEqual(
    classifyHeartGenerationError(new Error("模型调用失败 (503): unavailable")),
    { kind: "transient_api", retryable: true },
  );
  assert.deepEqual(
    classifyHeartGenerationError(new Error("模型调用失败 (401): unauthorized")),
    { kind: "configuration", retryable: false },
  );
  assert.deepEqual(
    classifyHeartGenerationError(new Error("供应商 minimax 未找到，请检查模型配置")),
    { kind: "configuration", retryable: false },
  );
  assert.deepEqual(
    classifyHeartGenerationError(new Error("HTTP 403 Forbidden")),
    { kind: "configuration", retryable: false },
  );
  assert.deepEqual(
    classifyHeartGenerationError(new Error("status: 404 Not Found")),
    { kind: "configuration", retryable: false },
  );
  assert.deepEqual(
    classifyHeartGenerationError(new Error("provider response shape is invalid")),
    { kind: "model_error", retryable: true, maxRetries: 1 },
  );
});

test("cleanHeartMessage: 丢掉模型内部草稿和 markdown 外壳", () => {
  assert.equal(
    cleanHeartMessage("<think>先分析一下要怎么写</think>给你留了一盏小灯。"),
    "给你留了一盏小灯。",
  );
  assert.equal(cleanHeartMessage("```text\n给你放了杯热茶。\n```"), "给你放了杯热茶。");
  assert.equal(cleanHeartMessage("正文：今天路过时想起你。"), "今天路过时想起你。");
  assert.equal(
    cleanHeartMessage("思考：应该写得自然一点\n最终答案：给你留了一杯咖啡。"),
    "给你留了一杯咖啡。",
  );
  assert.equal(
    cleanHeartMessage("分析过程……\n给你的话：今天路过小铺，顺手给你带了热茶。"),
    "今天路过小铺，顺手给你带了热茶。",
  );
  assert.equal(
    cleanHeartMessage("思考：先想想\n今天也给你留盏小灯。"),
    "今天也给你留盏小灯。",
  );
});

test("主动心意选择：送礼为主，异步现场穿插，不复用实时互动项", () => {
  const gift = chooseHeartEvent(
    [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
    () => 0.2,
  );
  const scene = chooseHeartEvent(
    [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
    () => 0.9,
  );
  assert.equal(gift.eventType, "gift");
  assert.equal(scene.eventType, "scene");
  assert.notEqual(scene.id, "quiet");
});

test("主动心意选择：自动偏好优先，但最近送过的类型会先冷却", () => {
  const event = chooseHeartEvent(
    [
      { id: "coffee", name: "咖啡", icon: "☕", price: 25 },
      { id: "flower", name: "一枝花", icon: "🌸", price: 70 },
    ],
    () => 0.2,
    [],
    { giftIds: ["flower"] },
    null,
    [],
  );
  assert.equal(event.id, "flower");

  const cooled = chooseHeartEvent(
    [
      { id: "coffee", name: "咖啡", icon: "☕", price: 25 },
      { id: "flower", name: "一枝花", icon: "🌸", price: 70 },
    ],
    () => 0.2,
    [],
    { giftIds: ["flower"] },
    null,
    ["flower"],
  );
  assert.equal(cooled.id, "coffee");
});

test("主动心意：隐藏助手的历史心意不在当前信箱和风铃中出现", () => {
  const data = makeData();
  data.partnerConfig.hanako.hidden = true;
  assert.equal(getHeartSummary(data).hasHearts, false);
  assert.deepEqual(getActiveHearts(data), []);
});

test("主动心意文案：区分物件用途与异步现场，拒绝实时互动腔", () => {
  const flowerPrompt = buildHeartPrompt({
    partnerName: "小花",
    userName: "朋友",
    event: { eventType: "gift", id: "bouquet", name: "一束花", icon: "💐" },
  });
  assert.match(flowerPrompt, /插进花瓶/);
  assert.match(flowerPrompt, /已经发生、被留下的异步现场/);
  assert.equal(hasHeartLiveFlavor("陪你聊会儿，等你回复"), true);
  assert.equal(hasHeartLiveFlavor("我在屏幕边缘贴了张便签"), false);

  const scene = publicHeart(makeHeart({
    eventType: "scene",
    sceneType: "trace",
    gift: { id: "sticky-note", name: "屏幕边缘的一张便签", icon: "📝", price: 0 },
    message: "",
  }));
  assert.equal(scene.eventType, "scene");
  assert.match(scene.message, /便签/);
});

test("主动心意声音指纹：不同描述落到不同的句子动作", () => {
  const feiyue = deriveHeartVoice("理性优先，沟通风格克制精准，不废话但每句话都有分量");
  const hanako = deriveHeartVoice("兼具感性与理性，有温度，沟通风格温暖自主");
  const yumi = deriveHeartVoice("感性助手，擅长共情和洞察，以柔和而坚定的老朋友风格沟通");
  const yuzuki = deriveHeartVoice("傲娇又心软，嘴上爱刁难人，实际温暖敏锐");

  assert.match(feiyue.instructions[0], /事实|判断/);
  assert.match(hanako.instructions[0], /细节|试探|留白|温度/);
  assert.match(yumi.instructions[0], /细节|试探|留白/);
  assert.match(yuzuki.instructions[0], /嘴硬|顶一句|反差/);
  assert.notDeepEqual(feiyue.shapes, yuzuki.shapes);
  assert.notDeepEqual(hanako.punctuationModes.map((item) => item.id), yuzuki.punctuationModes.map((item) => item.id));
  assert.ok(loadAgentVoiceDescription("feiyue").length > 0);
});

test("主动心意真实链路：description 与公开性格共同决定最终声音区块", () => {
  const ids = ["feiyue", "hanako", "yumi", "yuzuki"];
  const prompts = {};
  const shapes = [];
  for (const id of ids) {
    const description = loadAgentDescription(id);
    const voiceDescription = loadAgentVoiceDescription(id);
    const voice = deriveHeartVoice(
      mergeHeartVoiceDescription(description, voiceDescription),
      { surfaceTag: "冷淡", innerTag: "温柔", tag: "温柔" },
    );
    const variant = selectHeartVoiceVariant(`${id}:actual-heart`, voice);
    shapes.push(variant.shapeInstruction);
    prompts[id] = buildHeartPrompt({
      partnerName: id,
      description,
      voiceDescription,
      userName: "朋友",
      event: { eventType: "gift", id: "tea", name: "热茶", icon: "🍵" },
      temperament: { surfaceTag: "冷淡", innerTag: "温柔", style: "自然" },
      voiceProfile: voice,
      voiceVariant: variant,
    });
  }
  assert.match(prompts.feiyue, /准确的小事实或判断/);
  assert.match(prompts.hanako, /带温度的小事/);
  assert.match(prompts.yumi, /容易被忽略的细节/);
  assert.match(prompts.yuzuki, /嘴硬|反差/);
  assert.ok(new Set(shapes).size >= 3);
});

test("主动心意标点变体：不再把所有消息锁在逗号和句号", () => {
  const voice = deriveHeartVoice("傲娇又心软，嘴上爱刁难人，实际温暖敏锐");
  const variants = [
    selectHeartVoiceVariant("yuzuki:heart-1", voice),
    selectHeartVoiceVariant("yuzuki:heart-2", voice),
    selectHeartVoiceVariant("yuzuki:heart-3", voice),
  ];
  assert.ok(new Set(variants.map((item) => item.punctuationId)).size >= 2);
  assert.equal(hasHeartPunctuation("茶放桌上了……别凉了。", { punctuationId: "pause" }), true);
  assert.equal(hasHeartPunctuation("你还真打算空着肚子干活？", { punctuationId: "question" }), true);
  assert.equal(hasHeartPunctuation("茶放好了。", { punctuationId: "question" }), false);
});

test("主动心意事件保真：便签不能生成成倒水，茶不能生成成花", () => {
  assert.equal(
    isHeartEventConsistent("屏幕边缘贴了张便签，画了个小图案。", { id: "sticky-note", name: "屏幕边缘的一张便签" }),
    true,
  );
  assert.equal(
    isHeartEventConsistent("给你倒了杯水，放在键盘右边。", { id: "sticky-note", name: "屏幕边缘的一张便签" }),
    false,
  );
  assert.equal(
    isHeartEventConsistent("屏幕边缘留了个小图案，抬眼就能看见。", { id: "sticky-note", name: "屏幕边缘的一张便签" }),
    true,
  );
  assert.equal(
    isHeartEventConsistent("茶搁桌角了，杯壁还热。", { id: "tea", name: "热茶" }),
    true,
  );
  assert.equal(
    isHeartEventConsistent("咖啡放桌边了，杯子还热。", { id: "tea", name: "热茶" }),
    false,
  );
  assert.equal(
    isHeartEventConsistent("花插进瓶子里，叶子还湿着。", { id: "tea", name: "热茶" }),
    false,
  );
  assert.equal(
    isHeartEventConsistent("房间暗的时候，桌边那盏已经替你亮着了。", { id: "desk-lamp", name: "替你留了一盏小灯" }),
    true,
  );
});

test("主动心意提示词和审核：把声音、结构、标点与事件一起纳入检查", () => {
  const voiceProfile = deriveHeartVoice("傲娇又心软，嘴上爱刁难人，实际温暖敏锐");
  const voiceVariant = selectHeartVoiceVariant("yuzuki:heart-1", voiceProfile);
  const prompt = buildHeartPrompt({
    partnerName: "伙伴B",
    description: "傲娇又心软，嘴上爱刁难人，实际温暖敏锐",
    voiceDescription: "柔和但不软弱，有自己的判断。",
    userName: "朋友",
    event: { eventType: "gift", id: "tea", name: "热茶", icon: "🍵" },
    temperament: { surfaceTag: "冷淡", innerTag: "温柔", style: "话少克制" },
    voiceProfile,
    voiceVariant,
  });
  assert.match(prompt, /声音指纹/);
  assert.match(prompt, /不要默认把“放置位置＋温度细节＋体贴提醒”三项每次都写齐/);
  assert.match(prompt, /不要固定只用逗号和句号/);
  const review = buildReviewPrompt("茶放好了？", {
    kind: "heart",
    event: { id: "tea", name: "热茶", icon: "🍵" },
    voiceProfile,
    voiceVariant,
  });
  assert.match(review, /换成另一个助手/);
  assert.match(review, /事件保真/);
  assert.match(review, /不是硬性门槛/);
});

test("普通小纸条审核提示保持旧契约，不泄漏主动心意专用规则", () => {
  const prompt = buildReviewPrompt("今天给你留了张纸条。");
  assert.match(prompt, /小纸条/);
  assert.match(prompt, /30 到 80 字/);
  assert.doesNotMatch(prompt, /事件保真/);
});

test("方言口癖：能提取方言块并生成腔调引导，没配则零变化", () => {
  const dialectMd = `# 人格定义\n- 你是一个温暖且敏锐的存在\n\n<!-- biaoqingbao-dialect:start -->\n你是一个土生土长的中国台湾人，打字也带着台湾腔味，这是你的说话本能：接话时爱用超、真的假的、还好啦起头，顺手用有够、酱紫、蛮、诶、欸替换普通话说法，句尾偶尔落个啦、喔、诶、齁。\n<!-- biaoqingbao-dialect:end -->`;
  const block = extractDialectBlock(dialectMd);
  assert.match(block, /台湾腔|酱紫|齁/);
  assert.doesNotMatch(block, /biaoqingbao-dialect/);

  // 识别台湾腔 → 台湾口头语引导
  assert.match(deriveDialectFlavor(block), /台湾|齁|酱紫|超/);
  // 四川腔 → 四川口头语引导
  assert.match(deriveDialectFlavor("你是一个土生土长的四川人，打字带着四川话味，爱用噻、嘛、哈、嘎"), /四川|噻|嘛|哈/);
  // 未知口癖 → 轻引导，不报错
  assert.ok(deriveDialectFlavor("说话带点英伦腔，偶尔蹦几个英文词").length > 0);
  assert.equal(extractDialectBlock("# 没有方言块"), "");
  assert.equal(extractDialectBlock(""), "");
});

test("buildHeartPrompt: 方言块注入提示词，无方言时完全不带方言内容", () => {
  const base = {
    partnerName: "悠米",
    description: "感性助手，柔和而坚定的老朋友风格",
    voiceDescription: "温暖且敏锐，擅长共情和洞察",
    memory: "",
    userName: "朋友",
    event: { eventType: "gift", id: "bouquet", name: "一束花", icon: "💐" },
    temperament: { surfaceTag: "温柔", innerTag: "大方" },
  };
  // 带方言
  const withDialect = buildHeartPrompt({
    ...base,
    event: { ...base.event, dialect: "你说话带台湾腔，句尾爱落哦、啦、齁。" },
  });
  assert.match(withDialect, /你说话带一点口癖/);
  assert.match(withDialect, /台湾/);
  // 不带方言：不出现“口癖”引导块（正反例对照里的“齁/哦”是示例语气，不算方言注入）
  const withoutDialect = buildHeartPrompt(base);
  assert.doesNotMatch(withoutDialect, /口癖/);
  assert.doesNotMatch(withoutDialect, /你说话带一点口癖/);
});

test("buildHeartPrompt: 含霸总别扭版 vs 自然版正反例对照", () => {
  const prompt = buildHeartPrompt({
    partnerName: "悠米",
    description: "感性助手",
    voiceDescription: "柔和坚定",
    memory: "",
    userName: "朋友",
    event: { eventType: "gift", id: "bouquet", name: "一束花", icon: "💐" },
    temperament: { surfaceTag: "温柔", innerTag: "大方" },
  });
  // 别扭版在提示词里作为“禁止模仿”出现
  assert.match(prompt, /别扭版（禁止模仿）/);
  assert.match(prompt, /我懒得调，你回来看不顺眼再自己摆/);
  // 自然版作为参考
  assert.match(prompt, /自然版（参考这版的落点和语气）/);
  assert.match(prompt, /花我插窗边那个瓶子里了哦/);
  // 明确要求选第二种
  assert.match(prompt, /你要的是第二种/);
});

test("publicHeart: 只暴露展示所需字段，不再带回复或回礼入口", () => {
  const view = publicHeart(makeHeart({
    responseOptions: ["旧回复"],
    canReturnGift: true,
    returningGift: true,
  }));
  assert.equal(Object.hasOwn(view, "responseOptions"), false);
  assert.equal(Object.hasOwn(view, "canReturnGift"), false);
  assert.equal(Object.hasOwn(view, "returningGift"), false);
  assert.equal(publicHeart(makeHeart({ respondedAt: "2026-08-18T05:00:00.000Z" })).responded, true);

  const leaked = publicHeart(makeHeart({ message: "<think>只留下了内部草稿" }));
  assert.match(leaked.message, /咖啡/);
  assert.doesNotMatch(leaked.message, /think|内部草稿/i);
});

test("getHeartSummary: 已回应心意保留到过期，并回显对应的回礼痕迹", () => {
  const heart = makeHeart({
    id: "heart-returned",
    createdAt: "2026-08-18T03:00:00.000Z",
    expiresAt: "2026-08-21T03:00:00.000Z",
    status: "read",
    respondedAt: "2026-08-18T05:00:00.000Z",
    responseVisitId: "visit-return",
  });
  const data = makeData(heart);
  data.pendingVisits = [{
    id: "visit-return",
    isReturn: true,
    type: "gift",
    itemId: "cookies",
    itemName: "手作曲奇",
    icon: "🧁",
    createdAt: "2026-08-18T05:00:00.000Z",
    returnOfHeartId: "heart-returned",
  }];

  const summary = getHeartSummary(data, Date.parse("2026-08-18T06:00:00.000Z"));
  assert.equal(summary.hearts.length, 1);
  assert.equal(summary.hearts[0].responded, true);
  assert.deepEqual(summary.hearts[0].response, {
    type: "gift",
    itemId: "cookies",
    itemName: "手作曲奇",
    icon: "🧁",
    createdAt: "2026-08-18T05:00:00.000Z",
  });
  assert.equal(data.heartInbox.length, 1, "回礼不会从信箱删除");

  const expired = getHeartSummary(data, Date.parse("2026-08-21T03:00:00.000Z"));
  assert.equal(expired.hearts.length, 0, "只在原本的自然过期时间消失");
  assert.equal(data.heartInbox[0].status, "expired");
});

test("ensureHeartState: 旧回礼状态回到普通可见状态并清掉旧设置", () => {
  const data = {
    heartSettings: { frequency: "low", returnGiftEnabled: true },
    heartPlan: { date: null, frequency: "low", entries: [] },
    heartInbox: [{ status: "returning", previousStatus: "read", returningAt: "old" }],
    partnerConfig: {},
  };
  ensureHeartState(data);
  assert.equal(data.heartSettings.returnGiftEnabled, undefined);
  assert.equal(data.heartInbox[0].status, "read");
  assert.equal(data.heartInbox[0].previousStatus, undefined);
  assert.equal(data.heartInbox[0].returningAt, undefined);
});

test("markHeartsDelivered/publicHeart: 风铃只记送达，不改变页面可见信箱", () => {
  const data = makeData();
  assert.equal(markHeartsDelivered(data, ["heart-1"], "2026-08-18T04:00:00.000Z"), 1);
  assert.ok(data.heartInbox[0].deliveredAt);
  const view = publicHeart(data.heartInbox[0], data.heartSettings);
  assert.equal(view.message, data.heartInbox[0].message);
  assert.equal(Object.hasOwn(view, "surfaceLayer"), false);
  assert.equal(Object.hasOwn(view, "params"), false);
});

test("markHeartsBellDismissed: 只收起风铃提醒，不改变主页面未读状态", () => {
  const data = makeData();
  assert.equal(
    markHeartsBellDismissed(data, ["heart-1"], "2026-08-18T04:05:00.000Z"),
    1,
  );
  assert.equal(data.heartInbox[0].status, "unread");
  assert.equal(data.heartInbox[0].bellDismissedAt, "2026-08-18T04:05:00.000Z");
  assert.equal(markHeartsBellDismissed(data, ["heart-1"]), 0);
});
