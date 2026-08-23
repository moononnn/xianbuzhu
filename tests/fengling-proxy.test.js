// 闲不住 — 风铃本地代理目标判定回归测试
// 覆盖：无活跃窗口返回 409；客户端即使传 to，服务端仍按点击瞬间的最活跃会话重判。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-fengling-proxy-"));
process.env.HANA_HOME = home;

const { performFenglingVisit } = await import("../lib/fengling.js?test=" + Date.now());

function writeData(overrides = {}) {
  const data = {
    jar: 100,
    llmConfig: { providerId: "test", modelId: "test" },
    partnerConfig: {
      hanako: { name: "小花", variables: { mood: 60, energy: 80, affection: 10 } },
      helperB: { name: "伙伴B", variables: { mood: 60, energy: 80, affection: 10 } },
    },
    pendingVisits: [],
    shopItems: [{ id: "star-lamp", name: "星星灯", icon: "🌟", price: 10 }],
    interactItems: [{ id: "quiet", name: "安静陪着", icon: "" }],
    prankItems: [],
    heartSettings: { frequency: "low" },
    heartInbox: [{
      id: "heart-1",
      partnerId: "helperB",
      partnerName: "伙伴B",
      gift: { id: "coffee", name: "咖啡", icon: "☕", price: 10 },
      message: "给你放了一杯咖啡。",
      status: "unread",
      deliveredAt: null,
      createdAt: "2026-08-09T03:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }],
    ...overrides,
  };
  const dir = path.join(home, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf-8");
}

function writeSession(agentId, userAt, filename = `${agentId}.jsonl`) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const line = {
    type: "message",
    id: `sess_${agentId}_abcdef12`,
    timestamp: userAt,
    message: { role: "user", content: "test", timestamp: userAt },
  };
  const file = path.join(dir, filename);
  fs.writeFileSync(file, JSON.stringify(line) + "\n", "utf-8");
  return file;
}

test("风铃代理由服务端锁定点击瞬间的最活跃会话", async () => {
  writeData();

  const missing = await performFenglingVisit(
    { type: "interact", itemId: "quiet", to: "helperB" },
    null,
  );
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /还没找到/);

  writeSession("hanako", "2026-08-09T04:00:00.000Z");
  writeSession("helperB", "2026-08-09T03:00:00.000Z");
  const captured = {};
  const visitFn = async (input, deps) => {
    captured.input = input;
    captured.deps = deps;
    return { status: 200, body: { success: true } };
  };
  const bus = { request: async () => true };
  const result = await performFenglingVisit(
    { type: "interact", itemId: "quiet", to: "helperB" },
    bus,
    visitFn,
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.target.id, "hanako");
  assert.equal(captured.input.to, "hanako", "客户端传入的 helperB 必须被覆盖");
  assert.equal(captured.deps.bus, bus);
});

test("风铃固定目标会话后，动作会把指定 sessionPath 传到业务层", async () => {
  const fixedPath = writeSession("helperB", "2026-08-09T04:00:00.000Z", "fixed.jsonl");
  writeData({
    pinnedTarget: { agentId: "helperB", sessionPath: fixedPath, title: "绯月的对话" },
  });
  writeSession("hanako", "2026-08-09T05:00:00.000Z");
  const captured = {};
  const result = await performFenglingVisit(
    { type: "interact", itemId: "quiet", to: "hanako" },
    { request: async () => true },
    async (input, deps) => {
      captured.input = input;
      captured.deps = deps;
      return { status: 200, body: { success: true } };
    },
  );
  assert.equal(result.body.target.id, "helperB");
  assert.equal(result.body.target.mode, "pinned");
  assert.equal(captured.input.to, "helperB");
  assert.equal(captured.input.sessionPath, fixedPath);
});
