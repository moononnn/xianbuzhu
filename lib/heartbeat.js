// lib/heartbeat.js — 主动心意的心跳、计划表与两道闸
// 心跳只负责“该不该在这一刻敲门”，具体礼物和话交给 hearts.js。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadData,
  saveData,
  todayStr,
  withDataLock,
} from "./data.js";
import { getPartnerIds, isVisiblePartner } from "./config.js";
import { effectiveTemperament, frequencyProfile, clampChance } from "./temperament.js";
import { archiveExpiredHearts, generateAndSaveHeart } from "./hearts.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const PLAN_START_MINUTE = 8 * 60;
const PLAN_END_MINUTE = 22 * 60;
const CHUNK_SIZE = 64 * 1024;

// 完整生成失败后的短退避；不能和当天其他心意计划混成一条，也不能无限撞模型。
export const HEART_RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  3 * 60 * 1000,
  10 * 60 * 1000,
]);
export const MAX_HEART_RETRIES = HEART_RETRY_DELAYS_MS.length;

function finiteTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseMessageLine(line) {
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "message" || !entry.message?.role) return null;
    const message = entry.message;
    return {
      role: message.role,
      timestamp: finiteTimestamp(message.timestamp ?? entry.timestamp),
    };
  } catch {
    return null;
  }
}

function decodeLineParts(parts) {
  const nonEmpty = parts.filter((part) => part && part.length > 0);
  if (!nonEmpty.length) return "";
  if (nonEmpty.length === 1) return nonEmpty[0].toString("utf-8");
  return Buffer.concat(nonEmpty).toString("utf-8");
}

// 从文件尾按完整 JSONL 行向前扫描。不能固定只读最后一段字节：
// 长会话里一条助手回复/工具结果就可能把最新用户消息推到窗口之外，
// 心跳的“人在不在 / 正事是否还在跑”判断会因此误判（与解语花同源问题）。
function forEachLineFromEnd(filePath, callback) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    let position = size;
    // 保存“较旧前缀 + 已读到的较新部分”，只在真正找到换行时拼一次，避免超长单行 O(n²)。
    let carryParts = [];
    while (position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);

      let lineEnd = chunk.length;
      let foundNewline = false;
      const newerParts = carryParts;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        const line = decodeLineParts([
          chunk.subarray(i + 1, lineEnd),
          ...(!foundNewline ? newerParts : []),
        ]);
        if (line.trim() && callback(line)) return true;
        lineEnd = i;
        foundNewline = true;
      }

      const olderPrefix = chunk.subarray(0, lineEnd);
      carryParts = olderPrefix.length
        ? (foundNewline ? [olderPrefix] : [olderPrefix, ...newerParts])
        : [];
    }
    const finalLine = decodeLineParts(carryParts);
    return finalLine.length > 0 && callback(finalLine);
  } finally {
    fs.closeSync(fd);
  }
}

function getSessionFiles(agentId, hanaHome = HANA_HOME) {
  const dir = path.join(hanaHome, "agents", agentId, "sessions");
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(dir, file));
  } catch {
    return [];
  }
}

// 读取实际会话文件，给心跳提供保守的“人在不在 / 正事是否还在跑”判断。
export function readPresenceSnapshot(agentIds, now = Date.now(), hanaHome = HANA_HOME) {
  let best = null;
  for (const agentId of agentIds || []) {
    for (const filePath of getSessionFiles(agentId, hanaHome)) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      let messageAt = 0;
      let lastUserAt = 0;
      try {
        forEachLineFromEnd(filePath, (line) => {
          const parsed = parseMessageLine(line.trim());
          if (!parsed) return false;
          // 向后扫第一条有效消息即最后一条消息；再遇到用户消息即最后一条用户消息，找到就停。
          if (messageAt === 0) messageAt = parsed.timestamp || 0;
          if (parsed.role === "user" && lastUserAt === 0) {
            lastUserAt = parsed.timestamp || 0;
            return true;
          }
          return false;
        });
      } catch {
        // 会话可能正在被 Hana 清理，跳过这一项。
      }
      const lastActivityAt = Math.max(stat.mtimeMs, messageAt, lastUserAt);
      const candidate = {
        agentId,
        sessionPath: filePath,
        lastActivityAt,
        lastUserAt,
      };
      const score = Math.max(lastUserAt, lastActivityAt);
      if (!best || score > best.score) best = { ...candidate, score };
    }
  }

  if (!best) {
    return {
      online: false,
      agentId: null,
      sessionPath: "",
      lastActivityAt: 0,
      lastUserAt: 0,
    };
  }
  return {
    online: now - best.lastActivityAt <= ONLINE_WINDOW_MS,
    agentId: best.agentId,
    sessionPath: best.sessionPath,
    lastActivityAt: best.lastActivityAt,
    lastUserAt: best.lastUserAt,
  };
}

function beijingHour(now) {
  const date = new Date(now);
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
}

export function isQuietHours(now = Date.now(), startHour = 23, endHour = 8) {
  const hour = beijingHour(now);
  return startHour > endHour
    ? hour >= startHour || hour < endHour
    : hour >= startHour && hour < endHour;
}

