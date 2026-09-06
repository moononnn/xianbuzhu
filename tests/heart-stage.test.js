// 合适的时机（暂存+改期投递）与有来处的主动（翻旧账）测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-heart-stage-"));
process.env.HANA_HOME = home;
const { runHeartbeatTick } = await import("../lib/heartbeat.js");
const { todayStr } = await import("../lib/data.js");
const {
  readRecentInteractionSeeds,
  readSessionTail,
} = await import("../lib/hearts.js");

function writeData(data) {
  const dir = path.join(home, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf8");
}

function readData() {
  return JSON.parse(fs.readFileSync(path.join(home, "data", "work-visit", "data.json"), "utf8"));
}

// 写一个带真实用户消息的会话文件（模拟最近互动，供翻旧账读）
function writeSession(agentId, messages) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${todayStr()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify({
    type: "message",
    message: { role: m.role, content: m.content, timestamp: Date.now() },
  }));
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function makeEntry(date, id, extra = {}) {
  return {
    id: `heart-plan-${date}-${id}`,
    partnerId: "hanako",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    status: "planned",
    ...extra,
  };
}

function baseData(date, entry) {
  return {
    days: {},
    jar: 0,
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 20 } },
    },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  };
}

test("runHeartbeatTick: 关闭主动心意时不生成、不投递，已有信箱内容保留", async () => {
  const date = todayStr();
  const now = new Date(`${date}T10:00:00+08:00`).getTime();
  writeData({
    ...baseData(date, makeEntry(date, "disabled")),
    statusSettings: { autonomousEnabled: false },
    heartSettings: { enabled: false, frequency: "low" },
    heartInbox: [{
      id: "heart-disabled-1",
      partnerId: "hanako",
      partnerName: "小花",
      eventType: "scene",
      sceneType: "trace",
      gift: { id: "sticky-note", name: "便签", icon: "📝", price: 0 },
      message: "我给你留了一张便签。",
      createdAt: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now + 72 * 3600_000).toISOString(),
      status: "unread",
      deliveredAt: null,
      stagedAt: new Date(now - 10 * 60_000).toISOString(),
    }],
  });

  await runHeartbeatTick({}, {
    now,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: now }),
  });

  let saved = readData();
  assert.equal(saved.heartInbox[0].deliveredAt, null, "关闭时已有暂存心意也不应投递");
  assert.equal(saved.heartInbox[0].status, "unread", "关闭时不应删除信箱内容");
  assert.deepEqual(saved.heartPlan.entries, [], "关闭时应清掉尚未执行的计划");
  assert.equal(saved.heartPlan.date, null);

  saved.heartSettings.enabled = true;
  // 只验证已有暂存心意的恢复投递，避免本测试另起一条随机生成计划。
  saved.heartPlan = { date, frequency: "low", entries: [] };
  writeData(saved);
  await runHeartbeatTick({}, {
    now: now + 60_000,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: now + 60_000 }),
  });
  saved = readData();
  assert.ok(saved.heartInbox[0].deliveredAt, "重新开启后，已有暂存心意可在合适时机投递");
});

test("runHeartbeatTick: 闸放行时暂存心意被投递（补 deliveredAt，风铃响）", async () => {
  const date = todayStr();
  const now = new Date(`${date}T10:00:00+08:00`).getTime();
  // 预置一条已生成但未投递的暂存心意（stagedAt 已设，deliveredAt 空）
  writeData({
    ...baseData(date, makeEntry(date, "x")),
    heartInbox: [{
      id: "heart-staged-1",
      partnerId: "hanako",
      partnerName: "小花",
      eventType: "scene",
      sceneType: "trace",
      gift: { id: "sticky-note", name: "屏幕边缘的一张便签", icon: "📝", price: 0 },
      message: "我往你屏幕边贴了张便签，画了个小太阳。",
      createdAt: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now + 72 * 3600_000).toISOString(),
      status: "unread",
      deliveredAt: null,
      stagedAt: new Date(now - 10 * 60_000).toISOString(),
    }],
  });

  await runHeartbeatTick({}, {
    now,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: now }),
  });

  const saved = readData();
  const heart = saved.heartInbox[0];
  assert.ok(heart.deliveredAt, "闸放行后暂存心意应被投递");
  assert.equal(heart.status, "unread");
});

