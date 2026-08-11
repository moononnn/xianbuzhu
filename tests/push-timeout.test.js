// 闲不住 — 锁内推送超时回归测试（群友反馈「送礼卡住、大部分操作没反应」的根因防线）
// 覆盖：bus.request 挂起（Hana 主进程不响应）时——
//   1) pushToAgent 总超时兜底，返回 false 不抛错
//   2) 怪话路径推送挂起后，数据写锁按时释放，后续送礼正常
//   3) 关机键 abort/send 挂起后，数据写锁按时释放，后续操作正常
// 运行：node --test tests/push-timeout.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-push-timeout-"));
process.env.HANA_HOME = tmp;

const { performVisit, pushToAgent } = await import(
  "../lib/actions.js?v=" + Date.now()
);

function writeData(overrides) {
  const data = {
    jar: 100,
    llmConfig: { providerId: "test", modelId: "test" },
    partnerConfig: {
      hanako: { name: "小花", variables: { mood: 60, affection: 10 } },
    },
    pendingVisits: [],
    shopItems: [{ id: "coffee", name: "咖啡", icon: "☕", price: 25 }],
    interactItems: [{ id: "quiet", name: "安安静静在旁边陪着", icon: "🍵" }],
    prankItems: [
      { id: "unplug", name: "悄咪咪按下关机键", icon: "🔌" },
      { id: "brainrot", name: "冷不丁说句怪话", icon: "🧠" },
    ],
    ...overrides,
  };
  const dir = path.join(tmp, "data", "work-visit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data), "utf-8");
}

// 构造会话文件：findLatestSessionPath 需要 sessions 目录下存在 .jsonl。
// 内容里故意先放一条 subagent 直连会话的 sess_xxx（模拟桌面会话 JSONL 中
// 的委派记录污染），旧版正则解析会命中它导致推送目标错误——现在推送直接
// 传 sessionPath，内容里的任何 sess_xxx 都不再参与目标解析。
function writeSessionFile() {
  const sessDir = path.join(tmp, "agents", "hanako", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, "2026-08-11T00-00-00-000Z_test.jsonl"),
    "sess_subagent_abc123def456\n" +
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hi", timestamp: Date.now() },
      }) +
      "\n",
    "utf-8",
  );
}

// mock bus：request 永不 resolve（模拟 Hana 主进程不响应），并记录调用
function hangBus() {
  const calls = [];
  return {
    calls,
    bus: {
      request: async (topic, payload) => {
        calls.push({ topic, payload });
        return new Promise(() => {}); // 永远挂起
      },
    },
  };
}

test("pushToAgent: bus.request 挂起时总超时兜底，返回 false 不抛错", async () => {
  writeData();
  writeSessionFile();
  const { bus, calls } = hangBus();
  const start = Date.now();
  const ok = await pushToAgent("hanako", "hi", bus, 300, 200);
  const elapsed = Date.now() - start;
  assert.equal(ok, false, "推送挂起超时应返回 false");
  assert.ok(elapsed < 2000, `应在超时后尽快返回（实际 ${elapsed}ms）`);
  assert.equal(calls.length, 1, "应发起一次 session:send");
  assert.equal(calls[0].topic, "session:send");
  assert.match(
    calls[0].payload.sessionPath,
    /agents[\\\/]hanako[\\\/]sessions[\\\/]/,
    "推送目标必须是桌面会话路径，不被文件内容里的 subagent sess_xxx 污染",
  );
});

test("performVisit: 怪话推送挂起超时后返回成功，锁释放，后续送礼正常", async () => {
  writeData();
  writeSessionFile();
  const { bus } = hangBus();

  // 怪话：generateBrainrot 在无 provider 配置时走兜底文案（不卡），
  // 锁内 await pushToAgent 会挂起 → 300ms 总超时 → 返回 false → 接口成功返回
  const start = Date.now();
  const r1 = await performVisit(
    { type: "prank", itemId: "brainrot", to: "hanako" },
    { bus, pushTimeoutMs: 300, busTimeoutMs: 200 },
  );
  const elapsed = Date.now() - start;
  assert.equal(r1.status, 200, "怪话推送失败也应成功返回（不阻塞）");
  assert.equal(r1.body.success, true);
  assert.equal(r1.body.injected, false, "推送失败时标记 injected=false");
  assert.ok(r1.body.brainrot, "应带怪话文本供前端展示");
  assert.ok(elapsed < 2000, `推送挂起不应拖住响应（实际 ${elapsed}ms）`);

  // 锁必须已释放：紧跟着的送礼要能正常完成
  const r2 = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus, pushTimeoutMs: 300, busTimeoutMs: 200 },
  );
  assert.equal(r2.status, 200, "送礼应正常执行（锁已释放）");
  // 100（初始） - 3（怪话已扣） - 25（礼物） + 3（回赠） = 75
  assert.equal(r2.body.jar, 75, "送礼扣价并回赠（含怪话已扣的 3 光粒）");
});

test("performVisit: 关机键 abort/send 挂起超时后仍返回成功，锁释放", async () => {
  writeData();
  writeSessionFile();
  const { bus, calls } = hangBus();

  const start = Date.now();
  const r1 = await performVisit(
    { type: "prank", itemId: "unplug", to: "hanako" },
    { bus, busTimeoutMs: 300 },
  );
  const elapsed = Date.now() - start;
  assert.equal(r1.status, 200, "abort/send 挂起超时后关机键也应成功返回");
  assert.equal(r1.body.jar, 95, "关机键扣 5 光粒");
  assert.equal(
    calls.filter((c) => c.topic === "session:abort").length,
    1,
    "应发起一次 session:abort",
  );
  assert.equal(
    calls.filter((c) => c.topic === "session:send").length,
    0,
    "abort 超时后放弃 send（快速释放锁，不继续尝试）",
  );
  assert.ok(elapsed < 2000, `abort/send 挂起不应无限拖住（实际 ${elapsed}ms）`);

  // 锁必须已释放
  const r2 = await performVisit(
    { type: "gift", itemId: "coffee", to: "hanako" },
    { bus, busTimeoutMs: 300 },
  );
  assert.equal(r2.status, 200, "关机键后送礼应正常执行（锁已释放）");
});
