// 闲不住 — 普通互动/礼物投递队列回归测试
// 覆盖：持久入队、同会话批量合并、session_busy 重试、并发排他、重载恢复与超时对账。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-delivery-queue-"));
process.env.HANA_HOME = tmp;

const {
  DeliveryQueueManager,
  appendVisitDelivery,
  buildDeliveryBatchText,
  createVisitDelivery,
} = await import("../lib/delivery-queue.js");

const dataPath = path.join(tmp, "data", "work-visit", "data.json");

function writeSession(agentId = "hanako", name = "chat.jsonl") {
  const dir = path.join(tmp, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "", "utf8");
  return file;
}

function writeData({ visits = [], queue = [] } = {}) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(
    dataPath,
    JSON.stringify({
      jar: 100,
      partnerConfig: { hanako: { name: "小花" } },
      pendingVisits: visits,
      deliveryQueue: queue,
    }),
    "utf8",
  );
}

function readData() {
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

function makeVisit(id, overrides = {}) {
  return {
    id,
    type: "gift",
    itemId: "coffee",
    itemName: "咖啡",
    icon: "☕",
    to: "hanako",
    createdAt: new Date().toISOString(),
    status: "completed",
    deliveryStatus: "queued",
    ...overrides,
  };
}

function makeEntry(visit, overrides = {}) {
  return {
    ...createVisitDelivery({
      visit,
      text: `📦 收到来自玥儿的一份心意：${visit.itemName}`,
      userName: "玥儿",
      sessionPath: overrides.sessionPath || "",
    }),
    ...overrides,
  };
}

function makeBus(handler = async () => ({ accepted: true })) {
  const listeners = new Set();
  const bus = {
    calls: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event, sessionPath = "") {
      for (const listener of listeners) listener(event, sessionPath);
    },
    async request(topic, payload) {
      bus.calls.push({ topic, payload });
      return handler(topic, payload, bus);
    },
  };
  return bus;
}

function quietLog() {
  return { info() {}, warn() {}, error() {} };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待队列状态超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("buildDeliveryBatchText: 单条保留原文，多条合并为一次心意", () => {
  const first = makeVisit("one");
  const second = makeVisit("two", { itemName: "一束花", icon: "💐" });
  const entries = [makeEntry(first), makeEntry(second)];
  assert.equal(buildDeliveryBatchText([entries[0]]), entries[0].text);
  const text = buildDeliveryBatchText(entries);
  assert.match(text, /玥儿趁你忙着时给你留了 2 份心意/);
  assert.match(text, /☕ 咖啡/);
  assert.match(text, /💐 一束花/);
});

test("DeliveryQueueManager: session_busy 不会丢队列，结束事件后只发送一次", async () => {
  const sessionPath = writeSession("hanako", "busy.jsonl");
  const visit = makeVisit("busy-1");
  const entry = makeEntry(visit, { sessionPath });
  writeData({ visits: [visit], queue: [entry] });

  let busy = true;
  const bus = makeBus(async (topic) => {
    if (topic === "session:send" && busy) {
      busy = false;
      throw new Error("session_busy");
    }
    return { accepted: true };
  });
  const manager = new DeliveryQueueManager({
    bus,
    tickMs: 60_000,
    busyRetryMs: 60_000,
    requestTimeoutMs: 100,
    log: quietLog(),
  });
  manager.start();
  await waitUntil(() => bus.calls.filter((call) => call.topic === "session:send").length === 1);
  assert.equal(readData().deliveryQueue[0].status, "pending");

  bus.emit({ type: "agent_end" }, sessionPath);
  await waitUntil(() => readData().deliveryQueue.length === 0);
  assert.equal(
    bus.calls.filter((call) => call.topic === "session:send").length,
    2,
    "第一次忙碌拒绝，结束事件只补发一次",
  );
  assert.equal(readData().pendingVisits[0].deliveryStatus, "delivered");
  manager.stop();
});

test("DeliveryQueueManager: 同一 sessionPath 的快速连送合并成一个回合", async () => {
  const sessionPath = writeSession("hanako", "batch.jsonl");
  const first = makeVisit("batch-1");
  const second = makeVisit("batch-2", { itemName: "一束花", icon: "💐" });
  writeData({
    visits: [first, second],
    queue: [makeEntry(first, { sessionPath }), makeEntry(second, { sessionPath })],
  });
  const bus = makeBus();
  const manager = new DeliveryQueueManager({
    bus,
    tickMs: 60_000,
    requestTimeoutMs: 100,
    log: quietLog(),
  });

  await manager.drainNow();
  const sends = bus.calls.filter((call) => call.topic === "session:send");
  assert.equal(sends.length, 1);
  assert.match(sends[0].payload.text, /2 份心意/);
  assert.match(sends[0].payload.text, /咖啡/);
  assert.match(sends[0].payload.text, /一束花/);
  const saved = readData();
  assert.deepEqual(saved.deliveryQueue, []);
  assert.deepEqual(
    saved.pendingVisits.map((visit) => visit.deliveryStatus),
    ["delivered", "delivered"],
  );
});

test("DeliveryQueueManager: kick 按 sessionPath 隔离，不会误投到另一段会话", async () => {
  const firstPath = writeSession("hanako", "isolated-a.jsonl");
  const secondPath = writeSession("helperB", "isolated-b.jsonl");
  const first = makeVisit("isolated-a", { to: "hanako" });
  const second = makeVisit("isolated-b", { to: "helperB", itemName: "一杯茶", icon: "🍵" });
  writeData({
    visits: [first, second],
    queue: [makeEntry(first, { sessionPath: firstPath }), makeEntry(second, { sessionPath: secondPath })],
  });
  const bus = makeBus();
  const manager = new DeliveryQueueManager({ bus, requestTimeoutMs: 100, log: quietLog() });

  manager.kick(firstPath);
  await manager.drainNow();
  assert.equal(bus.calls.filter((call) => call.topic === "session:send").length, 1);
  assert.equal(bus.calls[0].payload.sessionPath, firstPath);
  assert.equal(readData().deliveryQueue.length, 1);
  assert.equal(readData().deliveryQueue[0].to, "helperB");

  manager.kick(secondPath);
  await manager.drainNow();
  assert.equal(bus.calls.filter((call) => call.topic === "session:send").length, 2);
  assert.equal(bus.calls[1].payload.sessionPath, secondPath);
  assert.equal(readData().deliveryQueue.length, 0);
});

test("DeliveryQueueManager: 并发 drain 只认领一批，不重复发送", async () => {
  const sessionPath = writeSession("hanako", "concurrent.jsonl");
  const visit = makeVisit("concurrent-1");
  writeData({ visits: [visit], queue: [makeEntry(visit, { sessionPath })] });
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  const bus = makeBus(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { accepted: true };
  });
  const manager = new DeliveryQueueManager({ bus, requestTimeoutMs: 100, log: quietLog() });

  const first = manager.drainNow();
  const second = manager.drainNow();
  await entered;
  await Promise.all([first, second]);
  assert.equal(bus.calls.filter((call) => call.topic === "session:send").length, 1);
  assert.equal(readData().deliveryQueue.length, 0);
});

