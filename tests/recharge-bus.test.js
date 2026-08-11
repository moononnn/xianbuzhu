// 闲不住 — 充电推送携带 bus 的回归测试（第 4 点 P1）
// 覆盖：/api/recharge 成功后 pushToAgent 必须拿到 bus（否则开头 if(!bus) return false，
//       助手永远收不到充电通知）。构造真实会话文件让 findLatestSessionId 成功，
//       断言 mockBus 收到 session:send 且文本含「充电」。
// 运行：node --test tests/recharge-bus.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-recharge-"));
process.env.HANA_HOME = tmp;

function bjToday() {
  return new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10);
}

// 数据：jar 足够 + 已登记助手
const dataDir = path.join(tmp, "data", "work-visit");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "data.json"),
  JSON.stringify({
    days: {},
    lastResetDate: bjToday(),
    jar: 500,
    partnerConfig: {
      hanako: { name: "小花", variables: { mood: 60, energy: 60, affection: 10 } },
    },
  }),
  "utf-8",
);

// 会话文件：pushToAgent 需要解析出 sess_xxx 才会真正 bus.request
const sessDir = path.join(tmp, "agents", "hanako", "sessions");
fs.mkdirSync(sessDir, { recursive: true });
fs.writeFileSync(
  path.join(sessDir, "2026-08-10T00-00-00-000Z_test.jsonl"),
  [
    JSON.stringify({
      role: "user",
      content: "hi",
      ts: new Date(Date.now() - 60000).toISOString(),
    }),
    "",
  ].join("\n"),
  "utf-8",
);
// 会话文件头部塞 sess_ 标识（与真实 Hana 会话文件格式一致：sess_xxx_yyy 出现在内容里）
fs.writeFileSync(
  path.join(sessDir, "2026-08-10T00-00-00-000Z_test.jsonl"),
  "sess_abc123_abc123def456\n" +
    JSON.stringify({
      role: "user",
      content: "hi",
      ts: new Date(Date.now() - 60000).toISOString(),
    }) +
    "\n",
  "utf-8",
);

const routes = {};
const app = {
  get: (p, h) => {
    routes[p] = h;
  },
  post: (p, h) => {
    routes[p] = h;
  },
};
const busCalls = [];
const ctx = {
  bus: {
    request: async (topic, payload) => {
      busCalls.push({ topic, payload });
      return true;
    },
  },
};
const { register } = await import("../routes/api.js?v=" + Date.now());
await register(app, ctx);

test("recharge: 推送携带 bus，mockBus 收到 session:send 且文本含「充电」", async () => {
  const c = { req: { json: async () => ({ to: "hanako" }) } };
  const res = await routes["/api/recharge"](c);
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200, "充电应成功");
  assert.equal(body.success, true);
  assert.equal(body.energy, 100);

  // pushToAgent 链路：findLatestSessionPath 成功 → bus.request("session:send") 携带 sessionPath
  const sends = busCalls.filter((x) => x.topic === "session:send");
  assert.equal(sends.length, 1, "应有一次 session:send 推送（bus 已传入）");
  assert.match(sends[0].payload.text, /充电|充了电/, "推送文案应为充电提示");
  assert.ok(sends[0].payload.sessionPath, "推送应带 sessionPath（文件路径）");
  assert.match(
    sends[0].payload.sessionPath,
    /agents[\\\/]hanako[\\\/]sessions[\\\/]/,
    "sessionPath 必须是桌面会话路径（不被 subagent 会话污染）",
  );
});

test("recharge: 未登记助手 ID 被拒（isValidAgentId + partnerConfig）", async () => {
  const c = { req: { json: async () => ({ to: "../etc/passwd" }) } };
  const res = await routes["/api/recharge"](c);
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.match(body.error, /无效的助手 ID/);
});
