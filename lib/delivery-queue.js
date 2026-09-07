// 闲不住 — 普通互动/礼物投递队列
// 第一版只等待目标会话当前回复结束，不接管外派伙伴任务的完成判断。
// 恶作剧不经过这里，继续走 lib/actions.js 的即时通道。

import path from "node:path";
import {
  findLatestSessionPath,
  loadData,
  nowISO,
  saveData,
  withDataLock,
} from "./data.js";

export const DELIVERY_QUEUE_TICK_MS = 5000;
export const DELIVERY_BUSY_RETRY_MS = 3000;
export const DELIVERY_ERROR_RETRY_MS = 5000;
export const DELIVERY_REQUEST_TIMEOUT_MS = 8000;
export const DELIVERY_HISTORY_TIMEOUT_MS = 5000;
export const DELIVERY_STALE_SENDING_MS = 30_000;
export const DELIVERY_MAX_BATCH_SIZE = 20;

let activeManager = null;
let batchSequence = 0;

function textOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function valueOrEmpty(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function normalizePath(value) {
  const text = textOrEmpty(value);
  return text ? path.normalize(text).toLowerCase() : "";
}

function errorText(error) {
  return error?.message || String(error || "未知错误");
}

function isBusyError(error) {
  return /session_busy|busy/i.test(errorText(error));
}

function isTimeoutError(error) {
  return error?.code === "DELIVERY_TIMEOUT" || /超时|timeout/i.test(errorText(error));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label}超时（${ms}ms）`);
      error.code = "DELIVERY_TIMEOUT";
      reject(error);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text || ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function visitIn(data, visitId) {
  return (data.pendingVisits || []).find(
    (visit) => String(visit?.id || "") === String(visitId || ""),
  );
}

function markVisitDelivery(data, visitId, status, error = "") {
  const visit = visitIn(data, visitId);
  if (!visit) return false;
  let changed = false;
  if (visit.deliveryStatus !== status) {
    visit.deliveryStatus = status;
    changed = true;
  }
  if (error) {
    if (visit.deliveryError !== error) {
      visit.deliveryError = error;
      changed = true;
    }
  } else if (visit.deliveryError) {
    delete visit.deliveryError;
    changed = true;
  }
  if (status === "delivered") {
    const deliveredAt = nowISO();
    if (visit.deliveredAt !== deliveredAt) {
      visit.deliveredAt = deliveredAt;
      changed = true;
    }
  }
  return changed;
}

/**
 * 创建一条普通互动/礼物投递记录。记录本身不触发模型调用。
 */
export function createVisitDelivery({ visit, text, sessionPath = "", userName = "" }) {
  const visitId = valueOrEmpty(visit?.id);
  const to = textOrEmpty(visit?.to);
  const deliveryText = textOrEmpty(text);
  if (!visitId || !to || !deliveryText) {
    throw new Error("普通互动投递记录缺少 visitId、to 或 text");
  }
  return {
    id: `visit-delivery-${visitId}`,
    visitId,
    to,
    sessionPath: textOrEmpty(sessionPath),
    text: deliveryText,
    userName: textOrEmpty(userName),
    type: textOrEmpty(visit?.type),
    itemId: textOrEmpty(visit?.itemId),
    itemName: textOrEmpty(visit?.itemName),
    icon: textOrEmpty(visit?.icon),
    isReturn: Boolean(visit?.isReturn),
    returnOf: visit?.returnOf && typeof visit.returnOf === "object"
      ? {
          icon: textOrEmpty(visit.returnOf.icon),
          itemName: textOrEmpty(visit.returnOf.itemName),
        }
      : null,
    returnOfHeartCount: Number(visit?.returnOfHeartCount) || 0,
    queuedAt: textOrEmpty(visit?.createdAt) || nowISO(),
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
  };
}

/**
 * 在已有数据快照中追加队列记录。调用方负责持有 withDataLock 并 saveData。
 */
export function appendVisitDelivery(data, entry) {
  if (!data || !entry?.id) return false;
  if (!Array.isArray(data.deliveryQueue)) data.deliveryQueue = [];
  if (data.deliveryQueue.some((item) => item?.id === entry.id)) return false;
  data.deliveryQueue.push({ ...entry });
  return true;
}

/**
 * 把多份同一目标会话的心意合并成一次投递，避免队列连续触发多个回合。
 */
export function buildDeliveryBatchText(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return "";
  if (list.length === 1) return textOrEmpty(list[0].text);

  const userName = list.find((entry) => textOrEmpty(entry.userName))?.userName || "有人";
  const lines = list.map((entry) => {
    const icon = textOrEmpty(entry.icon) || "📬";
    const name = textOrEmpty(entry.itemName) || "一份心意";
    let returnMark = "";
    if (entry.isReturn) {
      const sourceIcon = textOrEmpty(entry.returnOf?.icon) || "🎁";
      const sourceName = textOrEmpty(entry.returnOf?.itemName) || "一份心意";
      const count = Number(entry.returnOfHeartCount) || 0;
      returnMark = `（回礼：${sourceIcon}${sourceName}${count > 1 ? `，共 ${count} 份` : ""}）`;
    }
    return `${icon} ${name}${returnMark}`;
  });
  return `📬 ${userName}趁你忙着时给你留了 ${list.length} 份心意：\n${lines.join("\n")}`;
}

/**
 * 迁移/恢复队列形状；上次投递中途进程退出的记录先进入 uncertain，
 * 后续通过 session:history 对账，避免盲目重复发送。
 */
export function normalizeDeliveryQueue(
  data,
  at = Date.now(),
  staleSendingMs = DELIVERY_STALE_SENDING_MS,
) {
  if (!data || typeof data !== "object") return false;
  const source = Array.isArray(data.deliveryQueue) ? data.deliveryQueue : [];
  let changed = !Array.isArray(data.deliveryQueue);
  const result = [];

  for (const raw of source) {
    if (!raw || typeof raw !== "object") {
      changed = true;
      continue;
    }
    const item = { ...raw };
    if (!textOrEmpty(item.id) && textOrEmpty(item.visitId)) {
      item.id = `visit-delivery-${textOrEmpty(item.visitId)}`;
      changed = true;
    }

    const valid = textOrEmpty(item.id) && textOrEmpty(item.visitId)
      && textOrEmpty(item.to) && textOrEmpty(item.text);
    if (!valid) {
      if (item.status !== "blocked" || !item.lastError) changed = true;
      item.status = "blocked";
      item.lastError = "队列记录不完整";
      result.push(item);
      continue;
    }

    if (!["pending", "sending", "uncertain", "blocked"].includes(item.status)) {
      item.status = "pending";
      changed = true;
    }
    const attempts = Number(item.attempts);
    if (!Number.isFinite(attempts) || attempts < 0) {
      item.attempts = 0;
      changed = true;
    } else if (item.attempts !== Math.floor(attempts)) {
      item.attempts = Math.floor(attempts);
      changed = true;
    }
    if (item.status === "sending") {
      const sendingAt = Number(item.sendingAt || 0);
      if (sendingAt > 0 && at - sendingAt >= staleSendingMs) {
        item.status = "uncertain";
        item.nextAttemptAt = at;
        item.lastError = item.lastError || "上次投递状态未知，准备对账";
        changed = true;
      }
    }
    result.push(item);
  }

  data.deliveryQueue = result;
  return changed;
}

function finalTurnEvent(event) {
  const stopReason = event?.message?.stopReason ?? event?.stopReason ?? null;
  return !stopReason || stopReason === "stop";
}

export class DeliveryQueueManager {
  constructor(options = {}) {
    this.bus = options.bus || null;
    this.tickMs = Number(options.tickMs) > 0 ? Number(options.tickMs) : DELIVERY_QUEUE_TICK_MS;
    this.busyRetryMs = Number.isFinite(Number(options.busyRetryMs))
      ? Math.max(0, Number(options.busyRetryMs))
      : DELIVERY_BUSY_RETRY_MS;
    this.errorRetryMs = Number.isFinite(Number(options.errorRetryMs))
      ? Math.max(0, Number(options.errorRetryMs))
      : DELIVERY_ERROR_RETRY_MS;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) > 0
      ? Number(options.requestTimeoutMs)
      : DELIVERY_REQUEST_TIMEOUT_MS;
    this.historyTimeoutMs = Number(options.historyTimeoutMs) > 0
      ? Number(options.historyTimeoutMs)
      : DELIVERY_HISTORY_TIMEOUT_MS;
    this.staleSendingMs = Number(options.staleSendingMs) > 0
      ? Number(options.staleSendingMs)
      : DELIVERY_STALE_SENDING_MS;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this._started = false;
    this._timer = null;
    this._kickTimer = null;
    this._off = null;
    this._drainPromise = null;
    this._kickRequested = false;
    this._forceRequested = false;
    this._allPathsRequested = false;
    this._requestedPaths = new Set();
    this._log = options.log || console;
  }

  start() {
    if (this._started) return this.stop.bind(this);
    this._started = true;
    if (!this.bus || typeof this.bus.request !== "function") {
      this._log.warn?.("[闲不住] 普通互动队列等待 bus，暂不启动投递");
      return this.stop.bind(this);
    }

    if (typeof this.bus.subscribe === "function") {
      try {
        this._off = this.bus.subscribe((event, scopedSessionPath) => {
          try {
            const type = event?.type;
            const released = type === "agent_end"
              || (type === "session_status" && event?.isStreaming === false)
              || (type === "turn_end" && finalTurnEvent(event));
            if (released) this.kick(scopedSessionPath || "", true);
          } catch (error) {
            this._log.warn?.("[闲不住] 普通互动队列事件处理失败:", errorText(error));
          }
        });
      } catch (error) {
        this._log.warn?.("[闲不住] 普通互动队列订阅失败，将使用定时兜底:", errorText(error));
      }
    }

    this._timer = setInterval(() => {
      this.drainNow().catch((error) => {
        this._log.error?.("[闲不住] 普通互动队列轮询失败:", errorText(error));
      });
    }, this.tickMs);
    this._timer.unref?.();
    this.kick();
    return this.stop.bind(this);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._kickTimer) clearTimeout(this._kickTimer);
    this._timer = null;
    this._kickTimer = null;
    try { this._off?.(); } catch {}
    this._off = null;
    this._started = false;
    if (activeManager === this) activeManager = null;
  }

  kick(sessionPath = "", force = false) {
    this._kickRequested = true;
    if (force) this._forceRequested = true;
    const key = normalizePath(sessionPath);
    if (key) this._requestedPaths.add(key);
    else this._allPathsRequested = true;
    if (!this._started || this._kickTimer) return;
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      this.drainNow().catch((error) => {
        this._log.error?.("[闲不住] 普通互动队列投递失败:", errorText(error));
      });
    }, 0);
    this._kickTimer.unref?.();
  }

  async drainNow() {
    if (this._drainPromise) {
      this._kickRequested = true;
      return this._drainPromise;
    }
    this._drainPromise = (async () => {
      do {
        this._kickRequested = false;
        const force = this._forceRequested;
        const allowedPaths = this._allPathsRequested || this._requestedPaths.size === 0
          ? null
          : new Set(this._requestedPaths);
        this._forceRequested = false;
        this._allPathsRequested = false;
        this._requestedPaths.clear();
        await this._drainOnce(force, allowedPaths);
      } while (this._kickRequested);
    })();
    try {
      await this._drainPromise;
    } finally {
      this._drainPromise = null;
    }
  }

  async _drainOnce(force = false, allowedPaths = null) {
    await this._recoverStaleEntries();
    const resetAfterReconcile = await this._reconcileUncertain();
    // 对账确认“原文没出现”后先回到 pending，留到下一轮再发，
    // 避免刚查完历史就再次撞上仍未完全结束的会话。
    if (resetAfterReconcile) return;
    const claim = await this._claimNext(force, allowedPaths);
    if (!claim) return;

    try {
      const result = await withTimeout(
        Promise.resolve().then(() => this.bus.request("session:send", {
          text: claim.text,
          sessionPath: claim.sessionPath,
        })),
        this.requestTimeoutMs,
        "session:send",
      );
      if (result?.accepted === false) throw new Error("session message not accepted");
      await this._completeClaim(claim);
      this._log.info?.(
        `[闲不住] 普通互动队列已送达 → ${claim.to}（${claim.entries.length} 条）`,
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        await this._markUncertain(claim, errorText(error));
        this._log.warn?.("[闲不住] 普通互动投递超时，暂存并等待对账:", errorText(error));
      } else if (isBusyError(error)) {
        await this._releaseClaim(claim, "session_busy", this.busyRetryMs, "pending");
      } else {
        const attempts = Math.max(...claim.entries.map((entry) => Number(entry.attempts) || 1));
        const delay = Math.min(60_000, this.errorRetryMs * 2 ** Math.min(attempts - 1, 4));
        await this._releaseClaim(claim, errorText(error), delay, "pending");
        this._log.warn?.("[闲不住] 普通互动投递失败，稍后重试:", errorText(error));
      }
    }
  }

  async _recoverStaleEntries() {
    await withDataLock(() => {
      const data = loadData();
      const changed = normalizeDeliveryQueue(data, this.now(), this.staleSendingMs);
      if (changed) saveData(data);
    });
  }

  resolveSessionPath(entry) {
    const explicit = textOrEmpty(entry?.sessionPath);
    if (explicit) return explicit;
    try {
      return findLatestSessionPath(textOrEmpty(entry?.to));
    } catch {
      return "";
    }
  }

  async _claimNext(force = false, allowedPaths = null) {
    let claim = null;
    await withDataLock(() => {
      const data = loadData();
      const changedByNormalize = normalizeDeliveryQueue(data, this.now(), this.staleSendingMs);
      const now = this.now();
      const groups = new Map();

      for (const item of data.deliveryQueue || []) {
        if (item.status !== "pending") continue;
        if (!force && Number(item.nextAttemptAt || 0) > now) continue;
        const targetSessionPath = this.resolveSessionPath(item);
        if (!targetSessionPath) continue;
        const key = normalizePath(targetSessionPath);
        if (!key) continue;
        if (allowedPaths && !allowedPaths.has(key)) continue;
        let group = groups.get(key);
        if (!group) {
          group = { targetSessionPath, entries: [] };
          groups.set(key, group);
        }
        if (group.entries.length < DELIVERY_MAX_BATCH_SIZE) {
          group.entries.push(item);
        }
      }

      const selected = groups.values().next().value;
      if (!selected?.entries?.length) {
        if (changedByNormalize) saveData(data);
        return;
      }

      const batchId = `visit-batch-${this.now()}-${++batchSequence}`;
      const ids = new Set(selected.entries.map((item) => item.id));
      for (const item of data.deliveryQueue || []) {
        if (!ids.has(item.id)) continue;
        item.status = "sending";
        item.sendingAt = now;
        item.batchId = batchId;
        item.resolvedSessionPath = selected.targetSessionPath;
        item.attempts = (Number(item.attempts) || 0) + 1;
        item.nextAttemptAt = 0;
        item.lastError = "";
      }

      const entries = selected.entries.map((item) => ({
        ...item,
        status: "sending",
        batchId,
        attempts: Number(item.attempts) || 0,
        targetSessionPath: selected.targetSessionPath,
      }));
      const saved = saveData(data);
      if (!saved) return;
      claim = {
        batchId,
        to: textOrEmpty(entries[0]?.to),
        sessionPath: selected.targetSessionPath,
        entries,
        text: buildDeliveryBatchText(entries),
      };
    });
    return claim;
  }

  async _completeClaim(claim) {
    const ids = new Set(claim.entries.map((entry) => entry.id));
    await withDataLock(() => {
      const data = loadData();
      let changed = false;
      const remaining = [];
      for (const item of data.deliveryQueue || []) {
        if (
          item.batchId === claim.batchId
          && ids.has(item.id)
          && (item.status === "sending" || item.status === "uncertain")
        ) {
          changed = true;
          if (markVisitDelivery(data, item.visitId, "delivered")) changed = true;
          continue;
        }
        remaining.push(item);
      }
      if (changed) saveData({ ...data, deliveryQueue: remaining });
    });
  }

  async _releaseClaim(claim, error, delay, status = "pending") {
    const ids = new Set(claim.entries.map((entry) => entry.id));
    await withDataLock(() => {
      const data = loadData();
      let changed = false;
      for (const item of data.deliveryQueue || []) {
        if (item.batchId !== claim.batchId || !ids.has(item.id) || item.status !== "sending") continue;
        item.status = status;
        delete item.batchId;
        delete item.sendingAt;
        if (!item.sessionPath) delete item.resolvedSessionPath;
        item.nextAttemptAt = this.now() + Math.max(0, Number(delay) || 0);
        item.lastError = error || "投递失败";
        if (markVisitDelivery(data, item.visitId, "queued", error)) changed = true;
        changed = true;
      }
      if (changed) saveData(data);
    });
  }

  async _markUncertain(claim, error) {
    const ids = new Set(claim.entries.map((entry) => entry.id));
    await withDataLock(() => {
      const data = loadData();
      let changed = false;
      for (const item of data.deliveryQueue || []) {
        if (item.batchId !== claim.batchId || !ids.has(item.id) || item.status !== "sending") continue;
        item.status = "uncertain";
        item.nextAttemptAt = this.now() + this.staleSendingMs;
        item.lastError = error || "投递状态未知";
        changed = true;
        if (markVisitDelivery(data, item.visitId, "unknown", error)) changed = true;
      }
      if (changed) saveData(data);
    });
  }

  async _reconcileUncertain() {
    const groups = [];
    let resetAfterReconcile = false;
    await withDataLock(() => {
      const data = loadData();
      const changed = normalizeDeliveryQueue(data, this.now(), this.staleSendingMs);
      const byBatch = new Map();
      for (const item of data.deliveryQueue || []) {
        if (item.status !== "uncertain") continue;
        if (Number(item.nextAttemptAt || 0) > this.now()) continue;
        const batchId = item.batchId || item.id;
        let group = byBatch.get(batchId);
        if (!group) {
          const sessionPath = item.resolvedSessionPath || item.sessionPath || this.resolveSessionPath(item);
          group = { batchId, sessionPath, entries: [] };
          byBatch.set(batchId, group);
        }
        group.entries.push({ ...item });
      }
      if (changed) saveData(data);
      groups.push(...byBatch.values());
    });

    for (const group of groups) {
      if (!group.sessionPath) {
        await this._postponeUncertain(group, "找不到原目标对话");
        continue;
      }
      const text = buildDeliveryBatchText(group.entries);
      try {
        const history = await withTimeout(
          Promise.resolve().then(() => this.bus.request("session:history", {
            sessionPath: group.sessionPath,
            limit: 200,
          })),
          this.historyTimeoutMs,
          "session:history",
        );
        const found = (history?.messages || []).some(
          (message) => message?.role === "user" && messageText(message.content) === text,
        );
        if (found) {
          await this._completeClaim({
            batchId: group.batchId,
            entries: group.entries,
          });
        } else {
          await this._resetUncertain(group, "对账未发现送达文本");
          resetAfterReconcile = true;
        }
      } catch (error) {
        await this._postponeUncertain(group, errorText(error));
      }
    }
    return resetAfterReconcile;
  }

  async _resetUncertain(group, error) {
    await withDataLock(() => {
      const data = loadData();
      let changed = false;
      const ids = new Set(group.entries.map((entry) => entry.id));
      for (const item of data.deliveryQueue || []) {
        if (!ids.has(item.id) || item.status !== "uncertain") continue;
        item.status = "pending";
        delete item.batchId;
        delete item.sendingAt;
        item.nextAttemptAt = this.now();
        item.lastError = error || "准备重新投递";
        changed = true;
        if (markVisitDelivery(data, item.visitId, "queued", error)) changed = true;
      }
      if (changed) saveData(data);
    });
  }

  async _postponeUncertain(group, error) {
    await withDataLock(() => {
      const data = loadData();
      let changed = false;
      const ids = new Set(group.entries.map((entry) => entry.id));
      for (const item of data.deliveryQueue || []) {
        if (!ids.has(item.id) || item.status !== "uncertain") continue;
        item.nextAttemptAt = this.now() + this.staleSendingMs;
        item.lastError = error || "对账暂时失败";
        changed = true;
      }
      if (changed) saveData(data);
    });
  }
}

export function startDeliveryQueue(ctx = {}) {
  activeManager?.stop();
  const manager = new DeliveryQueueManager({ bus: ctx?.bus || ctx?._bus || null });
  activeManager = manager;
  manager.start();
  return () => manager.stop();
}

export function notifyDeliveryQueue(sessionPath = "") {
  activeManager?.kick(sessionPath);
}
