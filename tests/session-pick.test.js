// 闲不住 — 活跃窗口判定回归测试（node:test）
// 覆盖：按「最后一条用户消息」选会话、无用户消息兜底 mtime、空目录/不存在兜底
// 运行：node --test tests/session-pick.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 临时 HANA_HOME 下动态加载模块（query 参数绕过 ESM 缓存）
async function freshDataModule(tmpHome) {
  const prev = process.env.HANA_HOME;
  process.env.HANA_HOME = tmpHome;
  try {
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    return await import("../lib/data.js?v=" + stamp);
  } finally {
    process.env.HANA_HOME = prev;
  }
}

function sessionLine(role, ts) {
  return JSON.stringify({
    type: "message",
    id: "m-" + Math.random().toString(36).slice(2, 8),
    timestamp: ts,
    message: { role, content: "test", timestamp: ts },
  });
}

function makeSession(dir, name, opts = {}) {
  const p = path.join(dir, name);
  const lines = [];
  if (opts.userAt) lines.push(sessionLine("user", opts.userAt));
  if (opts.assistantAt) lines.push(sessionLine("assistant", opts.assistantAt));
  if (lines.length === 0) {
    lines.push(
      JSON.stringify({ type: "session", id: name, timestamp: "2026-08-01T00:00:00.000Z" }),
    );
  }
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");
  if (opts.mtime) {
    const t = new Date(opts.mtime).getTime() / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}

test("按最后一条用户消息选会话：mtime 更新但用户消息旧的会话不抢位置", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  // A：mtime 新（助手 11:00 刚回复过），但用户最后说话是 10:00
  makeSession(sessionsDir, "A.jsonl", {
    userAt: "2026-08-07T10:00:00.000Z",
    assistantAt: "2026-08-07T11:00:00.000Z",
    mtime: "2026-08-07T11:00:00.000Z",
  });
  // B：mtime 旧，但用户最后说话 12:00
  makeSession(sessionsDir, "B.jsonl", {
    userAt: "2026-08-07T12:00:00.000Z",
    mtime: "2026-08-07T09:00:00.000Z",
  });

  const mod = await freshDataModule(home);
  const picked = mod.findLatestSessionPath("hanako");
  assert.ok(
    picked.endsWith("B.jsonl"),
    "应选用户最后说话更新的 B，实际 " + picked,
  );
});

test("无用户消息的会话兜底用 mtime", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  makeSession(sessionsDir, "A.jsonl", {
    userAt: "2026-08-07T10:00:00.000Z",
    mtime: "2026-08-07T08:00:00.000Z",
  });
  // C：只有 assistant 消息（无用户消息），mtime 最新
  makeSession(sessionsDir, "C.jsonl", {
    assistantAt: "2026-08-07T13:00:00.000Z",
    mtime: "2026-08-07T13:00:00.000Z",
  });

  const mod = await freshDataModule(home);
  const picked = mod.findLatestSessionPath("hanako");
  assert.ok(
    picked.endsWith("C.jsonl"),
    "无用户消息时按 mtime 兜底，应选 C，实际 " + picked,
  );
});

test("会话目录不存在 / 为空返回空字符串", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const mod = await freshDataModule(home);
  assert.equal(mod.findLatestSessionPath("ghost"), "");

  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  assert.equal(mod.findLatestSessionPath("hanako"), "");
});
