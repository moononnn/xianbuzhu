// 闲不住活动扫描回归测试
// 会话文件 mtime 只能做候选粗筛，最终必须按消息时间戳判断是否属于今天。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sessionLine(role, timestamp, content) {
  return JSON.stringify({
    type: "message",
    timestamp,
    message: { role, timestamp, content },
  });
}

function writeSession(dir, filename, lines, mtime = new Date()) {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  const seconds = mtime.getTime() / 1000;
  fs.utimesSync(filePath, seconds, seconds);
  return filePath;
}

async function freshActivityModule(home) {
  const previous = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  try {
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    return await import("../lib/activity.js?v=" + stamp);
  } finally {
    if (previous === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previous;
  }
}

test("活动扫描：旧会话被触碰 mtime 也不会冒充今天的聊天或工作量", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-activity-"));
  try {
    const oldDir = path.join(home, "agents", "helperB", "sessions");
    const callerDir = path.join(home, "agents", "helperA", "sessions");
    const noTimestampDir = path.join(home, "agents", "helperC", "sessions");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(callerDir, { recursive: true });
    fs.mkdirSync(noTimestampDir, { recursive: true });
    const oldAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const nowAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const today = new Date(Date.now() + 480 * 60 * 1000).toISOString().slice(0, 10);
    const unrelatedCardSessionId = "sess_0mtfake_abcdef123456";
    const oldToolCall = { type: "toolCall", name: "subagent", arguments: { agent: "helperB", task: "旧委派任务" } };

    writeSession(oldDir, "old.jsonl", [
      sessionLine("user", oldAt, "旧用户消息"),
      sessionLine("assistant", oldAt, [
        { type: "text", text: "旧回复" },
        oldToolCall,
      ]),
      sessionLine("tool", oldAt, "旧工具结果"),
    ]);
    writeSession(callerDir, "old-caller.jsonl", [
      sessionLine("assistant", oldAt, [oldToolCall]),
    ]);
    writeSession(oldDir, `${today}-push.jsonl`, [
      sessionLine("user", nowAt, "📬 收到来自伙伴的一份互动"),
    ]);
    fs.writeFileSync(path.join(oldDir, "session-titles.json"), JSON.stringify({ "old.jsonl": "旧会话标题" }), "utf8");
    fs.writeFileSync(path.join(callerDir, "session-titles.json"), "{}", "utf8");
    const noTimestampPath = path.join(noTimestampDir, "old-name.jsonl");
    fs.writeFileSync(noTimestampPath, [
      JSON.stringify({ type: "session", timestamp: nowAt }),
      JSON.stringify({ type: "message", message: { role: "user", content: "没有时间戳的今天消息" } }),
    ].join("\n") + "\n", "utf8");
    fs.utimesSync(noTimestampPath, Date.now() / 1000, Date.now() / 1000);

    const data = {
      partnerConfig: {
        helperA: { name: "伙伴A" },
        helperB: { name: "伙伴B" },
        helperC: { name: "伙伴C" },
      },
    };
    const mod = await freshActivityModule(home);
    const beforeToday = mod.scanTodayActivity(data);
    assert.equal(beforeToday.helperB.title, null);
    assert.equal(beforeToday.helperB.dispatched, null);
    assert.equal(beforeToday.helperC.title, "没有时间戳的今天消息");
    assert.deepEqual(mod.scanWorkStats(data).helperB, {
      toolCalls: 0,
      charsOutput: 0,
      fileOps: 0,
      subagentDispatches: 0,
    });

    const privateFilename = `${today}-plugin-private.jsonl`;
    writeSession(oldDir, privateFilename, [
      sessionLine("user", nowAt, "漂流瓶后台提示：只输出瓶子内容"),
      sessionLine("assistant", nowAt, [
        { type: "text", text: "后台回复" },
        { type: "toolCall", name: "file", arguments: {} },
      ]),
    ]);
    fs.writeFileSync(path.join(oldDir, "session-meta.json"), JSON.stringify({
      [privateFilename]: { plugin: { ownerPluginId: "drift-bottle", visibility: "plugin_private" } },
    }), "utf8");
    mod.clearWorkStatsCache();
    const withoutPluginPrivate = mod.scanTodayActivity(data);
    assert.equal(withoutPluginPrivate.helperB.title, null, "插件私有会话不能冒充今日用户活动");
    assert.equal(withoutPluginPrivate.helperB.dispatched, null);
    assert.deepEqual(mod.scanWorkStats(data).helperB, {
      toolCalls: 0,
      charsOutput: 0,
      fileOps: 0,
      subagentDispatches: 0,
    }, "插件私有会话不能计入今日工作量");

    const currentPath = writeSession(oldDir, `${today}-current.jsonl`, [
      sessionLine("user", nowAt, "今天的用户消息"),
      sessionLine("assistant", new Date(Date.now() - 4 * 60 * 1000).toISOString(), [
        { type: "text", text: "今天回复" },
      ]),
      JSON.stringify({ type: "custom_message", content: `某个卡片 sessionId=${unrelatedCardSessionId}` }),
    ]);
    fs.writeFileSync(`${currentPath}.files.json`, JSON.stringify({ sessionId: "sess_activity_current" }), "utf8");
    fs.writeFileSync(path.join(oldDir, "session-titles.json"), JSON.stringify({
      [unrelatedCardSessionId]: "错误卡片标题",
      sess_activity_current: "今天的真实会话标题",
    }), "utf8");
    mod.clearWorkStatsCache();

    const afterToday = mod.scanTodayActivity(data);
    assert.equal(afterToday.helperB.title, "今天的真实会话标题");
    assert.equal(afterToday.helperB.dispatched, null);
    assert.deepEqual(mod.scanWorkStats(data).helperB, {
      toolCalls: 0,
      charsOutput: "今天回复".length,
      fileOps: 0,
      subagentDispatches: 0,
    });

    const pluginPrivateFilename = `${today}-drift-private.jsonl`;
    writeSession(callerDir, pluginPrivateFilename, [
      sessionLine("user", nowAt, "漂流瓶后台提示：只输出瓶子内容"),
      sessionLine("assistant", nowAt, [
        { type: "text", text: "后台回复" },
        { type: "toolCall", name: "file", arguments: {} },
      ]),
    ]);
    fs.writeFileSync(path.join(callerDir, "session-meta.json"), JSON.stringify({
      [pluginPrivateFilename]: {
        plugin: { ownerPluginId: "drift-bottle", visibility: "plugin_private" },
      },
    }), "utf8");
    mod.clearWorkStatsCache();
    const callerWithoutPluginPrivate = mod.scanTodayActivity(data);
    assert.equal(callerWithoutPluginPrivate.helperA.title, null, "插件私有会话不能冒充今日用户活动");
    assert.equal(callerWithoutPluginPrivate.helperA.dispatched, null);
    assert.deepEqual(mod.scanWorkStats(data).helperA, {
      toolCalls: 0,
      charsOutput: 0,
      fileOps: 0,
      subagentDispatches: 0,
    }, "插件私有会话不能计入今日工作量");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
