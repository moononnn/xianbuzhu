// 主动心意心跳：计划表和两道闸测试
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelHeartPlanForPartner,
  createHeartPlan,
  ensureDailyHeartPlan,
  evaluateDeliveryGates,
  HEART_RETRY_DELAYS_MS,
  isHeartEntryDue,
  isQuietHours,
  MAX_HEART_RETRIES,
  scheduleHeartRetry,
} from "../lib/heartbeat.js";

test("createHeartPlan: 低频每位助手最多一次，时间落在白天窗口", () => {
  const plan = createHeartPlan({
    date: "2026-08-18",
    frequency: "low",
    partners: {
      a: { variables: { affection: 0, mood: 60 } },
      b: { variables: { affection: 50, mood: 80 } },
    },
    random: () => 0,
  });
  assert.equal(plan.entries.length, 2);
  assert.equal(new Set(plan.entries.map((entry) => entry.partnerId)).size, 2);
  for (const entry of plan.entries) {
    const hour = new Date(entry.scheduledAt).getUTCHours() + 8;
    assert.ok(hour >= 8 && hour <= 22);
    assert.equal(entry.status, "planned");
  }
});

test("createHeartPlan: 隐藏助手不进计划，高频允许同日第二次机会", () => {
  const plan = createHeartPlan({
    date: "2026-08-18",
    frequency: "high",
    partners: {
      visible: { variables: { affection: 100, mood: 100 } },
      hidden: { hidden: true, variables: { affection: 100, mood: 100 } },
    },
    random: () => 0,
  });
  assert.ok(plan.entries.length >= 1);
  assert.ok(plan.entries.every((entry) => entry.partnerId === "visible"));
});

test("cancelHeartPlanForPartner: 隐藏助手时取消当天尚未送达的计划", () => {
  const data = {
    heartPlan: {
      entries: [
        { id: "planned", partnerId: "hidden", status: "planned" },
        { id: "retry", partnerId: "hidden", status: "retry_wait", nextAttemptAt: "2026-08-18T05:01:00.000Z" },
        { id: "generating", partnerId: "hidden", status: "generating" },
        { id: "delivered", partnerId: "hidden", status: "delivered" },
      ],
    },
  };
  assert.equal(cancelHeartPlanForPartner(data, "hidden", Date.parse("2026-08-18T05:00:00.000Z")), true);
  assert.equal(data.heartPlan.entries[0].status, "cancelled");
  assert.equal(data.heartPlan.entries[1].status, "cancelled");
  assert.equal(data.heartPlan.entries[2].status, "cancelled");
  assert.equal(data.heartPlan.entries[3].status, "delivered");
});

test("scheduleHeartRetry: 暂态失败按退避重试，耗尽后终止且保留原计划 ID", () => {
  const now = Date.parse("2026-08-18T05:00:00.000Z");
  const entry = { id: "heart-plan-1", partnerId: "hanako", status: "generating" };
  const transient = { kind: "transient_api", retryable: true };

  assert.equal(scheduleHeartRetry(entry, now, transient), "retry_wait");
  assert.equal(entry.id, "heart-plan-1");
  assert.equal(entry.retryCount, 1);
  assert.equal(Date.parse(entry.nextAttemptAt), now + HEART_RETRY_DELAYS_MS[0]);
  assert.equal(isHeartEntryDue(entry, now + HEART_RETRY_DELAYS_MS[0] - 1), false);
  assert.equal(isHeartEntryDue(entry, now + HEART_RETRY_DELAYS_MS[0]), true);

  let retryAt = Date.parse(entry.nextAttemptAt);
  assert.equal(scheduleHeartRetry(entry, retryAt, transient), "retry_wait");
  assert.equal(entry.retryCount, 2);
  assert.equal(Date.parse(entry.nextAttemptAt), retryAt + HEART_RETRY_DELAYS_MS[1]);

  retryAt = Date.parse(entry.nextAttemptAt);
  assert.equal(scheduleHeartRetry(entry, retryAt, transient), "retry_wait");
  assert.equal(entry.retryCount, 3);
  assert.equal(Date.parse(entry.nextAttemptAt), retryAt + HEART_RETRY_DELAYS_MS[2]);

  retryAt = Date.parse(entry.nextAttemptAt);
  assert.equal(scheduleHeartRetry(entry, retryAt, transient), "failed");
  assert.equal(entry.status, "failed");
  assert.equal(entry.retryExhausted, true);
  assert.equal(entry.failureKind, "transient_api");
  assert.equal(entry.retryCount, MAX_HEART_RETRIES);
});