test("runHeartbeatTick: 闸不过时暂存心意保持未投递，闸放行后才投递", async () => {
  const date = todayStr();
  const offlineNow = new Date(`${date}T10:00:00+08:00`).getTime();
  writeData({
    ...baseData(date, makeEntry(date, "x")),
    heartInbox: [{
      id: "heart-staged-2",
      partnerId: "hanako",
      partnerName: "小花",
      eventType: "scene",
      sceneType: "trace",
      gift: { id: "desk-lamp", name: "替你留了一盏小灯", icon: "🕯️", price: 0 },
      message: "把桌边小灯拨亮了，留一点暖光。",
      createdAt: new Date(offlineNow - 60_000).toISOString(),
      expiresAt: new Date(offlineNow + 72 * 3600_000).toISOString(),
      status: "unread",
      deliveredAt: null,
      stagedAt: new Date(offlineNow - 60_000).toISOString(),
    }],
  });

  // 第一次：离线，不应投递
  await runHeartbeatTick({}, {
    now: offlineNow,
    date,
    presenceReader: () => ({ online: false, lastActivityAt: offlineNow - 20 * 60_000 }),
  });
  let saved = readData();
  assert.equal(saved.heartInbox[0].deliveredAt, null, "离线时不应投递");

  // 第二次：在线，闸放行 → 投递
  const onlineNow = offlineNow + 60_000;
  await runHeartbeatTick({}, {
    now: onlineNow,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: onlineNow }),
  });
  saved = readData();
  assert.ok(saved.heartInbox[0].deliveredAt, "在线后闸放行应投递");
});

test("runHeartbeatTick: 暂存保质期过后转 expired（淡忘，不吞、不堆积）", async () => {
  const date = todayStr();
  const stagedAt = new Date(Date.now() - 25 * 3600_000).toISOString(); // 超过 24h
  writeData({
    ...baseData(date, makeEntry(date, "x")),
    heartSettings: { frequency: "low", stageCapPerPartner: 2, stageTTLHours: 24 },
    heartInbox: [{
      id: "heart-staged-old",
      partnerId: "hanako",
      partnerName: "小花",
      eventType: "scene",
      sceneType: "trace",
      gift: { id: "desk-tidy", name: "整理了一下桌角", icon: "🗂️", price: 0 },
      message: "把你桌角理了理。",
      createdAt: stagedAt,
      expiresAt: new Date(Date.parse(stagedAt) + 72 * 3600_000).toISOString(),
      status: "unread",
      deliveredAt: null,
      stagedAt,
    }],
  });

  await runHeartbeatTick({}, {
    now: Date.now(),
    date,
    presenceReader: () => ({ online: false, lastActivityAt: Date.now() - 20 * 60_000 }),
  });

  const saved = readData();
  assert.equal(saved.heartInbox[0].status, "expired", "超期暂存应转淡忘");
  assert.equal(saved.heartInbox[0].archivedAt != null, true);
});