export function evaluateDeliveryGates({
  now = Date.now(),
  presence = {},
  quietStart = 23,
  quietEnd = 8,
  onlineWindowMs = ONLINE_WINDOW_MS,
} = {}) {
  const lastActivityAt = Number(presence.lastActivityAt) || 0;
  const userOnline = presence.online === true
    && now - lastActivityAt <= onlineWindowMs;
  const quiet = isQuietHours(now, quietStart, quietEnd);
  return {
    // 心意只做轻提示并留在信箱里；聊天或跑任务时也允许送达。
    ok: userOnline && !quiet,
    userOnline,
    quiet,
  };
}

function randomInt(random, min, max) {
  return min + Math.floor(Math.max(0, Math.min(0.999999, random())) * (max - min + 1));
}

function minuteToIso(date, minute) {
  const base = new Date(`${date}T00:00:00+08:00`);
  return new Date(base.getTime() + minute * 60 * 1000).toISOString();
}

function chooseScheduleMinute(entries, random) {
  const used = new Set(entries.map((entry) => entry.minute));
  let minute = randomInt(random, PLAN_START_MINUTE, PLAN_END_MINUTE);
  for (let i = 0; i < 20 && used.has(minute); i++) {
    minute = randomInt(random, PLAN_START_MINUTE, PLAN_END_MINUTE);
  }
  while (used.has(minute) && minute < PLAN_END_MINUTE) minute++;
  while (used.has(minute) && minute > PLAN_START_MINUTE) minute--;
  return minute;
}

export function createHeartPlan({
  date,
  partners = {},
  frequency = "low",
  random = Math.random,
} = {}) {
  const profile = frequencyProfile(frequency);
  const entries = [];

  for (const [partnerId, cfg] of Object.entries(partners || {})) {
    if (cfg?.hidden) continue;
    const vars = cfg?.variables || {};
    const affection = Number.isFinite(Number(vars.affection)) ? Number(vars.affection) : 0;
    const mood = Number.isFinite(Number(vars.mood)) ? Number(vars.mood) : 60;
    const temperament = effectiveTemperament(cfg, affection);
    const affectionFactor = Math.max(0.35, Math.min(1.2, 0.55 + (affection + 20) / 160));
    const moodFactor = Math.max(0.7, Math.min(1.1, 0.8 + mood / 300));
    const chance = clampChance(profile.dailyChance * temperament.frequencyWeight * affectionFactor * moodFactor);
    if (random() >= chance) continue;

    let count = 1;
    if (profile.maxPerPartner > 1 && random() < 0.35) count = 2;
    for (let index = 0; index < count; index++) {
      const minute = chooseScheduleMinute(entries, random);
      entries.push({
        id: `heart-plan-${date}-${entries.length + 1}`,
        partnerId,
        scheduledAt: minuteToIso(date, minute),
        minute,
        status: "planned",
        createdAt: new Date().toISOString(),
      });
    }
  }

  entries.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  return {
    date,
    frequency,
    entries: entries.map(({ minute, ...entry }) => entry),
  };
}

export function ensureDailyHeartPlan(data, date = todayStr(), random = Math.random) {
  const frequency = data.heartSettings?.frequency || "low";
  const current = data.heartPlan || {};
  if (current.date === date && current.frequency === frequency && Array.isArray(current.entries)) {
    return false;
  }
  data.heartPlan = createHeartPlan({
    date,
    partners: data.partnerConfig || {},
    frequency,
    random,
  });
  return true;
}

export function isHeartEntryDue(entry, now = Date.now()) {
  if (entry?.status !== "planned" && entry?.status !== "retry_wait") return false;
  const rawAt = entry.status === "retry_wait"
    ? (entry.nextAttemptAt || entry.scheduledAt)
    : entry.scheduledAt;
  const scheduledAt = new Date(rawAt).getTime();
  return Number.isFinite(scheduledAt) && scheduledAt <= now;
}

export function scheduleHeartRetry(
  entry,
  now = Date.now(),
  failure = { kind: "unknown", retryable: true },
) {
  const retryCount = Number.isInteger(Number(entry.retryCount)) && Number(entry.retryCount) >= 0
    ? Number(entry.retryCount)
    : 0;
  const previousLimit = Number.isInteger(Number(entry.retryLimit)) && Number(entry.retryLimit) >= 0
    ? Number(entry.retryLimit)
    : MAX_HEART_RETRIES;
  const requestedLimit = Number.isInteger(Number(failure?.maxRetries)) && Number(failure.maxRetries) >= 0
    ? Number(failure.maxRetries)
    : MAX_HEART_RETRIES;
  const retryLimit = Math.min(previousLimit, requestedLimit, MAX_HEART_RETRIES);
  const failedAt = new Date(now).toISOString();
  const kind = failure?.kind || "unknown";
  const retryable = failure?.retryable === true;

  entry.failureReason = "message_generation_failed";
  entry.failureKind = kind;
  entry.lastFailureAt = failedAt;
  entry.retryLimit = retryLimit;
  entry.nextAttemptAt = null;
  entry.retryExhausted = false;
  delete entry.failedAt;

  if (!retryable || retryCount >= retryLimit) {
    entry.status = "failed";
    entry.failedAt = failedAt;
    entry.retryExhausted = retryable && retryCount >= retryLimit;
    return "failed";
  }

  entry.status = "retry_wait";
  entry.retryCount = retryCount + 1;
  entry.nextAttemptAt = new Date(
    now + HEART_RETRY_DELAYS_MS[retryCount],
  ).toISOString();
  return "retry_wait";
}

