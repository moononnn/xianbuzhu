// 闲不住 — 活跃窗口判定回归测试（node:test）
// 覆盖：按「最后一条用户消息」选会话、跨助手判定、无用户消息兜底 mtime、空目录/不存在兜底
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

function sessionLine(role, ts, content = "test") {
  return JSON.stringify({
    type: "message",
    id: "m-" + Math.random().toString(36).slice(2, 8),
    timestamp: ts,
    message: { role, content, timestamp: ts },
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

test("助手回复或推送更新 mtime，不会抢走用户最后操作的会话", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  makeSession(sessionsDir, "A.jsonl", {
    userAt: "2026-08-07T10:00:00.000Z",
    mtime: "2026-08-07T08:00:00.000Z",
  });
  makeSession(sessionsDir, "C.jsonl", {
    assistantAt: "2026-08-07T13:00:00.000Z",
    mtime: "2026-08-07T13:00:00.000Z",
  });

  const mod = await freshDataModule(home);
  const picked = mod.findLatestSessionPath("hanako");
  assert.ok(
    picked.endsWith("A.jsonl"),
    "只含助手消息的新会话不应抢位置，实际 " + picked,
  );
});

test("全部会话都没有用户消息时，才兜底使用 mtime", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  makeSession(sessionsDir, "A.jsonl", {
    assistantAt: "2026-08-07T10:00:00.000Z",
    mtime: "2026-08-07T10:00:00.000Z",
  });
  makeSession(sessionsDir, "C.jsonl", {
    assistantAt: "2026-08-07T13:00:00.000Z",
    mtime: "2026-08-07T13:00:00.000Z",
  });

  const mod = await freshDataModule(home);
  const picked = mod.findLatestSessionPath("hanako");
  assert.ok(picked.endsWith("C.jsonl"), "应按 mtime 兜底选 C，实际 " + picked);
});

test("跨助手按最后一条用户消息选择当前最活跃窗口", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const hanakoDir = path.join(home, "agents", "hanako", "sessions");
  const helperBDir = path.join(home, "agents", "helperB", "sessions");
  fs.mkdirSync(hanakoDir, { recursive: true });
  fs.mkdirSync(helperBDir, { recursive: true });

  makeSession(hanakoDir, "hanako.jsonl", {
    userAt: "2026-08-07T12:00:00.000Z",
    mtime: "2026-08-07T12:00:00.000Z",
  });
  makeSession(helperBDir, "helperB.jsonl", {
    userAt: "2026-08-07T11:00:00.000Z",
    assistantAt: "2026-08-07T13:00:00.000Z",
    mtime: "2026-08-07T13:00:00.000Z",
  });

  const mod = await freshDataModule(home);
  assert.equal(mod.findMostActiveAgentId(["hanako", "helperB"]), "hanako");
});

test("兼容 Hana 真实会话使用的毫秒数字时间戳", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const hanakoDir = path.join(home, "agents", "hanako", "sessions");
  const helperBDir = path.join(home, "agents", "helperB", "sessions");
  fs.mkdirSync(hanakoDir, { recursive: true });
  fs.mkdirSync(helperBDir, { recursive: true });

  makeSession(hanakoDir, "hanako.jsonl", { userAt: 1_786_250_000_000 });
  makeSession(helperBDir, "helperB.jsonl", { userAt: 1_786_240_000_000 });

  const mod = await freshDataModule(home);
  assert.equal(mod.findMostActiveAgentId(["hanako", "helperB"]), "hanako");
});

test("长会话末尾超过 256KB 时仍能向前找到最后一条用户消息", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const hanakoDir = path.join(home, "agents", "hanako", "sessions");
  const helperBDir = path.join(home, "agents", "helperB", "sessions");
  fs.mkdirSync(hanakoDir, { recursive: true });
  fs.mkdirSync(helperBDir, { recursive: true });

  const longSession = makeSession(hanakoDir, "long.jsonl", {
    userAt: "2026-08-07T15:00:00.000Z",
  });
  fs.appendFileSync(
    longSession,
    sessionLine("assistant", "2026-08-07T15:01:00.000Z", "长回复".repeat(180_000)) + "\n",
    "utf-8",
  );
  makeSession(helperBDir, "short.jsonl", {
    userAt: "2026-08-07T10:00:00.000Z",
  });

  const mod = await freshDataModule(home);
  assert.equal(mod.findMostActiveAgentId(["hanako", "helperB"]), "hanako");
});

