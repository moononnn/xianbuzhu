// 闲不住 · 伙伴自主状态自检测试
// 覆盖：专用模型路由、活动事实注入、严格 JSON 解析、90 分钟节流、失败退避、每日上限、隐藏伙伴和心跳独立接入。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-status-autonomy-"));
const previousHome = process.env.HANA_HOME;
process.env.HANA_HOME = home;

const {
  STATUS_AUTONOMY_INTERVAL_MS,
  STATUS_AUTONOMY_KEEP_IDLE_INTERVAL_MS,
  STATUS_AUTONOMY_CHECK_TIMEOUT_MS,
  STATUS_AUTONOMY_FAILURE_DELAYS_MS,
  buildAutonomousStatusPrompt,
  parseAutonomousStatusDecision,
  runAutonomousStatusTick,
} = await import("../lib/status-autonomy.js");
const {
  STATUS_ROUTINE_INTERVAL_MS,
  defaultData,
  getCurrentStatus,
  loadData,
  nowISO,
  saveData,
  todayStr,
} = await import("../lib/data.js");
const { runHeartbeatTick } = await import("../lib/heartbeat.js");
if (previousHome === undefined) delete process.env.HANA_HOME;
else process.env.HANA_HOME = previousHome;

function writeData(data) {
  const dir = path.join(home, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf8");
}

function readData() {
  return JSON.parse(fs.readFileSync(path.join(home, "data", "work-visit", "data.json"), "utf8"));
}

function baseData() {
  const date = todayStr();
  const data = defaultData();
  data.lastResetDate = date;
  data.partnerConfig = {
    hanako: {
      name: "小花",
      variables: { energy: 82, mood: 78, affection: 60 },
    },
  };
  data.heartPlan = { date, frequency: "low", entries: [] };
  return data;
}

function multiPartnerData(now) {
  const date = todayStr();
  const data = baseData();
  data.partnerConfig.helperA = {
    name: "伙伴A",
    variables: { energy: 58, mood: 62, affection: 20 },
  };
  data.partnerConfig.helperB = {
    name: "伙伴B",
    variables: { energy: 74, mood: 68, affection: 30 },
  };
  data.partnerConfig.hiddenHelper = {
    name: "隐藏伙伴",
    hidden: true,
    variables: { energy: 90, mood: 80, affection: 10 },
  };
  data.days[date] = {
    date,
    partners: {
      helperB: {
        contributed: false,
        narrative: "",
        effortLP: 0,
        status: {
          id: "quiet-work",
          text: "安静做事中",
          icon: "🌿",
          category: "日常",
          scope: "public",
          duration: "today",
          setAt: nowISO(now - 4 * 60 * 60 * 1000),
          expiresAt: null,
        },
        statusHistory: [{
          id: "quiet-work",
          text: "安静做事中",
          icon: "🌿",
          category: "日常",
          scope: "public",
          duration: "today",
          setAt: nowISO(now - 4 * 60 * 60 * 1000),
          source: "user",
          trigger: "user",
          moodBand: "steady",
          energyBand: "high",
        }],
      },
    },
  };
  return data;
}

function samplerReturning(text, calls) {
  return async (input) => {
    calls.push(input);
    return { text };
  };
}

test("自主状态解析：剥离思考块和代码围栏，只接受严格决定", () => {
  const parsed = parseAutonomousStatusDecision(
    '<think>这里不能进入状态</think>\n```json\n{"action":"update","statusId":"inspiration","duration":"four_hours","trigger":"mood"}\n```',
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.decision, {
    action: "update",
    statusId: "inspiration",
    statusText: "",
    icon: "✨",
    category: "自定义",
    duration: "four_hours",
    trigger: "mood",
  });

  assert.equal(parseAutonomousStatusDecision(JSON.stringify({ action: "update", statusText: "很".repeat(41) })).ok, false);
  assert.equal(parseAutonomousStatusDecision(JSON.stringify({ action: "update", statusText: "状态标签真的太长啦" })).ok, false);
  assert.equal(parseAutonomousStatusDecision('{"action":"update","statusId":"../bad"}').ok, false);
  assert.deepEqual(parseAutonomousStatusDecision({ action: "keep" }), { ok: true, decision: { action: "keep" } });
});

test("自主状态提示：优先选择短状态 ID，具体活动继续留在 narrative", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "hanako",
    partnerName: "小花",
    activity: { conversationTitle: "重做闲不住状态池" },
    catalog: {
      publicStatuses: [{ id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", group: "work" }],
    },
  });
  assert.match(prompt, /状态徽章是这位伙伴此刻的「样子」/);
  assert.match(prompt, /不要把活动标题、具体任务、narrative 或它们的近义改写塞进 statusText/);
  assert.match(prompt, /不超过8字的 statusText/);
  assert.match(prompt, /重做闲不住状态池/);
  assert.match(prompt, /"mode":"activity"/);
});