export function cancelHeartPlanForPartner(data, partnerId, now = Date.now()) {
  let changed = false;
  const cancelledAt = new Date(now).toISOString();
  for (const entry of data.heartPlan?.entries || []) {
    if (entry.partnerId !== partnerId) continue;
    if (!["planned", "retry_wait", "generating"].includes(entry.status)) continue;
    entry.status = "cancelled";
    entry.cancelledAt = cancelledAt;
    entry.nextAttemptAt = null;
    changed = true;
  }
  return changed;
}

function cancelHiddenHeartPlans(data, now) {
  let changed = false;
  for (const entry of data.heartPlan?.entries || []) {
    if (!["planned", "retry_wait", "generating"].includes(entry.status)) continue;
    if (isVisiblePartner(data, entry.partnerId)) continue;
    entry.status = "cancelled";
    entry.cancelledAt = new Date(now).toISOString();
    entry.nextAttemptAt = null;
    changed = true;
  }
  return changed;
}

function dueEntry(data, now) {
  return (data.heartPlan?.entries || []).find(
    (entry) => isHeartEntryDue(entry, now)
      && isVisiblePartner(data, entry.partnerId),
  );
}

async function runHeartbeatTick(ctx, options = {}) {
  const now = options.now ?? Date.now();
  const random = options.random || Math.random;
  const presenceReader = options.presenceReader || readPresenceSnapshot;
  let candidate = null;

  await withDataLock(() => {
    const data = loadData();
    let changed = ensureDailyHeartPlan(data, options.date || todayStr(), random);
    if (cancelHiddenHeartPlans(data, now)) changed = true;
    if (archiveExpiredHearts(data, now)) changed = true;
    for (const entry of data.heartPlan?.entries || []) {
      const checkedAt = new Date(entry.checkedAt || 0).getTime();
      if (entry.status === "generating" && Number.isFinite(checkedAt) && now - checkedAt > 10 * 60 * 1000) {
        scheduleHeartRetry(entry, now, { kind: "generation_timeout", retryable: true });
        changed = true;
      }
    }

    const due = dueEntry(data, now);
    if (!due) {
      if (changed) saveData(data);
      return;
    }

    const presence = presenceReader(getPartnerIds(data), now);
    const gates = evaluateDeliveryGates({ now, presence });
    due.checkedAt = new Date(now).toISOString();
    due.attemptCount = (Number(due.attemptCount) || 0) + 1;
    due.nextAttemptAt = null;
    due.gates = gates;
    due.status = gates.ok ? "generating" : "missed";
    changed = true;
    if (!saveData(data)) return;

    if (gates.ok && isVisiblePartner(data, due.partnerId)) {
      candidate = {
        entry: { ...due },
        partnerId: due.partnerId,
        ctx,
      };
    } else {
      console.log(
        `[闲不住] 心动计划错过: ${due.partnerId}（在线=${gates.userOnline}, 静默=${gates.quiet}）`,
      );
    }
  });

  if (!candidate) return null;
  const outcome = await generateAndSaveHeart(candidate);
  if (!outcome?.ok) {
    await withDataLock(() => {
      const data = loadData();
      const entry = data.heartPlan?.entries?.find((item) => item.id === candidate.entry.id);
      if (!entry || entry.status !== "generating") return;
      const status = scheduleHeartRetry(entry, now, outcome?.failure);
      saveData(data);
      console.error(
        `[闲不住] 主动心意生成失败: ${candidate.partnerId}（${entry.failureKind}，${status}`
        + (entry.nextAttemptAt ? `，下次尝试 ${entry.nextAttemptAt}` : "，本条结束")
        + "）",
      );
    });
    return null;
  }
  return outcome.heart;
}

let _tickPromise = null;

export function requestHeartbeatTick(ctx, options = {}) {
  if (_tickPromise) return _tickPromise;
  _tickPromise = runHeartbeatTick(ctx, options)
    .catch((error) => {
      console.error("[闲不住] 心跳检查失败:", error?.message || error);
      return null;
    })
    .finally(() => {
      _tickPromise = null;
    });
  return _tickPromise;
}

export function startHeartbeat(ctx, options = {}) {
  let stopped = false;
  const interval = options.intervalMs || HEARTBEAT_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    await requestHeartbeatTick(ctx, options);
  };

  const timer = setInterval(tick, interval);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export { runHeartbeatTick };
