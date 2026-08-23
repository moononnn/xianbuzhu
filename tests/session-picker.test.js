// 闲不住 — 风铃手动目标会话选择回归测试
// 覆盖：按助手过滤、每位助手最多前 5 个对话、路径边界校验。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-session-picker-"));
const previousHome = process.env.HANA_HOME;
process.env.HANA_HOME = home;
const {
  isSessionPathForAgent,
  listNamedSessions,
  listRecentSessions,
} = await import("../lib/session-picker.js?test=" + Date.now());
process.env.HANA_HOME = previousHome;

function writeSession(agentId, filename, userAt, text) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, JSON.stringify({
    type: "message",
    timestamp: userAt,
    message: { role: "user", timestamp: userAt, content: text },
  }) + "\n", "utf8");
  return file;
}

test("按助手列出最近对话时只返回该助手，并限制为前 5 个", async () => {
  for (let i = 0; i < 7; i += 1) {
    writeSession(
      "helperB",
      `helper-${i}.jsonl`,
      `2026-08-21T10:${String(i).padStart(2, "0")}:00.000Z`,
      `伙伴B 的第 ${i} 段对话`,
    );
  }
  writeSession("hanako", "other.jsonl", "2026-08-21T23:00:00.000Z", "小花的对话");

  const sessions = await listNamedSessions(null, ["hanako", "helperB"], "helperB", 5);
  assert.equal(sessions.length, 5);
  assert.ok(sessions.every((item) => item.agentId === "helperB"));
  assert.equal(sessions[0].title, "伙伴B 的第 6 段对话");
  assert.equal(sessions[4].title, "伙伴B 的第 2 段对话");
});

test("没有宿主 session:list 时，最近对话仍能从文件回退读取", () => {
  const sessions = listRecentSessions(["hanako"], 5);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agentId, "hanako");
  assert.match(sessions[0].title, /小花的对话/);
});

test("宿主 session:list 只返回一部分时，会和本地列表合并再取前 5 个", async () => {
  const newestPath = path.join(home, "agents", "helperB", "sessions", "helper-6.jsonl");
  const sessions = await listNamedSessions({
    request: async () => ({
      sessions: [{
        path: path.join(home, "agents", "helperB", "sessions", "helper-6.jsonl"),
        agentId: "helperB",
        title: "宿主标题",
      }],
    }),
  }, ["helperB"], "helperB", 5);
  assert.equal(sessions.length, 5);
  assert.equal(sessions[0].sessionPath, newestPath);
  assert.equal(sessions.find((item) => item.title === "宿主标题")?.agentId, "helperB");
});

test("宿主 session:list 超时/失败时回退本地文件扫描，不挂起", async () => {
  // bus.request 直接拒绝（模拟宿主不响应/超时）→ 应回退本地扫描并正常返回
  const sessions = await listNamedSessions({
    request: async () => {
      throw new Error("session:list超时（3000ms）");
    },
  }, ["helperB"], "helperB", 5);
  assert.equal(sessions.length, 5);
  assert.ok(sessions.every((item) => item.agentId === "helperB"));
});

test("宿主 modified 使用秒级数字时仍能正确排序", async () => {
  const hostOnlyPath = path.join(home, "agents", "helperB", "sessions", "host-only.jsonl");
  fs.writeFileSync(hostOnlyPath, JSON.stringify({ type: "session", status: "active" }) + "\n", "utf8");
  const modifiedSeconds = Math.floor(Date.parse("2026-08-21T23:30:00.000Z") / 1000);
  const sessions = await listNamedSessions({
    request: async () => ({
      sessions: [{ path: hostOnlyPath, agentId: "helperB", modified: modifiedSeconds }],
    }),
  }, ["helperB"], "helperB", 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionPath, hostOnlyPath);
});

test("固定目标的 sessionPath 必须属于对应助手的 sessions 目录", () => {
  const helperPath = path.join(home, "agents", "helperB", "sessions", "helper-0.jsonl");
  const hanakoPath = path.join(home, "agents", "hanako", "sessions", "other.jsonl");
  assert.equal(isSessionPathForAgent(helperPath, "helperB"), true);
  assert.equal(isSessionPathForAgent(helperPath, "hanako"), false);
  assert.equal(isSessionPathForAgent(hanakoPath, "hanako"), true);
  assert.equal(isSessionPathForAgent(path.join(home, "outside.jsonl"), "helperB"), false);
});
