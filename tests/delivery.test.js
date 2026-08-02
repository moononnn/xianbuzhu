// 闲不住 — v2.4.0 补投递队列 + 锁范围 + 超时链路的回归测试（node:test）
// 覆盖审查意见点名的两条最危险链路：
//  1. pushToAgent 失败时接口 pushed 是否真的为 false，事件是否进入补投递队列
//  2. 事件超时后旧任务是否绝对不会写数据
// 外加：投递状态迁移纯函数、阈值单一事实源
// 运行：node --test tests/delivery.test.js
// 注意：文件内共享固定 HANA_HOME（ESM 模块缓存：data.js 实例的 HANA_HOME 以首次加载为准）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHARED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wv-delivery-"));
process.env.HANA_HOME = SHARED_HOME;
const DATA_DIR = path.join(SHARED_HOME, "data", "work-visit");

function bjToday() {
  return new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10);
}

function writeData(extra = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "data.json"),
    JSON.stringify(
      Object.assign(
        {
          days: {},
          lastResetDate: bjToday(),
          jar: 1000,
          pendingVisits: [],
          llmConfig: { providerId: "testprov", modelId: "m" },
          partnerConfig: {
            hanako: {
              name: "小花",
              variables: { energy: 80, mood: 60, affection: 10 },
            },
          },
        },
        extra,
      ),
      "utf-8",
    ),
  );
}

function readData() {
  return JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "data.json"), "utf-8"),
  );
}