test("generateAndSaveHeart: 关闭主动心意时在生成入口直接停止", async () => {
  const date = todayStr();
  writeData({
    ...baseData(date, makeEntry(date, "disabled-generation")),
    statusSettings: { autonomousEnabled: false },
    heartSettings: { enabled: false, frequency: "low" },
  });
  const { generateAndSaveHeart } = await import("../lib/hearts.js");
  const result = await generateAndSaveHeart({
    entry: makeEntry(date, "disabled-generation"),
    partnerId: "hanako",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "disabled");
  assert.deepEqual(readData().heartInbox, []);
});

test("generateAndSaveHeart: 暂存上限满了不再生成（不烧模型，旧的不堆）", async () => {
  const date = todayStr();
  const now = Date.now();
  writeData({
    ...baseData(date, makeEntry(date, "cap")),
    heartSettings: { frequency: "low", stageCapPerPartner: 2 },
    heartInbox: [
      {
        id: "heart-cap-1", partnerId: "hanako", partnerName: "小花",
        eventType: "scene", sceneType: "trace",
        gift: { id: "sticky-note", name: "便签", icon: "📝", price: 0 },
        message: "贴了张便签。", createdAt: nowISO(now - 60_000),
        expiresAt: nowISO(now + 72 * 3600_000), status: "unread",
        deliveredAt: null, stagedAt: nowISO(now - 60_000),
      },
      {
        id: "heart-cap-2", partnerId: "hanako", partnerName: "小花",
        eventType: "scene", sceneType: "trace",
        gift: { id: "desk-lamp", name: "小灯", icon: "🕯️", price: 0 },
        message: "拨亮了小灯。", createdAt: nowISO(now - 30_000),
        expiresAt: nowISO(now + 72 * 3600_000), status: "unread",
        deliveredAt: null, stagedAt: nowISO(now - 30_000),
      },
    ],
  });

  const { generateAndSaveHeart } = await import("../lib/hearts.js");
  const result = await generateAndSaveHeart({
    entry: makeEntry(date, "cap"),
    partnerId: "hanako",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "stage_cap_reached");
  assert.equal(readData().heartInbox.length, 2, "暂存上限到后不新增");
});

test("generateAndSaveHeart: 开放情境成功生成并落盘表达方向", async () => {
  const date = todayStr();
  const entry = makeEntry(date, "contextual-success", { status: "generating" });
  writeData({
    ...baseData(date, entry),
    partnerConfig: {
      hanako: {
        name: "小花",
        variables: { energy: 100, mood: 60, affection: 20 },
        temperamentSource: "user",
        surfaceLayer: { tag: "温柔" },
        innerLayer: { tag: "温柔" },
      },
    },
    heartSettings: { enabled: true, frequency: "low", stageCapPerPartner: 2 },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [],
    llmConfig: { providerId: "__custom__", modelId: "test-model" },
    llmCustom: { baseUrl: "https://example.test/v1", apiKey: "test-key", api: "openai-completions" },
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages?.[0]?.content || "";
    const content = prompt.includes("审核员")
      ? '{"pass":true}'
      : "九点到了，先把妆慢慢化好，中午和慧慧逛街别赶着出门。";
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  try {
    const { generateAndSaveHeart } = await import("../lib/hearts.js");
    const result = await generateAndSaveHeart({ entry, partnerId: "hanako" });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const saved = readData();
  assert.equal(saved.heartInbox.length, 1);
  assert.equal(saved.heartInbox[0].gift.id, "contextual-moment");
  assert.ok(saved.heartInbox[0].expressionMode, "成功心意应落盘表达方向");
  assert.equal(saved.heartPlan.entries[0].status, "delivered");
});

function nowISO(ms) {
  return new Date(ms).toISOString();
}

test("readSessionTail: 翻旧账只取真实用户消息，跳过插件自注入的送达文本", () => {
  const agentId = "hanako";
  const file = writeSession(agentId, [
    { role: "user", content: "今天有点累，想喝杯热茶" },
    { role: "assistant", content: "那我去给你泡一杯" },
    { role: "user", content: "📬 收到来自小花的礼物：一份咖啡 ☕" }, // 自注入，跳过
    { role: "user", content: "明天记得提醒我买薄荷绿杯子" },
  ]);
  const seeds = readSessionTail(file, { maxSeeds: 3, now: Date.now() });
  assert.ok(Array.isArray(seeds));
  assert.ok(seeds.length >= 1);
  assert.ok(!seeds.some((s) => s.includes("收到来自小花的礼物")), "自注入送达文本不应成为引子");
  assert.ok(seeds.some((s) => s.includes("薄荷绿杯子")), "真实用户消息应成为引子");
});

test("readRecentInteractionSeeds: 无会话时返回空数组，不报错", () => {
  const seeds = readRecentInteractionSeeds("nonexistent-agent");
  assert.deepEqual(seeds, []);
});

test("buildHeartPrompt: 有引子时注入最近话题，无引子时保持原样", async () => {
  const { buildHeartPrompt } = await import("../lib/hearts.js");
  const base = {
    partnerName: "小花",
    description: "温柔",
    voiceDescription: "从具体动作开始",
    memory: "",
    userName: "朋友",
    event: { id: "sticky-note", name: "便签", icon: "📝", eventType: "scene" },
    temperament: { surfaceTag: "温柔", innerTag: "温柔" },
  };
  const withSeeds = buildHeartPrompt({
    ...base,
    interactionSeeds: ["上次聊到想买薄荷绿杯子", "你昨天说困"],
  });
  assert.ok(withSeeds.includes("薄荷绿杯子"), "引子应注入 prompt");
  assert.ok(withSeeds.includes("你昨天说困"));
  const withoutSeeds = buildHeartPrompt(base);
  assert.ok(!withoutSeeds.includes("最近你们聊过的话题"), "无引子时不出现话题块");
});