test("自主状态提示：空闲时可按性格自选，也可以留白", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "hanako",
    partnerName: "小花",
    config: {
      temperamentSource: "llm",
      surfaceLayer: { tag: "温柔", params: { style: "细腻自然" } },
      innerLayer: { tag: "敏感", params: { style: "会把小事放在心里" } },
    },
    context: { moodText: "心情不错", energyText: "精力充沛" },
    activity: {},
    catalog: {
      publicStatuses: [{ id: "leisurely", text: "悠哉哉", icon: "🌿", category: "日常", tone: "mint", group: "leisure" }],
    },
  });
  assert.match(prompt, /"mode":"idle"/);
  assert.match(prompt, /personalitySnapshot/);
  assert.match(prompt, /unlocked/);
  assert.match(prompt, /悠哉哉/);
  assert.match(prompt, /如果 currentStatus 仍合适就 keep/);
  assert.match(prompt, /不要为了填满展板/);
});

test("自主状态提示：未解锁高级状态不进入候选列表", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "hanako",
    partnerName: "小花",
    activity: { conversationTitle: "整理状态池" },
    catalog: {
      publicStatuses: [
        { id: "brain-meeting", text: "脑内开会", icon: "🧠", category: "整活", tone: "rose", group: "fun", unlocked: false },
        { id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", group: "work", unlocked: true },
      ],
    },
  });
  assert.match(prompt, /quiet-work/);
  assert.doesNotMatch(prompt, /brain-meeting/);
});

test("自主状态：候选列表按伙伴解锁资格隔离", async () => {
  const now = new Date(`${todayStr()}T12:03:00+08:00`).getTime();
  const data = baseData();
  data.partnerConfig.hanako.unlockedStatuses = ["brain-meeting"];
  data.partnerConfig.other = {
    name: "另一位伙伴",
    variables: { energy: 70, mood: 65, affection: 20 },
  };
  writeData(data);
  const prompts = new Map();
  const result = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: async (input, candidate) => {
      prompts.set(candidate.partnerId, input.messages[0].content);
      return '{"action":"keep"}';
    },
  });

  assert.equal(result.checked, 2);
  assert.match(prompts.get("hanako"), /brain-meeting/);
  assert.doesNotMatch(prompts.get("other"), /brain-meeting/);
});

test("自主状态：空闲时伙伴可以自己选长期状态", async () => {
  const now = new Date(`${todayStr()}T12:04:00+08:00`).getTime();
  const data = baseData();
  data.partnerConfig.hanako.temperamentSource = "llm";
  data.partnerConfig.hanako.surfaceLayer = { tag: "温柔", params: { style: "细腻自然" } };
  data.partnerConfig.hanako.innerLayer = { tag: "敏感", params: { style: "会把小事放在心里" } };
  writeData(data);
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning(
      '{"action":"update","statusId":"leisurely","duration":"until_changed","trigger":"idle"}',
      calls,
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.status.text, "悠哉哉");
  assert.equal(result.status.source, "autonomous");
  assert.equal(result.status.duration, "until_changed");
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /"mode":"idle"/);
  assert.match(calls[0].messages[0].content, /"trigger":"idle"/);

  const saved = readData();
  const partnerDay = saved.days[todayStr()].partners.hanako;
  assert.equal(partnerDay.status.text, "悠哉哉");
  assert.equal(partnerDay.status.duration, "until_changed");
  assert.equal(partnerDay.statusHistory.at(-1).trigger, "idle");
});

test("自主状态：未解锁高级状态不能自动使用", async () => {
  const now = new Date(`${todayStr()}T12:05:00+08:00`).getTime();
  writeData(baseData());
  const result = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: async () => '{"action":"update","statusId":"brain-meeting","duration":"four_hours","trigger":"idle"}',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "这条状态还没解锁，请先去装饰商店的状态收藏看看");
  const saved = readData();
  assert.equal(saved.days?.[todayStr()]?.partners?.hanako?.status, undefined);
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "rejected");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 0, "业务拒绝不能计入模型失败退避");
  assert.equal(
    Date.parse(saved.partnerConfig.hanako.statusAutonomy.nextCheckAt),
    now + STATUS_AUTONOMY_KEEP_IDLE_INTERVAL_MS,
    "业务拒绝应按空闲无变化节流，而不是几分钟后重复空转",
  );
});

test("自主状态：空闲时没有个体表达也可以保持空白", async () => {
  const now = new Date(`${todayStr()}T12:06:00+08:00`).getTime();
  writeData(baseData());
  const result = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: async () => '{"action":"keep"}',
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "keep");
  const saved = readData();
  assert.equal(saved.days[todayStr()]?.partners?.hanako?.status, undefined);
  assert.equal(getCurrentStatus(saved, "hanako", now).source, "baseline");
});

