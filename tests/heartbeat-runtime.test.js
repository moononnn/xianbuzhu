// 心跳实际落盘冒烟：无模型配置时不发送固定文案，仍能完成气质分析并安全结束计划
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-heart-runtime-"));
process.env.HANA_HOME = home;
const { MAX_HEART_RETRIES, runHeartbeatTick } = await import("../lib/heartbeat.js");
const { todayStr } = await import("../lib/data.js");

function writeData(data) {
  const dir = path.join(home, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf8");
}

function readData() {
  return JSON.parse(fs.readFileSync(path.join(home, "data", "work-visit", "data.json"), "utf8"));
}

test("runHeartbeatTick: 已生成当天计划后隐藏助手，旧计划也会取消且不读取在线状态", async () => {
  const date = todayStr();
  const entry = {
    id: `heart-plan-${date}-hidden`,
    partnerId: "probe",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    status: "planned",
  };
  writeData({
    days: {},
    jar: 0,
    partnerConfig: {
      probe: { name: "测试探针", hidden: true, variables: { energy: 100, mood: 60, affection: 20 } },
    },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  let presenceCalled = false;
  await runHeartbeatTick({}, {
    now: Date.now(),
    date,
    presenceReader: () => {
      presenceCalled = true;
      return { online: true, lastActivityAt: Date.now() };
    },
  });

  const saved = readData();
  assert.equal(saved.heartPlan.entries[0].status, "cancelled");
  assert.equal(presenceCalled, false);
});

test("runHeartbeatTick: 伙伴自主状态关闭时，主动心意仍独立处理", async () => {
  const date = todayStr();
  const now = new Date(`${date}T12:00:00+08:00`).getTime();
  const entry = {
    id: `heart-plan-${date}-status-off`,
    partnerId: "hanako",
    scheduledAt: new Date(now - 60_000).toISOString(),
    status: "planned",
  };
  writeData({
    days: {},
    jar: 0,
    statusSettings: { autonomousEnabled: false },
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 20 } },
    },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  await runHeartbeatTick({}, {
    now,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: now }),
  });

  const saved = readData();
  assert.equal(saved.heartPlan.entries[0].status, "failed", "状态开关不应拦截主动心意计划");
  assert.equal(saved.heartPlan.entries[0].failureKind, "model_not_configured");
});

test("runHeartbeatTick: 模型回包在途时关闭心意，不把旧回包写入信箱", async () => {
  const date = todayStr();
  const now = new Date(`${date}T12:00:00+08:00`).getTime();
  const entry = {
    id: `heart-plan-${date}-disable-in-flight`,
    partnerId: "hanako",
    scheduledAt: new Date(now - 60_000).toISOString(),
    status: "planned",
  };
  fs.writeFileSync(
    path.join(home, "provider-catalog.json"),
    JSON.stringify({
      providers: {
        test: {
          base_url: "https://heart.test/v1",
          api_key: "test-key",
          api: "openai-completions",
          models: ["test-model"],
        },
      },
    }),
    "utf8",
  );
  writeData({
    days: {},
    jar: 0,
    statusSettings: { autonomousEnabled: false },
    partnerConfig: {
      hanako: {
        name: "小花",
        temperamentSource: "user",
        surfaceLayer: { tag: "温柔" },
        innerLayer: { tag: "温柔" },
        variables: { energy: 100, mood: 60, affection: 20 },
      },
    },
    llmConfig: { providerId: "test", modelId: "test-model" },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    heartScenes: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      entered();
      await gate;
    }
    const content = calls % 2 === 1
      ? "我把一杯咖啡放在你手边，热气还在，忙完记得喝两口。"
      : '{"pass":true}';
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      },
    };
  };

  try {
    const pending = runHeartbeatTick({}, {
      now,
      date,
      presenceReader: () => ({ online: true, lastActivityAt: now }),
    });
    await enteredPromise;
    const switched = readData();
    switched.heartSettings.enabled = false;
    switched.heartPlan = { date: null, frequency: "low", entries: [] };
    writeData(switched);
    // 模拟用户在旧请求返回前又重新开启：旧计划 ID 已失效，旧回包仍不得复活。
    switched.heartSettings.enabled = true;
    writeData(switched);
    release();
    await pending;
  } finally {
    global.fetch = originalFetch;
  }

  const saved = readData();
  assert.equal(calls >= 2, true, "应确实进入心意模型请求");
  assert.equal(saved.heartInbox.length, 0, "关闭后的在途回包不得落入信箱");
  assert.equal(saved.heartPlan.date, null, "关闭后的旧计划不得留作补发");
});

test("runHeartbeatTick: 未配置模型时不落固定模板心意", async () => {
  const date = todayStr();
  const testNow = new Date(`${date}T12:00:00+08:00`).getTime();
  const entry = {
    id: `heart-plan-${date}-1`,
    partnerId: "hanako",
    scheduledAt: new Date(testNow - 60_000).toISOString(),
    status: "planned",
  };
  writeData({
    days: {},
    jar: 0,
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 20 } },
    },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  await runHeartbeatTick({}, {
    now: testNow,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: testNow }),
  });

  const saved = readData();
  assert.equal(saved.heartPlan.entries[0].status, "failed");
  assert.equal(saved.heartPlan.entries[0].failureReason, "message_generation_failed");
  assert.equal(saved.heartPlan.entries[0].failureKind, "model_not_configured");
  assert.equal(saved.heartInbox.length, 0);
  assert.equal(saved.partnerConfig.hanako.surfaceLayer.tag, "温柔");
});