test("DeliveryQueueManager: 进程重载后可恢复未完成的 sending 记录", async () => {
  const sessionPath = writeSession("hanako", "reload.jsonl");
  const visit = makeVisit("reload-1");
  const entry = makeEntry(visit, {
    sessionPath,
    status: "sending",
    batchId: "old-batch",
    sendingAt: Date.now() - 60_000,
    resolvedSessionPath: sessionPath,
    attempts: 1,
  });
  writeData({ visits: [visit], queue: [entry] });
  const bus = makeBus();
  const manager = new DeliveryQueueManager({
    bus,
    staleSendingMs: 1,
    requestTimeoutMs: 100,
    log: quietLog(),
  });

  await manager.drainNow();
  assert.equal(bus.calls[0].topic, "session:history");
  assert.equal(readData().deliveryQueue[0].status, "pending");
  await manager.drainNow();
  assert.equal(bus.calls.filter((call) => call.topic === "session:send").length, 1);
  assert.equal(readData().deliveryQueue.length, 0);
});

test("DeliveryQueueManager: session:send 超时先标记 unknown，对账未命中后再回到队列", async () => {
  const sessionPath = writeSession("hanako", "timeout.jsonl");
  const visit = makeVisit("timeout-1");
  const entry = makeEntry(visit, { sessionPath });
  writeData({ visits: [visit], queue: [entry] });
  let historyCalls = 0;
  const bus = makeBus(async (topic) => {
    if (topic === "session:send") return new Promise(() => {});
    historyCalls++;
    return { messages: [] };
  });
  const manager = new DeliveryQueueManager({
    bus,
    requestTimeoutMs: 10,
    historyTimeoutMs: 30,
    staleSendingMs: 1,
    errorRetryMs: 0,
    log: quietLog(),
  });

  await manager.drainNow();
  assert.equal(readData().deliveryQueue[0].status, "uncertain");
  assert.equal(readData().pendingVisits[0].deliveryStatus, "unknown");

  await manager.drainNow();
  assert.equal(historyCalls, 1);
  assert.equal(readData().deliveryQueue[0].status, "pending");
  assert.equal(readData().pendingVisits[0].deliveryStatus, "queued");
});

test("DeliveryQueueManager: 超时后历史已出现原文则确认送达，不重复发送", async () => {
  const sessionPath = writeSession("hanako", "history-found.jsonl");
  const visit = makeVisit("history-found-1");
  const entry = makeEntry(visit, { sessionPath });
  writeData({ visits: [visit], queue: [entry] });
  let sendCalls = 0;
  let sentText = "";
  const bus = makeBus(async (topic, payload) => {
    if (topic === "session:send") {
      sendCalls++;
      sentText = payload.text;
      throw new Error("session:send timeout");
    }
    return { messages: [{ role: "user", content: sentText }] };
  });
  const manager = new DeliveryQueueManager({
    bus,
    requestTimeoutMs: 10,
    historyTimeoutMs: 30,
    staleSendingMs: 1,
    log: quietLog(),
  });

  await manager.drainNow();
  await manager.drainNow();
  assert.equal(sendCalls, 1);
  assert.equal(readData().deliveryQueue.length, 0);
  assert.equal(readData().pendingVisits[0].deliveryStatus, "delivered");
});
