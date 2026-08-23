// 闲不住 — 核心动作（performVisit）测试
// 覆盖：参数校验 / 光粒扣减 / 模型配置检查 / 关机键与说怪话的豁免与推送
// 说明：process.env.HANA_HOME 指向临时目录，不碰真实数据。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-actions-"));
process.env.HANA_HOME = tmp;

const {
  performVisit,
  applyReturnContext,
  buildVisitPushText,
  buildBrainrotPushText,
} = await import("../lib/actions.js");

function writeData(overrides) {
  const data = {
    jar: 100,
    llmConfig: { providerId: "test", modelId: "test" },
    partnerConfig: {
      hanako: { name: "小花", variables: { mood: 60, affection: 10 } },
    },
    pendingVisits: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
    interactItems: [{ id: "quiet", name: "安安静静在旁边陪着", icon: "🍵" }],
    prankItems: [
      { id: "unplug", name: "悄咪咪按下关机键", icon: "🔌" },
      { id: "brainrot", name: "冷不丁说句怪话", icon: "🧠" },
    ],
    ...overrides,
  };
  const dir = path.join(tmp, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data.json"),
    JSON.stringify(data),
    "utf-8",
  );
  return data;
}

function readData() {
  return JSON.parse(
    fs.readFileSync(path.join(tmp, "data", "work-visit", "data.json"), "utf-8"),
  );
}

function writeSession() {
  const dir = path.join(tmp, "agents", "hanako", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "return-test.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        timestamp: "2026-08-19T10:56:00+08:00",
        content: [{ type: "text", text: "测试会话" }],
      },
    }) + "\n",
    "utf8",
  );
  return file;
}

function makeBus() {
  const bus = { calls: [] };
  bus.request = async (topic, payload) => {
    bus.calls.push({ topic, payload });
    return true;
  };
  return bus;
}

function makeReturnHeart(overrides = {}) {
  const now = Date.now();
  return {
    id: "heart-1",
    partnerId: "hanako",
    eventType: "gift",
    gift: { id: "bouquet", name: "一束花", icon: "💐", price: 120 },
    status: "read",
    deliveredAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 24 * 3600_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(),
    ...overrides,
  };
}

test("回礼推送文案：互动/礼物/恶作剧都带回礼来源，普通动作不带", () => {
  const visit = { type: "interact", itemId: "doodle" };
  applyReturnContext(visit, makeReturnHeart());
  const item = { id: "doodle", name: "往ta桌上放了张手绘小卡片", icon: "🎨" };
  const returnText = buildVisitPushText("interact", item, "玥儿", visit, () => 0);
  assert.match(returnText, /回礼/);
  assert.match(returnText, /💐一束花/);

  const giftText = buildVisitPushText(
    "gift",
    { id: "coffee", name: "咖啡", icon: "☕" },
    "玥儿",
    visit,
    () => 0,
  );
  assert.match(giftText, /回礼/);
  assert.match(giftText, /☕咖啡/);

  const prankText = buildBrainrotPushText(
    "突然想到：一只会写代码的猫，最喜欢哪种语言？喵语。",
    { id: "brainrot", name: "冷不丁说句怪话", icon: "🧠" },
    "玥儿",
    visit,
  );
  assert.match(prankText, /回礼恶作剧/);
  assert.match(prankText, /喵语/);

  const normalText = buildVisitPushText(
    "interact",
    item,
    "玥儿",
    {},
    () => 0,
  );
  assert.doesNotMatch(normalText, /回礼/);
});

test("performVisit: 命中最新主动心意时写入回礼关联并消费一次", async () => {
  writeData({ heartInbox: [makeReturnHeart()] });
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.isReturn, true);
  const saved = readData();
  assert.equal(saved.pendingVisits[0].isReturn, true);
  assert.equal(saved.pendingVisits[0].returnOfHeartId, "heart-1");
  assert.equal(saved.heartInbox[0].responseVisitId, saved.pendingVisits[0].id);
  assert.equal(saved.heartInbox[0].respondedAt != null, true);
});

