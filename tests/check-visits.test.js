// check-visits 工具测试：回礼上下文必须能在直接推送失败时兜底传给助手
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-check-visits-"));
process.env.HANA_HOME = tmp;

const { execute } = await import("../tools/check-visits.js");

function writeData(overrides = {}) {
  const data = {
    pendingVisits: [],
    partnerConfig: {
      hanako: { variables: { energy: 100, mood: 60, affection: 10 } },
    },
    ...overrides,
  };
  const dir = path.join(tmp, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf8");
}

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("check-visits: 关机键回礼包含前置心意上下文", async () => {
  writeData({
    pendingVisits: [{
      id: "visit-1",
      type: "prank",
      itemId: "unplug",
      itemName: "悄咪咪按下关机键",
      icon: "🔌",
      to: "hanako",
      status: "pending",
      createdAt: "2026-08-19T10:55:00+08:00",
      isReturn: true,
      returnOfHeartId: "heart-1",
      returnOf: { eventType: "gift", itemId: "bouquet", itemName: "一束花", icon: "💐" },
      autoReply: "系统异常……".repeat(20),
    }],
  });
  const result = await execute({}, { agentId: "hanako" });
  const text = result.content[0].text;
  assert.match(text, /回礼/);
  assert.match(text, /一束花/);
  assert.match(text, /回复正文/);
});

test("check-visits: 最近完成的回礼保留结构化来源", async () => {
  writeData({
    pendingVisits: [{
      id: "visit-2",
      type: "prank",
      itemId: "brainrot",
      itemName: "冷不丁说句怪话",
      icon: "🧠",
      to: "hanako",
      status: "completed",
      createdAt: "2026-08-19T10:55:00+08:00",
      isReturn: true,
      returnOfHeartId: "heart-2",
      returnOf: { eventType: "scene", itemId: "sticky-note", itemName: "屏幕边缘的一张便签", icon: "📝" },
    }],
  });
  const result = await execute({}, { agentId: "hanako" });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload._recent, true);
  assert.equal(payload.visits[0].isReturn, true);
  assert.equal(payload.visits[0].returnOf.itemName, "屏幕边缘的一张便签");
  assert.match(payload.visits[0].returnNote, /回应/);
});

test("check-visits: 聚合回礼告知攒着的心意份数", async () => {
  writeData({
    pendingVisits: [{
      id: "visit-3",
      type: "gift",
      itemId: "coffee",
      itemName: "咖啡",
      icon: "☕",
      to: "hanako",
      status: "pending",
      createdAt: "2026-08-19T10:55:00+08:00",
      isReturn: true,
      returnOfHeartId: "heart-2",
      returnOfHeartCount: 2,
      returnOf: { eventType: "gift", itemId: "bouquet", itemName: "一束花", icon: "💐" },
    }],
  });
  const result = await execute({}, { agentId: "hanako" });
  const text = result.content[0].text;
  assert.match(text, /2 份心意/);
  assert.match(text, /攒下/);
});