test("自主状态：按伙伴活动事实调用后台模型，并以 autonomous 来源落盘", async () => {
  const now = new Date(`${todayStr()}T12:00:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {
      hanako: { title: "把状态判断从主对话挪到闲不住" },
    },
    autonomousStatusSampler: samplerReturning(
      '{"action":"update","statusText":"专注","icon":"🧭","category":"做事","duration":"four_hours","trigger":"activity"}',
      calls,
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.status.source, "autonomous");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "hanako");
  assert.equal(calls[0].operation, "work-visit-autonomous-status");
  assert.match(calls[0].messages[0].content, /activityFacts/);
  assert.match(calls[0].messages[0].content, /把状态判断从主对话挪到闲不住/);
  assert.match(calls[0].messages[0].content, /statusText/);
  assert.match(calls[0].messages[0].content, /展板另有「正在做什么」一行单独显示/);
  assert.match(calls[0].messages[0].content, /没有新的表达价值不硬换/);

  const saved = readData();
  const partnerDay = saved.days[todayStr()].partners.hanako;
  assert.equal(partnerDay.status.text, "专注");
  assert.equal(partnerDay.status.source, "autonomous");
  assert.equal(partnerDay.status.duration, "four_hours");
  assert.equal(partnerDay.statusHistory.at(-1).source, "autonomous");
  assert.equal(partnerDay.statusHistory.at(-1).trigger, "activity");
  assert.equal(saved.partnerConfig.hanako.customStatuses.length, 0, "自动短句不应污染状态衣柜");
  assert.equal(typeof saved.partnerConfig.hanako.statusAutonomy.lastActivityFingerprint, "string");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "update");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 0);
});

test("自主状态：没有测试采样器时使用闲不住配置的专用模型，不回退总线", async () => {
  const now = new Date(`${todayStr()}T12:08:00+08:00`).getTime();
  const data = baseData();
  data.llmConfig = { providerId: "command code", modelId: "deepseek/deepseek-v4-flash" };
  writeData(data);
  fs.writeFileSync(path.join(home, "provider-catalog.json"), JSON.stringify({
    providers: {
      "command code": {
        api_key: "test-key",
        base_url: "https://status.test/v1",
        api: "openai-completions",
        models: ["deepseek/deepseek-v4-flash"],
      },
    },
  }), "utf8");

  const originalFetch = global.fetch;
  let request = null;
  let busCalled = false;
  global.fetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: '{"action":"update","statusText":"把手头线头理顺","icon":"📝","category":"做事","duration":"four_hours","trigger":"activity"}',
            },
          }],
        };
      },
    };
  };
  try {
    const result = await runAutonomousStatusTick({
      bus: { request: async () => { busCalled = true; throw new Error("不应走总线"); } },
    }, {
      now,
      activitySnapshot: { hanako: { title: "状态模型职责重构" } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "update");
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(busCalled, false);
  assert.equal(request.url, "https://status.test/v1/chat/completions");
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.match(body.messages[0].content, /状态模型职责重构/);
  assert.match(body.messages[0].content, /activityFacts/);
});

test("自主状态：活动事实变化后可提前进入下一次状态判断", async () => {
  const firstAt = new Date(`${todayStr()}T12:12:00+08:00`).getTime();
  writeData(baseData());
  await runAutonomousStatusTick({}, {
    now: firstAt,
    activitySnapshot: { hanako: { title: "先整理接口" } },
    autonomousStatusSampler: async () => '{"action":"update","statusText":"先把接口理顺","category":"做事"}',
  });

  const calls = [];
  const second = await runAutonomousStatusTick({}, {
    now: firstAt + STATUS_AUTONOMY_INTERVAL_MS + 1,
    activitySnapshot: { hanako: { title: "再检查边界" } },
    autonomousStatusSampler: async (input, candidate) => {
      calls.push({ input, candidate });
      return '{"action":"update","statusText":"转去检查边界","category":"做事"}';
    },
  });
  assert.equal(second.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidate.context.reason, "activity-change");
  assert.equal(calls[0].candidate.context.activityChanged, true);
  assert.equal(calls[0].candidate.activity.conversationTitle, "再检查边界");
  assert.equal(readData().partnerConfig.hanako.statusAutonomy.lastReason, "activity-change");
});

test("自主状态：没有专用模型时只跳过，不把总线当主模型兜底", async () => {
  const now = new Date(`${todayStr()}T12:10:00+08:00`).getTime();
  writeData(baseData());
  let busCalled = false;
  const result = await runAutonomousStatusTick({
    bus: { request: async () => { busCalled = true; } },
  }, { now });
  assert.equal(result.skipped, "model-config");
  assert.equal(result.checked, 0);
  assert.equal(busCalled, false);
});

test("自主状态：同一轮并发询问所有可见伙伴，各自决定更新/保持/清除", async () => {
  const now = new Date(`${todayStr()}T12:15:00+08:00`).getTime();
  writeData(multiPartnerData(now));
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async (input, candidate) => {
      calls.push(input.agentId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      if (candidate.partnerId === "hanako") return '{"action":"update","statusId":"inspiration"}';
      if (candidate.partnerId === "helperA") return '{"action":"keep"}';
      return '{"action":"clear"}';
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.checked, 3);
  assert.equal(result.results.length, 3);
  assert.equal(maxActive, 3, "三位可见伙伴应该在同一轮同时进入自检");
  assert.deepEqual(calls.sort(), ["hanako", "helperA", "helperB"]);

  const saved = readData();
  assert.equal(saved.days[todayStr()].partners.hanako.status.text, "灵感");
  assert.equal(saved.days[todayStr()].partners.helperA?.status, undefined);
  assert.equal(saved.days[todayStr()].partners.helperA?.statusHistory, undefined);
  assert.equal(saved.days[todayStr()].partners.helperB.status, undefined);
  assert.equal(saved.days[todayStr()].partners.helperB.statusHistory.length, 1, "清除不应抹掉旧历史");
  assert.equal(saved.partnerConfig.hiddenHelper.statusAutonomy, undefined);
});

test("自主状态：重叠心跳不会重复领取同一批伙伴", async () => {
  const now = new Date(`${todayStr()}T12:30:00+08:00`).getTime();
  writeData(multiPartnerData(now));
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async (input) => {
      calls.push(input.agentId);
      await gate;
      return '{"action":"keep"}';
    },
  });
  while (calls.length < 3) await new Promise((resolve) => setTimeout(resolve, 0));

  const second = await runAutonomousStatusTick({}, {
    now: now + 1000,
    autonomousStatusSampler: async () => '{"action":"update","statusId":"inspiration"}',
  });
  assert.equal(second.skipped, "not-due");
  assert.equal(calls.length, 3);

  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.checked, 3);
});

test("自主状态：一位伙伴模型失败不阻断其他伙伴完成自己的决定", async () => {
  const now = new Date(`${todayStr()}T12:45:00+08:00`).getTime();
  writeData(multiPartnerData(now));
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async (input, candidate) => {
      calls.push(input.agentId);
      if (candidate.partnerId === "helperA") throw new Error("helperA 通道暂时不可用");
      if (candidate.partnerId === "hanako") return '{"action":"update","statusId":"quiet-work"}';
      return '{"action":"keep"}';
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checked, 3);
  assert.deepEqual(calls.sort(), ["hanako", "helperA", "helperB"]);
  const saved = readData();
  assert.equal(saved.days[todayStr()].partners.hanako.status.text, "专注");
  assert.equal(saved.days[todayStr()].partners.helperB.status.text, "安静做事中");
  assert.equal(saved.partnerConfig.helperA.statusAutonomy.failureCount, 1);
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "update");
  assert.equal(saved.partnerConfig.helperB.statusAutonomy.lastResult, "keep");
});

test("自主状态：模型回包期间达到每日上限时，旧决定不会绕过节流", async () => {
  const now = new Date(`${todayStr()}T12:30:00+08:00`).getTime();
  writeData(baseData());
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async () => {
      const data = loadData();
      data.days[todayStr()] = {
        date: todayStr(),
        partners: {
          hanako: {
            contributed: false,
            narrative: "",
            effortLP: 0,
            statusHistory: [0, 1, 2, 3, 4].map((index) => ({
              id: `old-${index}`,
              text: `旧状态${index}`,
              setAt: nowISO(now - (120 + index) * 60 * 1000),
              moodBand: "steady",
              energyBand: "normal",
            })),
          },
        },
      };
      saveData(data);
      return '{"action":"update","statusId":"inspiration"}';
    },
  });
  assert.equal(result.ok, false);
  const saved = readData();
  assert.equal(saved.days[todayStr()].partners.hanako.status, undefined);
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "failed");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 1);
});

test("自主状态：新生活日不被前一天的失败退避挡住首次判断", async () => {
  const now = new Date(`${todayStr()}T09:00:00+08:00`).getTime();
  const data = baseData();
  data.partnerConfig.hanako.statusAutonomy = {
    lastCheckedAt: nowISO(now - 24 * 60 * 60 * 1000),
    nextCheckAt: nowISO(now + 3 * 60 * 60 * 1000),
    failureCount: 5,
    lastResult: "failed",
  };
  writeData(data);
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration"}', calls),
  });
  assert.equal(result.action, "update");
  assert.equal(calls.length, 1, "新的一天应重新判断一次，不应被昨日退避挡住");

  const cleared = baseData();
  cleared.days[todayStr()] = {
    date: todayStr(),
    partners: { hanako: { contributed: false, narrative: "", effortLP: 0, statusClearedAt: nowISO(now) } },
  };
  cleared.partnerConfig.hanako.statusAutonomy = {
    lastCheckedAt: nowISO(now - 24 * 60 * 60 * 1000),
    nextCheckAt: nowISO(now + 3 * 60 * 60 * 1000),
  };
  writeData(cleared);
  const afterClear = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration"}', calls),
  });
  assert.equal(afterClear.skipped, "not-due", "手动清除后的伙伴不能被新日补检重新挂回状态");
  assert.equal(calls.length, 1);
});

test("自主状态：90分钟内不重复调用，常态状态仍受4小时 routine 门槛保护", async () => {
  const now = new Date(`${todayStr()}T13:00:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  const first = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"quiet-work"}', calls),
  });
  assert.equal(first.action, "update");

  const tooSoon = await runAutonomousStatusTick({}, {
    now: now + 30 * 60 * 1000,
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(tooSoon.skipped, "not-due");
  assert.equal(calls.length, 1);

  const routineTooSoon = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 1,
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(routineTooSoon.skipped, "not-due");
  assert.equal(calls.length, 1);

  const routineDue = await runAutonomousStatusTick({}, {
    now: now + 4 * 60 * 60 * 1000 + 1,
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(routineDue.action, "keep");
  assert.equal(calls.length, 2);
});

test("自主状态：重复挂同一状态也按无变化走长节流", async () => {
  const now = new Date(`${todayStr()}T13:30:00+08:00`).getTime();
  const data = baseData();
  data.days[todayStr()] = {
    date: todayStr(),
    partners: {
      hanako: {
        contributed: false,
        narrative: "",
        effortLP: 0,
        status: {
          id: "quiet-work",
          text: "专注",
          icon: "📝",
          category: "做事",
          tone: "focus",
          scope: "public",
          duration: "today",
          setAt: nowISO(now - STATUS_ROUTINE_INTERVAL_MS),
          expiresAt: null,
          source: "autonomous",
        },
        statusHistory: [{
          id: "quiet-work",
          text: "专注",
          icon: "📝",
          category: "做事",
          tone: "focus",
          scope: "public",
          duration: "today",
          setAt: nowISO(now - STATUS_ROUTINE_INTERVAL_MS),
          source: "autonomous",
          trigger: "idle",
          moodBand: "bright",
          energyBand: "high",
        }],
      },
    },
  };
  writeData(data);
  const calls = [];
  const unchanged = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"quiet-work"}', calls),
  });
  assert.equal(unchanged.action, "unchanged");
  assert.equal(calls.length, 1);
  assert.equal(
    readData().partnerConfig.hanako.statusAutonomy.nextCheckAt,
    nowISO(now + STATUS_ROUTINE_INTERVAL_MS),
  );

  const tooSoon = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 1,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(tooSoon.skipped, "not-due");
  assert.equal(calls.length, 1);

  const newActivity = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 2,
    activitySnapshot: { hanako: { title: "刚开始聊天" } },
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(newActivity.action, "keep");
  assert.equal(calls.length, 2, "新活动仍应打断 unchanged 后的长节流");
});