test("runHeartbeatTick: 暂态模型故障保留原计划并安排退避重试", async () => {
  const date = todayStr();
  // 固定在白天：三轮 1/3/10 分钟退避不能因为测试恰好跨进静默时段而变成 missed。
  const now = new Date(`${date}T12:00:00+08:00`).getTime();
  const entry = {
    id: `heart-plan-${date}-transient`,
    partnerId: "hanako",
    scheduledAt: new Date(now - 60_000).toISOString(),
    status: "planned",
  };
  fs.writeFileSync(
    path.join(home, "provider-catalog.json"),
    JSON.stringify({
      providers: {
        test: {
          base_url: "http://127.0.0.1:9/v1",
          api_key: "test-key",
          api: "openai-completions",
          models: ["test-model"],
        },
      },
    }),
    "utf8",
  );
  writeData({
    days: {},
    jar: 0,
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 20 } },
    },
    llmConfig: { providerId: "test", modelId: "test-model" },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  await runHeartbeatTick({}, {
    now,
    date,
    presenceReader: () => ({ online: true, lastActivityAt: now }),
  });

  const saved = readData();
  const retried = saved.heartPlan.entries[0];
  assert.equal(retried.id, entry.id);
  assert.equal(retried.status, "retry_wait");
  assert.equal(retried.failureKind, "transient_api");
  assert.equal(retried.retryCount, 1);
  assert.ok(Date.parse(retried.nextAttemptAt) >= now + 60_000);
  assert.equal(saved.heartInbox.length, 0);

  // 让同一条计划走完剩余重试，确认下一次心跳会重新拾取 retry_wait，最终才耗尽。
  for (let retry = 0; retry < MAX_HEART_RETRIES; retry++) {
    const before = readData().heartPlan.entries[0];
    const retryAt = Date.parse(before.nextAttemptAt);
    await runHeartbeatTick({}, {
      now: retryAt,
      date,
      presenceReader: () => ({ online: true, lastActivityAt: retryAt }),
    });
  }
  const exhausted = readData().heartPlan.entries[0];
  assert.equal(exhausted.id, entry.id);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.retryCount, MAX_HEART_RETRIES);
  assert.equal(exhausted.retryExhausted, true);
  assert.equal(readData().heartInbox.length, 0);
});

test("runHeartbeatTick: 离线时心意先生成暂存（不吞），等闸放行再投递", async () => {
  const date = todayStr();
  const now = Date.now();
  const entry = {
    id: `heart-plan-${date}-offline-retry`,
    partnerId: "hanako",
    scheduledAt: new Date(now - 10 * 60_000).toISOString(),
    nextAttemptAt: new Date(now - 1_000).toISOString(),
    retryCount: 1,
    retryLimit: 3,
    status: "retry_wait",
  };
  writeData({
    days: {},
    jar: 0,
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 20 } },
    },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  let presenceCalled = false;
  await runHeartbeatTick({}, {
    now,
    date,
    presenceReader: () => {
      presenceCalled = true;
      return { online: false, lastActivityAt: now - 20 * 60_000 };
    },
  });

  const saved = readData();
  // 离线不再吞：即使闸不过也会进入生成尝试（presence 被读取判断），
  // 模型未配置时按生成失败处理；配置了模型则心意会暂存等闸放行
  assert.equal(saved.heartPlan.entries[0].status, "failed");
  assert.equal(saved.heartPlan.entries[0].failureKind, "model_not_configured");
  assert.equal(presenceCalled, true);
  assert.equal(saved.heartInbox.length, 0); // 未配置模型时不落模板心意
});

test("runHeartbeatTick: 卡住的生成状态也进入退避重试", async () => {
  const date = todayStr();
  const now = Date.now();
  const entry = {
    id: `heart-plan-${date}-timeout`,
    partnerId: "hanako",
    scheduledAt: new Date(now - 20 * 60_000).toISOString(),
    checkedAt: new Date(now - 11 * 60_000).toISOString(),
    status: "generating",
  };
  writeData({
    days: {},
    jar: 0,
    partnerConfig: {
      hanako: { name: "小花", variables: { energy: 100, mood: 60, affection: 20 } },
    },
    heartSettings: { frequency: "low" },
    heartPlan: { date, frequency: "low", entries: [entry] },
    heartInbox: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
  });

  let presenceCalled = false;
  await runHeartbeatTick({}, {
    now,
    date,
    presenceReader: () => {
      presenceCalled = true;
      return { online: true, lastActivityAt: now };
    },
  });

  const saved = readData();
  const retried = saved.heartPlan.entries[0];
  assert.equal(retried.status, "retry_wait");
  assert.equal(retried.failureKind, "generation_timeout");
  assert.equal(retried.retryCount, 1);
  assert.equal(presenceCalled, false);
});