test("performVisit: 一次互动聚合回礼全部未回应心意并写入关联", async () => {
  const now = Date.now();
  writeData({
    heartInbox: [
      makeReturnHeart({ id: "heart-old", createdAt: new Date(now - 3600_000).toISOString() }),
      makeReturnHeart({ id: "heart-new", createdAt: new Date(now - 60_000).toISOString() }),
    ],
  });
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.isReturn, true);
  assert.equal(r.body.returnOfHeartCount, 2);
  const saved = readData();
  const visit = saved.pendingVisits[0];
  assert.equal(visit.isReturn, true);
  assert.deepEqual(visit.returnOfHeartIds, ["heart-old", "heart-new"]);
  assert.equal(visit.returnOfHeartId, "heart-new", "最新一份作为主回礼来源");
  assert.equal(
    saved.heartInbox.every((heart) => heart.responseVisitId === visit.id),
    true,
    "全部未回应心意一次性绑定同一次回礼",
  );
});

test("performVisit: 多条心意回礼推送文案告知攒着的份数", () => {
  const visit = { type: "interact", itemId: "doodle" };
  applyReturnContext(visit, [
    makeReturnHeart({ id: "heart-old", gift: { id: "coffee", name: "咖啡", icon: "☕", price: 25 } }),
    makeReturnHeart({ id: "heart-new" }),
  ]);
  const text = buildVisitPushText(
    "interact",
    { id: "doodle", name: "往ta桌上放了张手绘小卡片", icon: "🎨" },
    "玥儿",
    visit,
    () => 0,
  );
  assert.match(text, /回礼/);
  assert.match(text, /2 份心意/);
  assert.match(text, /攒下/);
});

test("performVisit: 手动指定 sessionPath 时不会回退到该助手的最新对话", async () => {
  const fixedPath = writeSession();
  const bus = makeBus();
  writeData();
  const result = await performVisit(
    { type: "interact", itemId: "quiet", to: "hanako", sessionPath: fixedPath },
    { bus },
  );
  assert.equal(result.status, 200);
  assert.equal(bus.calls[0].payload.sessionPath, fixedPath);
});

test("performVisit: 实际 session 推送包含回礼语义，怪话回礼也保留原文", async () => {
  writeSession();
  try {
    writeData({ heartInbox: [makeReturnHeart()] });
    const interactBus = makeBus();
    await performVisit(
      { type: "interact", itemId: "quiet", to: "hanako" },
      { bus: interactBus },
    );
    assert.match(interactBus.calls[0].payload.text, /回礼/);
    assert.match(interactBus.calls[0].payload.text, /一束花/);

    writeData({ llmConfig: {}, heartInbox: [makeReturnHeart({ id: "heart-2" })] });
    const prankBus = makeBus();
    await performVisit(
      { type: "prank", itemId: "brainrot", to: "hanako" },
      { bus: prankBus },
    );
    assert.match(prankBus.calls[0].payload.text, /回礼恶作剧/);
    assert.match(prankBus.calls[0].payload.text, /你今天看起来有点奇怪|突然想到/);
  } finally {
    fs.rmSync(path.join(tmp, "agents"), { recursive: true, force: true });
  }
});

// ── 参数校验 ──
test("performVisit: 回礼关机键保留重启演出并把来源写入 pending visit", async () => {
  writeSession();
  try {
    writeData({ llmConfig: {}, heartInbox: [makeReturnHeart()] });
    const bus = makeBus();
    const r = await performVisit(
      { type: "prank", itemId: "unplug", to: "hanako" },
      { bus },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.isReturn, true);
    const saved = readData();
    assert.equal(saved.pendingVisits[0].isReturn, true);
    assert.equal(saved.pendingVisits[0].returnOfHeartId, "heart-1");
    assert.deepEqual(
      bus.calls.map((call) => call.topic),
      ["session:abort", "session:send"],
    );
    assert.equal(bus.calls[1].payload.text, "重启！");
  } finally {
    fs.rmSync(path.join(tmp, "agents"), { recursive: true, force: true });
  }
});

test("performVisit: 缺参数返回 400", async () => {
  writeData();
  const r = await performVisit({ type: "gift", itemId: "coffee" }, { bus: makeBus() });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /缺少必要参数/);
});

