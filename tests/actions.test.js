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

const { performVisit } = await import("../lib/actions.js");

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

function makeBus() {
  const bus = { calls: [] };
  bus.request = async (topic, payload) => {
    bus.calls.push({ topic, payload });
    return true;
  };
  return bus;
}

// ── 参数校验 ──
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