test("自主状态：保持不写历史，失败按退避重试而不是每分钟撞模型", async () => {
  const now = new Date(`${todayStr()}T14:00:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  const kept = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(kept.action, "keep");
  let saved = readData();
  assert.equal(saved.days[todayStr()]?.partners?.hanako?.statusHistory, undefined);
  assert.equal(getCurrentStatus(saved, "hanako", now).source, "baseline");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "keep");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.nextCheckAt, nowISO(now + STATUS_AUTONOMY_KEEP_IDLE_INTERVAL_MS));
  assert.equal(typeof saved.partnerConfig.hanako.statusAutonomy.lastSignalFingerprint, "string");

  const beforeFailure = now + STATUS_AUTONOMY_INTERVAL_MS + 1;
  writeData(baseData());
  const failed = await runAutonomousStatusTick({}, {
    now: beforeFailure,
    autonomousStatusSampler: samplerReturning("模型只说了一句普通话，没有 JSON", calls),
  });
  assert.equal(failed.ok, false);
  assert.equal(calls.length, 2);
  saved = readData();
  assert.equal(getCurrentStatus(saved, "hanako", beforeFailure).source, "baseline");
  const autonomy = saved.partnerConfig.hanako.statusAutonomy;
  assert.equal(autonomy.failureCount, 1);
  assert.equal(Date.parse(autonomy.nextCheckAt), beforeFailure + STATUS_AUTONOMY_FAILURE_DELAYS_MS[0]);

  writeData(baseData());
  const hallucinated = await runAutonomousStatusTick({}, {
    now: beforeFailure + 1,
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"not-in-rack"}', calls),
  });
  assert.equal(hallucinated.ok, false);
  saved = readData();
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 0, "衣柜外状态 ID 属于业务拒绝，不应计入模型失败");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "rejected");
  assert.equal(
    Date.parse(saved.partnerConfig.hanako.statusAutonomy.nextCheckAt),
    beforeFailure + 1 + STATUS_AUTONOMY_KEEP_IDLE_INTERVAL_MS,
  );

  const notYet = await runAutonomousStatusTick({}, {
    now: beforeFailure + STATUS_AUTONOMY_FAILURE_DELAYS_MS[0] - 1,
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(notYet.skipped, "not-due");
  assert.equal(calls.length, 3);
});

test("自主状态：keep 后没有新信号不重复询问，但新活动可提前打断长节流", async () => {
  const now = new Date(`${todayStr()}T14:10:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  const first = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(first.action, "keep");
  assert.equal(calls.length, 1);

  const sameContext = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 1,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration"}', calls),
  });
  assert.equal(sameContext.skipped, "not-due");
  assert.equal(calls.length, 1, "keep 后没有新信号时不应按 90 分钟重复询问");

  const changedActivity = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 2,
    activitySnapshot: { hanako: { title: "开始处理新事情" } },
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration","trigger":"activity"}', calls),
  });
  assert.equal(changedActivity.action, "update");
  assert.equal(calls.length, 2, "新活动应在最短间隔后打断 keep 的长节流");
});