async function freshModule(relPath) {
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  return await import(relPath + "?v=" + stamp);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════
//  1. 投递状态迁移纯函数
// ════════════════════════════════════════════

test("投递状态: collectPendingDeliveries 只收集待投递且未放弃的", async () => {
  writeData({
    pendingVisits: [
      { id: 1, deliveryPending: true },
      { id: 2, deliveryPending: true, deliveryDropped: true },
      { id: 3 }, // 未标记
      { id: 4, deliveryPending: true },
    ],
  });
  const { collectPendingDeliveries } = await freshModule("../lib/data.js");
  const pend = collectPendingDeliveries(readData());
  assert.deepEqual(
    pend.map((v) => v.id),
    [1, 4],
    "只应收集 deliveryPending 且未 dropped 的事件",
  );
});

test("投递状态: markDelivered 清除标记并记录送达时间", async () => {
  writeData({
    pendingVisits: [{ id: 7, deliveryPending: true, deliveryAttempts: 3 }],
  });
  const { markDelivered } = await freshModule("../lib/data.js");
  const data = readData();
  assert.equal(markDelivered(data, 7), true);
  const v = data.pendingVisits[0];
  assert.equal(v.deliveryPending, false);
  assert.equal(v.deliveryDropped, false);
  assert.ok(v.deliveryDeliveredAt, "应记录送达时间");
  assert.equal(markDelivered(data, 999), false, "找不到的事件返回 false");
});

test("投递状态: markDeliveryFailed 计数，达上限标记放弃", async () => {
  writeData({
    pendingVisits: [{ id: 9, deliveryPending: true, deliveryAttempts: 0 }],
  });
  const { markDeliveryFailed } = await freshModule("../lib/data.js");
  const data = readData();
  // 未达上限：计数 +1，不放弃
  assert.equal(markDeliveryFailed(data, 9, 3), false);
  assert.equal(data.pendingVisits[0].deliveryAttempts, 1);
  assert.equal(data.pendingVisits[0].deliveryDropped, undefined);
  // 达上限：放弃
  markDeliveryFailed(data, 9, 3);
  assert.equal(markDeliveryFailed(data, 9, 3), true, "第 3 次达到上限应放弃");
  assert.equal(data.pendingVisits[0].deliveryDropped, true);
});

// ════════════════════════════════════════════
//  2. 接口级：推送失败时 pushed=false 且进入补投递队列
//     （审查意见点名：界面不再假成功，但失败事件要有真实出口）
// ════════════════════════════════════════════

test("/api/visit: 推送失败时 pushed=false，事件进入 deliveryPending", async () => {
  writeData();

  const routes = {};
  const app = {
    get: (p, h) => {
      routes[p] = h;
    },
    post: (p, h) => {
      routes[p] = h;
    },
  };
  // 无 bus、无 agents 目录 → pushToAgent 必然失败（bus 不可用）
  const { register } = await freshModule("../routes/api.js");
  await register(app, {});

  const c = {
    req: {
      json: async () => ({ type: "gift", itemId: "coffee", to: "hanako" }),
    },
  };
  const res = await routes["/api/visit"](c);
  const body = JSON.parse(await res.text());
  assert.equal(body.success, true);
  assert.equal(body.pushed, false, "推送失败时 pushed 必须是 false，不能假成功");

  // 等待异步 processVisitEvent 跑完（它只改变量，不影响 deliveryPending），
  // 避免残留异步写盘污染后续测试
  await sleep(300);

  const data = readData();
  const visit = data.pendingVisits.find((v) => v.id === body.visitId);
  assert.ok(visit, "事件应已记录");
  assert.equal(visit.deliveryPending, true, "推送失败的事件应进入补投递队列");
  assert.equal(data.jar, 1000 - 25 + 3, "光粒已扣并回礼（与旧行为一致）");
});

test("/api/visit: 光粒不足时返回失败且不生成补投递记录", async () => {
  writeData({ jar: 1 });

  const routes = {};
  const app = {
    get: (p, h) => {
      routes[p] = h;
    },
    post: (p, h) => {
      routes[p] = h;
    },
  };
  const { register } = await freshModule("../routes/api.js");
  await register(app, {});

  const c = {
    req: {
      json: async () => ({ type: "gift", itemId: "star", to: "hanako" }),
    },
  };
  const res = await routes["/api/visit"](c);
  const body = JSON.parse(await res.text());
  assert.equal(body.success, false);
  await sleep(100);
  const data = readData();
  assert.equal(data.pendingVisits.length, 0, "失败请求不应产生事件记录");
});

// ════════════════════════════════════════════
//  3. 补投递集成：retryPendingDeliveries 循环本身（成功/失败）
// ════════════════════════════════════════════

test("补投递: 重投成功时清除 deliveryPending 并记录送达时间", async () => {
  writeData({
    pendingVisits: [
      {
        id: 9001,
        type: "gift",
        itemId: "coffee",
        itemName: "咖啡",
        icon: "☕",
        price: 25,
        to: "hanako",
        from: "owner",
        createdAt: "2026-08-02T00:00:00+08:00",
        status: "completed",
        deliveryPending: true,
        deliveryAttempts: 0,
      },
    ],
  });
  // 构造会话文件，让 pushToAgent 能找到 sessionId（findLatestSessionId 优先读 jsonl）
  const sessDir = path.join(SHARED_HOME, "agents", "hanako", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, "2026-08-02.jsonl"),
    '{"sessionId":"sess_abc123_00000000000000000000000000000000","role":"user","content":"hi"}\n',
    "utf-8",
  );

  // mock bus：session:send 成功
  const mockBus = {
    request: async () => {
      return { ok: true };
    },
  };
  const routes = {};
  const app = {
    get: (p, h) => {
      routes[p] = h;
    },
    post: (p, h) => {
      routes[p] = h;
    },
  };
  const { register, retryPendingDeliveries } = await freshModule(
    "../routes/api.js",
  );
  await register(app, { bus: mockBus });

  await retryPendingDeliveries(false);

  const data = readData();
  const v = data.pendingVisits.find((x) => x.id === 9001);
  assert.equal(v.deliveryPending, false, "重投成功应清除标记");
  assert.ok(v.deliveryDeliveredAt, "应记录送达时间");
  assert.equal(v.deliveryAttempts, 0, "成功不应增加尝试次数");
});

