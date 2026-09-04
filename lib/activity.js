// 闲不住 — 活动扫描层
// 扫描今天所有助手的 session，提取标题和委派记录

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSelfInjectedPushText, todayStr } from "./data.js";
import { getPartnerIds } from "./config.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const AGENTS_DIR = path.join(HANA_HOME, "agents");

// ─── 北京今天 0 点对应的真实时刻 ───
// 会话文件名是 UTC 日期，todayStr() 是北京时间，mtime 兜底必须按北京基准对齐，
// 否则非北京时区用户（或本地时区与北京不一致时）凌晨会话仍会漏算
function todayMidnightBJ() {
  const bj = new Date(Date.now() + 480 * 60000);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - 480 * 60000);
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text || ""))
    .filter(Boolean)
    .join(" ");
}

function cleanTitleText(text) {
  return String(text || "")
    .replace(/\[SessionFile\][\s\S]*?(\[attached_image:|$)/, "")
    .replace(/\[attached_image:[^\]]+\]/, "")
    .trim();
}

function truncateTitle(text) {
  const clean = cleanTitleText(text);
  return clean ? (clean.length > 25 ? clean.slice(0, 25) + "…" : clean) : "";
}

function readSessionMeta(sessionsDir) {
  try {
    const file = path.join(sessionsDir, "session-meta.json");
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// 新版 Hana 的 session-titles 用 sess_* 作为 key；JSONL 文件旁的 files sidecar 保留了对应 sessionId。
// 先用 sidecar 对回 session-titles，再兼容旧版按文件名/路径存标题的格式。
function readSessionIdSidecar(fullPath) {
  try {
    const sidecar = `${fullPath}.files.json`;
    if (!fs.existsSync(sidecar)) return "";
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
    return typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
  } catch {
    return "";
  }
}

function isPluginOwnedSession(meta) {
  const plugin = meta?.plugin;
  // 插件私有会话是后台工作，不等于用户与伙伴聊天；不能污染今日活动和工作量。
  return plugin?.visibility === "plugin_private" || typeof plugin?.ownerPluginId === "string";
}

function candidateSessionFiles(sessionsDir, ts, todayMidnight, sessionMeta = {}) {
  try {
    return fs
      .readdirSync(sessionsDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => {
        const fullPath = path.join(sessionsDir, file);
        const stat = fs.statSync(fullPath);
        return {
          file,
          fullPath,
          sessionId: readSessionIdSidecar(fullPath),
          startsToday: file.startsWith(ts),
          mtimeMs: stat.mtimeMs,
          sessionMeta: sessionMeta[file] || null,
        };
      })
      .filter((item) => !isPluginOwnedSession(item.sessionMeta))
      .filter((item) => item.startsToday || item.mtimeMs >= todayMidnight)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function readSessionActivity(fullPath, startsToday, todayStartMs, nowMs) {
  const result = {
    firstUserText: "",
    latestUserTime: 0,
    latestActivityTime: 0,
    todaySubagents: [],
    hasTodayUser: false,
    stats: {
      toolCalls: 0,
      charsOutput: 0,
      fileOps: 0,
      subagentDispatches: 0,
    },
  };
  let content;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return result;
  }

  let sessionStartTime = null;
  const lines = content.split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      sessionStartTime = normalizeTimestamp(entry.timestamp ?? entry.ts);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message && typeof entry.message === "object"
      ? entry.message
      : entry;
    if (!message?.role) continue;
    const time = normalizeTimestamp(message.timestamp ?? entry.timestamp ?? entry.ts);
    const referenceTime = Number.isFinite(time) ? time : sessionStartTime;
    const inToday = Number.isFinite(referenceTime)
      ? referenceTime >= todayStartMs && referenceTime <= nowMs
      : startsToday;
    if (!inToday) continue;

    const effectiveTime = Number.isFinite(time)
      ? time
      : (Number.isFinite(sessionStartTime) ? sessionStartTime : nowMs);
    result.latestActivityTime = Math.max(result.latestActivityTime, effectiveTime);
    const text = messageText(message);
    if (message.role === "user" && isSelfInjectedPushText(text)) continue;
    if (message.role === "user") {
      result.hasTodayUser = true;
      result.latestUserTime = Math.max(result.latestUserTime, effectiveTime);
      if (!result.firstUserText && text) result.firstUserText = text;
      continue;
    }

    if (message.role === "assistant") {
      const contentItems = Array.isArray(message.content) ? message.content : [];
      for (const item of contentItems) {
        if (item?.type === "text" && typeof item.text === "string") {
          result.stats.charsOutput += item.text.length;
        } else if (item?.type === "toolCall") {
          result.stats.toolCalls++;
          if (item.name === "file" || item.name?.startsWith?.("file")) {
            result.stats.fileOps++;
          }
          if (item.name === "subagent") {
            result.stats.subagentDispatches++;
            const args = item.arguments || {};
            result.todaySubagents.push({
              time: effectiveTime,
              target: args.agent,
              task: args.task || "",
            });
          }
        }
      }
    } else if (message.role === "tool") {
      result.stats.toolCalls++;
    }
  }
  result.todaySubagents.sort((a, b) => b.time - a.time);
  return result;
}

function shortenDispatchTask(task) {
  let shortTask = String(task || "")
    .replace(/^[^，。！？\n]{1,10}?[，:：]\s*/, "")
    .replace(/^(这是|这是关于|请你|请帮我|帮我|帮我一下)\s*/, "")
    .trim();
  const match = shortTask.match(/^[^。！？\n]+/);
  if (match) shortTask = match[0];
  return shortTask.length > 20 ? shortTask.slice(0, 20) + "..." : shortTask;
}

// ─── 扫描今天的活动 ───
// 返回 { agentId: { title, dispatched, dispatchedBy } }
// 活动标题来自会话文件，页面可以高频读取心意/状态，但不需要每次都重扫整天的 JSONL。
export const ACTIVITY_CACHE_TTL_MS = 30 * 1000;
let _activityCache = null;
let _activityCacheAt = 0;
let _activityCacheKey = "";

function activityCacheKey(partnerIds) {
  return `${todayStr()}\u0000${partnerIds.join("\u0001")}`;
}

export function scanTodayActivity(data, options = {}) {
  const ts = todayStr();
  const partnerIds = getPartnerIds(data);
  const cacheKey = activityCacheKey(partnerIds);
  const now = Date.now();
  if (
    options?.force !== true
    && _activityCache
    && _activityCacheKey === cacheKey
    && now - _activityCacheAt < ACTIVITY_CACHE_TTL_MS
  ) {
    return _activityCache;
  }
  const result = {};

  // 预读所有 session-titles.json
  const titleMap = {};
  for (const agentId of partnerIds) {
    const tp = path.join(
      AGENTS_DIR,
      agentId,
      "sessions",
      "session-titles.json",
    );
    try {
      if (fs.existsSync(tp)) {
        Object.assign(titleMap, JSON.parse(fs.readFileSync(tp, "utf-8")));
      }
    } catch {}
  }

  // 每个助手只找今天确实收到用户消息的最近 session。
  // mtime 只能做候选粗筛：Hana 可能因整理会话或写标题而触碰旧文件，不能把它当成今天聊天的证据。
  const todayStartMs = todayMidnightBJ().getTime();
  const nowMs = Date.now();
  // 先把所有目标槽位建好，委派方排在目标方前面时也不能漏记。
  for (const agentId of partnerIds) {
    result[agentId] = { title: null, dispatched: null, dispatchedBy: null };
  }
  for (const agentId of partnerIds) {
    const sessionsDir = path.join(AGENTS_DIR, agentId, "sessions");
    const activities = [];
    const candidates = candidateSessionFiles(
      sessionsDir,
      ts,
      todayStartMs,
      readSessionMeta(sessionsDir),
    );

    for (const candidate of candidates) {
      const session = readSessionActivity(
        candidate.fullPath,
        candidate.startsToday,
        todayStartMs,
        nowMs,
      );
      // readSessionActivity 已经在这一遍解析出 todaySubagents，顺手归集，
      // 避免为了委派记录把同一批 JSONL 再完整读一遍。
      for (const dispatch of session.todaySubagents) {
        const target = dispatch.target;
        if (!target || !result[target] || result[target].dispatched) continue;
        result[target].dispatched = shortenDispatchTask(dispatch.task);
        result[target].dispatchedBy = agentId;
      }
      if (!session.hasTodayUser) continue;
      activities.push({ ...candidate, ...session });
    }
    activities.sort((a, b) => {
      const aTime = a.latestUserTime || a.latestActivityTime;
      const bTime = b.latestUserTime || b.latestActivityTime;
      return bTime - aTime;
    });

    for (const session of activities.slice(0, 3)) {
      const label = titleMap[session.fullPath]
        || titleMap[session.file]
        || (session.sessionId ? titleMap[session.sessionId] : "")
        || "";
      const title = truncateTitle(label) || truncateTitle(session.firstUserText);
      if (title) {
        result[agentId].title = title;
        break;
      }
    }
  }

  _activityCache = result;
  _activityCacheAt = Date.now();
  _activityCacheKey = cacheKey;
  return result;
}

// ─── 扫描工作量统计 ───
// 返回 { [agentId]: { toolCalls, charsOutput, fileOps, subagentDispatches } }
// 基于当天 session 文件统计，用于计算工作消耗
let _workStatsCache = null;
let _workStatsTime = 0;
const WORK_STATS_TTL = 60000; // 缓存 1 分钟

export function scanWorkStats(data) {
  const now = Date.now();
  if (_workStatsCache && now - _workStatsTime < WORK_STATS_TTL) {
    return _workStatsCache;
  }

  const ts = todayStr();
  const partnerIds = getPartnerIds(data);
  const result = {};

  for (const agentId of partnerIds) {
    const stats = {
      toolCalls: 0,
      charsOutput: 0,
      fileOps: 0,
      subagentDispatches: 0,
    };
    const sessionsDir = path.join(AGENTS_DIR, agentId, "sessions");

    try {
      if (!fs.existsSync(sessionsDir)) {
        result[agentId] = stats;
        continue;
      }

      // mtime 只做候选粗筛，真正计入工作量前仍按消息自己的时间戳过滤。
      const todayMidnight = todayMidnightBJ().getTime();
      const todayFiles = candidateSessionFiles(
        sessionsDir,
        ts,
        todayMidnight,
        readSessionMeta(sessionsDir),
      );
      for (const file of todayFiles) {
        const session = readSessionActivity(
          file.fullPath,
          file.startsToday,
          todayMidnight,
          now,
        );
        stats.toolCalls += session.stats.toolCalls;
        stats.charsOutput += session.stats.charsOutput;
        stats.fileOps += session.stats.fileOps;
        stats.subagentDispatches += session.stats.subagentDispatches;
      }
    } catch {}

    result[agentId] = stats;
  }

  _workStatsCache = result;
  _workStatsTime = now;
  return result;
}

// ─── 清除活动缓存（标题/委派来自会话文件，强制刷新时也会绕过缓存） ───
export function clearActivityCache() {
  _activityCache = null;
  _activityCacheAt = 0;
  _activityCacheKey = "";
}

// ─── 清除工作量缓存（在 processVisitEvent 中调用，确保下次扫描拿到最新数据） ───
export function clearWorkStatsCache() {
  _workStatsCache = null;
  _workStatsTime = 0;
}

// ─── 获取用户显示名称 ───
export function getUserDisplayName() {
  try {
    const usersPath = path.join(HANA_HOME, "users.json");
    if (fs.existsSync(usersPath)) {
      const raw = JSON.parse(fs.readFileSync(usersPath, "utf-8"));
      const u = (raw.users || []).find((u) => u.userId === raw.defaultUserId);
      if (u?.displayName) return u.displayName;
    }
  } catch {}
  return "user";
}