test("自主状态：keep 后同一事件不重复触发，新事件仍可唤醒判断", async () => {
  const now = new Date(`${todayStr()}T14:20:00+08:00`).getTime();
  const data = baseData();
  data.days[todayStr()] = {
    date: todayStr(),
    partners: {
      hanako: {
        contributed: false,
        narrative: "",
        effortLP: 0,
        events: [{ type: "gift", itemName: "一杯茶", ts: nowISO(now) }],
      },
    },
  };
  writeData(data);
  const calls = [];
  const first = await runAutonomousStatusTick({}, {
    now,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(first.action, "keep");

  const sameEvent = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 1,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration"}', calls),
  });
  assert.equal(sameEvent.skipped, "not-due");
  assert.equal(calls.length, 1, "同一条旧事件不能反复打断 keep 节流");

  const changed = readData();
  changed.days[todayStr()].partners.hanako.events.push({
    type: "gift",
    itemName: "一束花",
    ts: nowISO(now + STATUS_AUTONOMY_INTERVAL_MS + 2),
  });
  writeData(changed);
  const newEvent = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS + 2,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration","trigger":"event"}', calls),
  });
  assert.equal(newEvent.action, "update");
  assert.equal(calls.length, 2, "新事件应在最短间隔后唤醒判断");
});