test("performVisit: 非法 type 返回 400", async () => {
  writeData();
  const r = await performVisit(
    { type: "hack", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /无效的互动类型/);
});

test("performVisit: 不存在的 item 返回 400", async () => {
  writeData();
  const r = await performVisit(
    { type: "gift", itemId: "diamond", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /项目不存在/);
});

// ── 光粒与记录 ──
test("performVisit: 送礼扣价并回赠 3 光粒，记录入库", async () => {
  writeData();
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.jar, 100 - 25 + 3, "送礼后光粒 = 100 - 25 + 3");
  const saved = readData();
  assert.equal(saved.pendingVisits.length, 1);
  assert.equal(saved.pendingVisits[0].itemId, "coffee");
  assert.equal(saved.pendingVisits[0].status, "completed");
});

test("performVisit: 光粒不足时送礼被拒", async () => {
  writeData({ jar: 10 });
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /光粒不够/);
});

test("performVisit: 互动不扣光粒，仅记录", async () => {
  writeData();
  const r = await performVisit(
    { type: "interact", itemId: "quiet", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.jar, 100, "互动不扣光粒");
  const saved = readData();
  assert.equal(saved.pendingVisits.length, 1);
  assert.equal(saved.pendingVisits[0].status, "completed");
});

// ── 模型配置检查 ──
test("performVisit: 未配置模型时送礼被拦，但恶作剧豁免", async () => {
  writeData({ llmConfig: {} });
  const gift = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(gift.status, 400);
  assert.match(gift.body.error, /模型设置/);

  const prank = await performVisit(
    { type: "prank", itemId: "unplug", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(prank.status, 200, "恶作剧不依赖模型配置");
});

// ── 关机键 ──
test("performVisit: 关机键扣 5 光粒，触发 abort + 重启注入", async () => {
  writeData();
  const bus = makeBus();
  const r = await performVisit(
    { type: "prank", itemId: "unplug", to: "hanako" },
    { bus },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.jar, 95, "关机键扣 5 光粒");
  const saved = readData();
  assert.equal(saved.pendingVisits[0].status, "pending", "关机键记录为 pending");
  assert.equal(bus.calls.length, 0, "无会话时不调用 bus（静默跳过）");
});

test("performVisit: 说怪话扣 3 光粒，推送怪话", async () => {
  writeData();
  const bus = makeBus();
  const r = await performVisit(
    { type: "prank", itemId: "brainrot", to: "hanako" },
    { bus },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.jar, 97, "说怪话扣 3 光粒");
  assert.equal(bus.calls.length, 0, "无会话时推送跳过但动作成功");
});

// ── 并发写锁 ──
test("performVisit: 并发送礼不丢记录（写锁串行化）", async () => {
  writeData();
  const bus = makeBus();
  await Promise.all(
    [0, 1, 2].map(() =>
      performVisit({ type: "gift", itemId: "coffee", to: "hanako" }, { bus }),
    ),
  );
  const saved = readData();
  assert.equal(saved.pendingVisits.length, 3, "三次并发送礼三条记录");
  assert.equal(saved.jar, 100 - 3 * 25 + 3 * 3, "光粒按三次扣减");
});

// ── 助手 ID 白名单（回归：/api/visit 曾只查类型和长度，不做 isValidAgentId） ──
test("performVisit: 路径穿越 to 被拒（../etc/passwd）", async () => {
  writeData();
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "../etc/passwd" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /无效的助手 ID/);
  const saved = readData();
  assert.equal(saved.pendingVisits.length, 0, "不应产生任何记录");
});

test("performVisit: 原型污染 to 被拒（__proto__）", async () => {
  writeData();
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "__proto__" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /无效的助手 ID/);
});

test("performVisit: 已隐藏助手不再接受新的互动", async () => {
  writeData({
    partnerConfig: {
      hanako: { name: "小花", hidden: true, variables: { mood: 60, affection: 10 } },
    },
  });
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /不在闲不住列表/);
});

test("performVisit: 未登记的助手 ID 被拒（partnerConfig 白名单）", async () => {
  writeData();
  const r = await performVisit(
    { type: "gift", itemId: "coffee", to: "nobody" },
    { bus: makeBus() },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /助手不存在/);
  const saved = readData();
  assert.equal(saved.pendingVisits.length, 0, "不应产生任何记录");
});
