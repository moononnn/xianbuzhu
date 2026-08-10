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

function writeData() {
  const data = {
    jar: 100,
    llmConfig: { providerId: "test", modelId: "test" },
    partnerConfig: {
      hanako: { name: "小花", variables: { mood: 60, energy: 80, affection: 10 } },
      yumi: { name: "悠米", variables: { mood: 60, energy: 80, affection: 10 } },
    },
    pendingVisits: [],
    shopItems: [],
    interactItems: [{ id: "quiet", name: "安静陪着", icon: "" }],
    prankItems: [],
  };
  const dir = path.join(home, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf-8");
}

function writeSession(agentId, userAt) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const line = {
    type: "message",
    id: `sess_${agentId}_abcdef12`,
    timestamp: userAt,
    message: { role: "user", content: "test", timestamp: userAt },
  };
  fs.writeFileSync(path.join(dir, `${agentId}.jsonl`), JSON.stringify(line) + "\n", "utf-8");
}

test("风铃代理由服务端锁定点击瞬间的最活跃会话", async () => {
  writeData();

  const missing = await performFenglingVisit(
    { type: "interact", itemId: "quiet", to: "yumi" },
    null,
  );
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /还没找到/);

  writeSession("hanako", "2026-08-09T04:00:00.000Z");
  writeSession("yumi", "2026-08-09T03:00:00.000Z");
  const captured = {};
  const visitFn = async (input, deps) => {
    captured.input = input;
    captured.deps = deps;
    return { status: 200, body: { success: true } };
  };
  const bus = { request: async () => true };
  const result = await performFenglingVisit(
    { type: "interact", itemId: "quiet", to: "yumi" },
    bus,
    visitFn,
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.target.id, "hanako");
  assert.equal(captured.input.to, "hanako", "客户端传入的 yumi 必须被覆盖");
  assert.equal(captured.deps.bus, bus);
});