test("自主状态：空闲 keep 在 24 小时内只检查一次，下一生活日再恢复判断", async () => {
  const start = new Date(`${todayStr()}T00:00:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  for (let index = 0; index < 16; index += 1) {
    const result = await runAutonomousStatusTick({}, {
      now: start + index * STATUS_AUTONOMY_INTERVAL_MS,
      activitySnapshot: {},
      autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
    });
    if (index === 0) assert.equal(result.action, "keep");
    else assert.equal(result.skipped, "not-due");
  }
  assert.equal(calls.length, 1, "同一天无新信号时不应每 90 分钟重复询问");

  const nextDay = await runAutonomousStatusTick({}, {
    now: start + STATUS_AUTONOMY_KEEP_IDLE_INTERVAL_MS + 1,
    activitySnapshot: {},
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(nextDay.action, "keep");
  assert.equal(calls.length, 2, "下一生活日仍应重新判断一次");
});

test("自主状态：后台模型失败和悬挂都有超时退避，过期 claim 可以被下一轮取回", async () => {
  const now = new Date(`${todayStr()}T14:30:00+08:00`).getTime();
  const data = baseData();
  data.partnerConfig.hanako.statusAutonomy = {
    checkingAt: nowISO(now - STATUS_AUTONOMY_CHECK_TIMEOUT_MS - 1),
    claimId: "old-claim",
  };
  writeData(data);
  const rejected = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async () => {
      throw new Error("闲不住状态模型暂时不可用");
    },
  });
  assert.equal(rejected.ok, false);
  let saved = readData();
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 1);

  writeData(baseData());
  const startedAt = Date.now();
  const timeout = await runAutonomousStatusTick({}, {
    now: now + STATUS_AUTONOMY_INTERVAL_MS,
    timeoutMs: 10,
    autonomousStatusSampler: async () => new Promise(() => {}),
  });
  assert.equal(timeout.ok, false);
  assert.ok(Date.now() - startedAt < 1000, "悬挂的模型调用必须被插件自己的超时护栏释放");
  saved = readData();
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 1);
});

test("自主状态：每日上限和隐藏伙伴都不会触发后台模型调用", async () => {
  const now = new Date(`${todayStr()}T15:00:00+08:00`).getTime();
  const data = baseData();
  const old = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  data.days[todayStr()] = {
    date: todayStr(),
    partners: {
      hanako: {
        contributed: false,
        narrative: "",
        effortLP: 0,
        statusHistory: [0, 1, 2, 3, 4].map((index) => ({
          id: `status-${index}`,
          text: `状态${index}`,
          setAt: old(120 + index),
          moodBand: "steady",
          energyBand: "normal",
        })),
      },
    },
  };
  data.partnerConfig.hanako.hidden = true;
  writeData(data);
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration"}', calls),
  });
  assert.equal(result.skipped, "not-due");
  assert.equal(calls.length, 0);
});

test("自主状态：设置关闭时跳过后台判断且不写入状态", async () => {
  const data = baseData();
  data.statusSettings = { autonomousEnabled: false };
  writeData(data);
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now: new Date(`${todayStr()}T16:00:00+08:00`).getTime(),
    autonomousStatusSampler: samplerReturning('{"action":"update","statusId":"inspiration"}', calls),
  });
  assert.equal(result.skipped, "disabled");
  assert.equal(calls.length, 0);
  assert.equal(readData().partnerConfig.hanako.statusAutonomy, undefined);

  const enabledData = readData();
  enabledData.statusSettings = { autonomousEnabled: true };
  writeData(enabledData);
  const resumed = await runAutonomousStatusTick({}, {
    now: new Date(`${todayStr()}T17:40:00+08:00`).getTime(),
    autonomousStatusSampler: samplerReturning('{"action":"keep"}', calls),
  });
  assert.equal(resumed.action, "keep");
  assert.equal(calls.length, 1, "重新开启后应恢复后台状态判断");
});

test("状态开关：模型请求期间关闭也不会应用旧回包", async () => {
  const now = new Date(`${todayStr()}T16:10:00+08:00`).getTime();
  writeData(baseData());
  let entered = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async () => {
      entered = true;
      await gate;
      return '{"action":"update","statusId":"inspiration"}';
    },
  });
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  const data = readData();
  data.statusSettings = { autonomousEnabled: false };
  writeData(data);
  release();

  const result = await pending;
  assert.equal(result.skipped, "disabled");
  assert.equal(readData().partnerConfig.hanako.status, undefined);
  assert.equal(getCurrentStatus(readData(), "hanako").source, "baseline");
});

test("心跳接入：没有心意计划待办时，伙伴自主状态仍会单独自检", async () => {
  const now = new Date(`${todayStr()}T16:00:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  await runHeartbeatTick({}, {
    now,
    date: todayStr(),
    autonomousStatusSampler: async (input) => {
      calls.push(input);
      return { text: '{"action":"keep"}' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "hanako");
  assert.match(calls[0].messages[0].content, /activityFacts/);
});

test("自主状态：空返回时同轮用精简提示词重试一次，成功后不再进退避", async () => {
  const now = new Date(`${todayStr()}T14:40:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  let attempt = 0;
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async (input, candidate, sampleOptions) => {
      calls.push({ lean: sampleOptions?.lean === true, content: input.messages[0].content });
      attempt += 1;
      // 第一次模拟思考型网关空返回（正文被推理吃光），第二次给有效 JSON
      if (attempt === 1) return "";
      return '{"action":"update","statusId":"inspiration","duration":"four_hours","trigger":"mood"}';
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(calls.length, 2, "空返回应触发一次同轮精简重试");
  assert.equal(calls[0].lean, false, "首次用完整提示词");
  assert.equal(calls[1].lean, true, "重试用精简提示词");
  assert.ok(calls[1].content.length < calls[0].content.length, "精简提示词应明显更短");
  const saved = readData();
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "update");
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 0, "重试成功后不应记录失败");
});

test("自主状态：连续两次空返回才记录失败退避，不会无限重试", async () => {
  const now = new Date(`${todayStr()}T14:45:00+08:00`).getTime();
  writeData(baseData());
  const calls = [];
  const result = await runAutonomousStatusTick({}, {
    now,
    autonomousStatusSampler: async (input, candidate, sampleOptions) => {
      calls.push(sampleOptions?.lean === true);
      return ""; // 一直空返回
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2, "只重试一次，不会无限撞模型");
  const saved = readData();
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.failureCount, 1);
  assert.equal(saved.partnerConfig.hanako.statusAutonomy.lastResult, "failed");
});

test("自主状态提示：仅被派活时进入 delegated 模式，引导活人感而非一律专注", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "yunying",
    partnerName: "伙伴甲",
    activity: { delegatedTask: "请独立审查闲不住状态池", dispatchedBy: "hanako" },
    catalog: {
      publicStatuses: [
        { id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", group: "work" },
        { id: "forced-work", text: "被迫营业", icon: "🎪", category: "日常", tone: "rose", group: "mood-work", unlocked: true },
      ],
    },
  });
  assert.match(prompt, /"mode":"delegated"/);
  assert.match(prompt, /她只是被派了活/);
  assert.match(prompt, /带软负面可爱感的词/);
  assert.match(prompt, /不要因为「在忙」就都挂专注/);
  // 只有 conversationTitle/narrative 才算真实活动，delegatedTask 不该把它顶成 activity
  assert.doesNotMatch(prompt, /"mode":"activity"/);
});

test("自主状态提示：availableStatuses 按场景下发子集，不含无关分组", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "hanako",
    partnerName: "小花",
    activity: { conversationTitle: "正在重构状态池" },
    catalog: {
      publicStatuses: [
        { id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", group: "work" },
        { id: "cuddly", text: "贴贴", icon: "🫂", category: "陪伴", tone: "mint", group: "company" },
        { id: "dozing", text: "打盹", icon: "😴", category: "日常", tone: "quiet", group: "leisure" },
        { id: "excited", text: "雀跃", icon: "✨", category: "心情", tone: "rose", group: "mood" },
      ],
    },
  });
  // activity 场景：下发 work/mood-work/fun，不发 leisure/company/mood
  assert.match(prompt, /quiet-work/);
  assert.doesNotMatch(prompt, /贴贴/);
  assert.doesNotMatch(prompt, /打盹/);
  assert.doesNotMatch(prompt, /雀跃/);
});

test("自主状态提示：boardStatuses 把展板现状喂给模型，排除自己", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "hanako",
    partnerName: "小花",
    boardStatuses: [
      { partnerId: "feiyue", text: "专注" },
      { partnerId: "yumi", text: "专注" },
      { partnerId: "hanako", text: "排除的自己不该出现" },
    ],
    activity: {},
    catalog: { publicStatuses: [{ id: "leisurely", text: "悠哉哉", icon: "🌿", category: "日常", tone: "mint", group: "leisure" }] },
  });
  assert.match(prompt, /展板上其他伙伴此刻挂着的状态/);
  assert.match(prompt, /feiyue/);
  assert.match(prompt, /yumi/);
  assert.doesNotMatch(prompt, /排除的自己不该出现/);
  assert.match(prompt, /尽量避开和大家撞同款/);
});

test("自主状态提示：同一状态占用达到上限时从可选池剔除，但不禁止前两人同款", () => {
  // 展板上已有 2 人挂“专注”（feiyue/yumi），第 3 人（yunying）可选池应剔除 quiet-work
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "yunying",
    partnerName: "伙伴甲",
    activity: { delegatedTask: "请独立审查状态池", dispatchedBy: "hanako" },
    boardStatuses: [
      { partnerId: "feiyue", id: "quiet-work", text: "专注" },
      { partnerId: "yumi", id: "quiet-work", text: "专注" },
      { partnerId: "yuzuki", id: "quiet-work", text: "专注" },
    ],
    catalog: {
      publicStatuses: [
        { id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", group: "work" },
        { id: "hengchi-hengchi", text: "吭哧吭哧", icon: "💪", category: "做事", tone: "focus", group: "work" },
        { id: "forced-work", text: "被迫营业", icon: "🎪", category: "日常", tone: "rose", group: "mood-work", unlocked: true },
        { id: "low-battery", text: "低电量", icon: "🔋", category: "日常", tone: "quiet", group: "mood-work" },
      ],
    },
  });
  // 占用已满 3 > 2：quiet-work 必须从可选列表剔除（模型看不见就选不了）
  assert.doesNotMatch(prompt, /"availableStatuses":\[\s*\{"id":"quiet-work"/);
  assert.doesNotMatch(prompt, /"availableStatuses":\[[^\]]*\{"id":"quiet-work"/);
  // 但提示词正文的示例 JSON 里仍允许出现 quiet-work（那是格式示例，不是候选）
  assert.match(prompt, /"action":"update","statusId":"quiet-work","duration":"four_hours"/);
  // 其他候选仍在
  assert.match(prompt, /hengchi-hengchi/);
  assert.match(prompt, /forced-work/);
  assert.match(prompt, /low-battery/);
});

test("自主状态提示：占用未到上限时仍保留同款候选，允许 1~2 人重样", () => {
  const prompt = buildAutonomousStatusPrompt({
    partnerId: "yunying",
    partnerName: "伙伴甲",
    activity: { delegatedTask: "请独立审查状态池", dispatchedBy: "hanako" },
    boardStatuses: [
      { partnerId: "feiyue", id: "quiet-work", text: "专注" },
    ],
    catalog: {
      publicStatuses: [
        { id: "quiet-work", text: "专注", icon: "📝", category: "做事", tone: "focus", group: "work" },
        { id: "hengchi-hengchi", text: "吭哧吭哧", icon: "💪", category: "做事", tone: "focus", group: "work" },
      ],
    },
  });
  // 只有 1 人占用 < 2：quiet-work 仍可选，不硬性禁止重样
  assert.match(prompt, /"availableStatuses":\[[^\]]*\{"id":"quiet-work"/);
  assert.match(prompt, /hengchi-hengchi/);
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