test("scheduleHeartRetry: 配置类失败不重试", () => {
  const entry = { id: "heart-plan-config", status: "generating" };
  assert.equal(
    scheduleHeartRetry(entry, Date.parse("2026-08-18T05:00:00.000Z"), {
      kind: "model_not_configured",
      retryable: false,
    }),
    "failed",
  );
  assert.equal(entry.status, "failed");
  assert.equal(entry.retryCount, undefined);
  assert.equal(entry.nextAttemptAt, null);
  assert.equal(entry.retryExhausted, false);
});

test("scheduleHeartRetry: 内容失败只允许一轮整批重试", () => {
  const entry = { id: "heart-plan-content", status: "generating" };
  const firstAt = Date.parse("2026-08-18T05:00:00.000Z");
  const failure = { kind: "content_rejected", retryable: true, maxRetries: 1 };
  assert.equal(scheduleHeartRetry(entry, firstAt, failure), "retry_wait");
  assert.equal(entry.retryLimit, 1);
  assert.equal(scheduleHeartRetry(entry, Date.parse(entry.nextAttemptAt), failure), "failed");
  assert.equal(entry.retryExhausted, true);
  assert.equal(entry.retryCount, 1);
});

test("ensureDailyHeartPlan: 同一天同频率幂等，改频率才重滚", () => {
  const data = {
    heartSettings: { frequency: "low" },
    heartPlan: { date: null, frequency: "low", entries: [] },
    partnerConfig: { a: { variables: { affection: 0, mood: 60 } } },
  };
  assert.equal(ensureDailyHeartPlan(data, "2026-08-18", () => 0), true);
  const first = data.heartPlan;
  assert.equal(ensureDailyHeartPlan(data, "2026-08-18", () => 0.99), false);
  assert.equal(data.heartPlan, first);
  data.heartSettings.frequency = "medium";
  assert.equal(ensureDailyHeartPlan(data, "2026-08-18", () => 0), true);
  assert.equal(data.heartPlan.frequency, "medium");
});

test("evaluateDeliveryGates: 在线且非静默就放行，聊天或跑任务不拦心意", () => {
  const now = Date.parse("2026-08-18T04:00:00.000Z"); // 北京 12:00
  const base = { online: true, lastActivityAt: now - 1000, busy: false };
  assert.deepEqual(evaluateDeliveryGates({ now, presence: base }), {
    ok: true,
    userOnline: true,
    quiet: false,
  });
  assert.equal(evaluateDeliveryGates({ now, presence: { ...base, busy: true } }).ok, true);
  assert.equal(evaluateDeliveryGates({ now, presence: { ...base, online: false } }).ok, false);
  assert.equal(evaluateDeliveryGates({ now, presence: { ...base, lastActivityAt: now - 9 * 60 * 1000 } }).ok, true);
  assert.equal(evaluateDeliveryGates({ now, presence: { ...base, lastActivityAt: now - 11 * 60 * 1000 } }).ok, false);
});

test("isQuietHours: 北京时间跨午夜静默段边界", () => {
  assert.equal(isQuietHours(Date.parse("2026-08-17T14:59:59.000Z")), false); // 22:59:59
  assert.equal(isQuietHours(Date.parse("2026-08-17T15:00:00.000Z")), true); // 23:00
  assert.equal(isQuietHours(Date.parse("2026-08-18T00:59:59.000Z")), false); // 北京 08:59，已过静默段
  assert.equal(isQuietHours(Date.parse("2026-08-17T23:59:59.000Z")), true); // 北京 07:59
  assert.equal(isQuietHours(Date.parse("2026-08-18T00:00:00.000Z")), false); // 北京 08:00
});