test("会话目录不存在 / 为空返回空字符串", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const mod = await freshDataModule(home);
  assert.equal(mod.findLatestSessionPath("ghost"), "");

  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  assert.equal(mod.findLatestSessionPath("hanako"), "");
});

test("跳过闲不住自推送的送达文本：被推送过的窗口不凭它抢成最新活跃", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  // A：被闲不住推送过（送达文本顶着 user 身份 + 助手回复），但用户之后没再亲手打字
  const aPath = path.join(sessionsDir, "A.jsonl");
  fs.writeFileSync(
    aPath,
    [
      sessionLine("user", "2026-08-07T11:00:00.000Z", "昨晚聊的事"),
      sessionLine(
        "user",
        "2026-08-07T13:00:00.000Z",
        "📬 收到来自朋友的一份回礼：🎵轻轻哼着歌～ 这是对你之前留下的「给窗台的茉莉浇水」的回应。",
      ),
      sessionLine("user", "2026-08-07T14:00:00.000Z", "突然想到：一只会写代码的猫最喜欢哪种语言？喵语。"),
      sessionLine("assistant", "2026-08-07T14:01:00.000Z"),
    ].join("\n") + "\n",
    "utf-8",
  );
  fs.utimesSync(aPath, 1_783_506_060, 1_783_506_060); // mtime 最新（有回复）

  // B：用户真的在 12:00 打过字（晚于 A 的真实最后打字 11:00，早于 A 的推送 13:00）
  const bPath = path.join(sessionsDir, "B.jsonl");
  fs.writeFileSync(
    bPath,
    [sessionLine("user", "2026-08-07T12:00:00.000Z", "现在正在聊的窗口")].join("\n") + "\n",
    "utf-8",
  );
  fs.utimesSync(bPath, 1_783_461_600, 1_783_461_600); // mtime 更旧

  const mod = await freshDataModule(home);
  const picked = mod.findLatestSessionPath("hanako");
  assert.ok(
    picked.endsWith("B.jsonl"),
    "自推送的送达文本不应顶掉真实活跃窗口，应选 B，实际 " + picked,
  );
});

test("兼容旧格式消息并跳过非法时间戳，不让坏行阻断扫描", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const fp = path.join(sessionsDir, "legacy.jsonl");
  fs.writeFileSync(
    fp,
    [
      JSON.stringify({ role: "user", ts: 1_786_000_000, content: "旧格式真实消息" }),
      JSON.stringify({ role: "user", timestamp: "definitely-not-a-date", content: "坏时间戳" }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const mod = await freshDataModule(home);
  assert.equal(mod.findLatestSessionPath("hanako"), fp);
});

test("粗筛边界包含第 60 个会话候选，不因边界截断漏掉真实用户消息", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-sess-"));
  const sessionsDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const base = Date.parse("2026-08-07T20:00:00.000Z");

  for (let i = 0; i < 59; i++) {
    makeSession(sessionsDir, `assistant-${String(i).padStart(2, "0")}.jsonl`, {
      assistantAt: "2026-08-07T20:00:00.000Z",
      mtime: new Date(base - i * 1000).toISOString(),
    });
  }
  const boundary = makeSession(sessionsDir, "boundary.jsonl", {
    userAt: "2026-08-07T19:00:00.000Z",
    mtime: new Date(base - 59 * 1000).toISOString(),
  });
  makeSession(sessionsDir, "outside.jsonl", {
    assistantAt: "2026-08-07T20:00:00.000Z",
    mtime: new Date(base - 60 * 1000).toISOString(),
  });

  const mod = await freshDataModule(home);
  assert.equal(mod.findLatestSessionPath("hanako"), boundary);
});