test("补投递: 重投失败时尝试次数 +1，不达上限不放弃", async () => {
  writeData({
    pendingVisits: [
      {
        id: 9002,
        type: "interact",
        itemId: "hum",
        itemName: "闲来无事轻轻哼着歌",
        icon: "🎵",
        price: 0,
        to: "hanako",
        from: "owner",
        createdAt: "2026-08-02T00:00:00+08:00",
        status: "completed",
        deliveryPending: true,
        deliveryAttempts: 0,
      },
    ],
  });

  const routes = {};
  const app = {
    get: (p, h) => {
      routes[p] = h;
    },
    post: (p, h) => {
      routes[p] = h;
    },
  };
  // 无 bus → pushToAgent 失败
  const { register, retryPendingDeliveries } = await freshModule(
    "../routes/api.js",
  );
  await register(app, {});

  await retryPendingDeliveries(false);

  const data = readData();
  const v = data.pendingVisits.find((x) => x.id === 9002);
  assert.equal(v.deliveryPending, true, "失败后仍待投递");
  assert.equal(v.deliveryAttempts, 1, "失败应计数 +1");
  assert.equal(v.deliveryDropped, undefined, "未达上限不放弃");
});

// ════════════════════════════════════════════
//  4. 超时后旧任务不写盘（审查意见点名：事件超时后旧任务绝对不能写数据）
// ════════════════════════════════════════════

test("processVisitEventInternal: signal 已 abort 时直接返回，不写盘", async () => {
  writeData();
  const before = readData();

  const { processVisitEventInternal } = await freshModule("../lib/llm.js");
  await processVisitEventInternal(
    { id: 424242, type: "gift", itemId: "coffee" },
    "hanako",
    { aborted: true },
  );

  const after = readData();
  assert.deepEqual(
    after.pendingVisits,
    before.pendingVisits,
    "已超时事件不得写入任何数据",
  );
  assert.deepEqual(
    after.partnerConfig,
    before.partnerConfig,
    "已超时事件不得修改变量",
  );
});

test("generateAndSaveNote: signal 已 abort 时返回 null，不写纸条文件", async () => {
  writeData();

  const { generateAndSaveNote } = await freshModule("../lib/llm.js");
  const result = await generateAndSaveNote(
    { id: 515151, type: "gift", itemId: "coffee", itemName: "咖啡" },
    "hanako",
    { aborted: true },
  );
  assert.equal(result, null);
  const notesDir = path.join(DATA_DIR, "小纸条");
  assert.ok(!fs.existsSync(notesDir), "已超时任务不得创建纸条文件");
});

// ════════════════════════════════════════════
//  5. 阈值单一事实源：档位函数与描述函数一致，边界正确
// ════════════════════════════════════════════

test("阈值: getMoodLevel 边界与 describeMood 一致（80/65/40/25）", async () => {
  const { getMoodLevel, describeMood } = await freshModule("../lib/data.js");
  assert.equal(getMoodLevel(100).label, "心情很好");
  assert.equal(getMoodLevel(80).label, "心情很好");
  assert.equal(getMoodLevel(79).label, "心情不错");
  assert.equal(getMoodLevel(65).label, "心情不错");
  assert.equal(getMoodLevel(64).label, "心情平稳");
  assert.equal(getMoodLevel(40).label, "心情平稳");
  assert.equal(getMoodLevel(39).label, "有点闷");
  assert.equal(getMoodLevel(25).label, "有点闷");
  assert.equal(getMoodLevel(24).label, "心情很差");
  assert.equal(getMoodLevel(NaN).label, "心情很差", "非法值兜底最低档");
  for (const m of [100, 80, 79, 65, 64, 40, 39, 25, 24, 0]) {
    assert.equal(
      getMoodLevel(m).label,
      describeMood(m),
      `mood=${m} 档位函数与描述函数必须一致`,
    );
  }
  assert.ok(getMoodLevel(90).emoji, "档位应带 emoji 供前端使用");
});

test("阈值: getEnergyLevel 边界与 describeEnergy 一致（70/40/20）", async () => {
  const { getEnergyLevel, describeEnergy } = await freshModule("../lib/data.js");
  assert.equal(getEnergyLevel(70).cls, "good");
  assert.equal(getEnergyLevel(69).cls, "mid");
  assert.equal(getEnergyLevel(40).cls, "mid");
  assert.equal(getEnergyLevel(39).cls, "low");
  assert.equal(getEnergyLevel(20).cls, "low");
  assert.equal(getEnergyLevel(19).cls, "low");
  for (const e of [100, 70, 69, 40, 39, 20, 19, 0]) {
    assert.equal(
      getEnergyLevel(e).label,
      describeEnergy(e),
      `energy=${e} 档位函数与描述函数必须一致`,
    );
  }
});
