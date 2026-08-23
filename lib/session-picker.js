// lib/session-picker.js — 风铃目标会话读取
// 只负责把 Hana 的会话文件整理成选择器需要的轻量 DTO；不读消息正文之外的私密内容。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const BACKWARD_CHUNK_SIZE = 64 * 1024;
// 宿主 session:list 超时：Hana 主进程对会话请求不响应时（流式输出卡住/会话文件异常等）会无限挂起，
// 让风铃“选助手后读活跃窗口”这步卡死，前端 5 秒超时后显示“读取失败”。超时即回退本地文件扫描。
const SESSION_LIST_TIMEOUT_MS = 3000;

// 给任意 Promise 加超时：超时后 reject；输家仍在后台跑，但调用方保证被包裹的请求自身也有超时。
function withTimeout(promise, ms, label = "请求") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}超时（${ms}ms）`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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

function extractText(entry) {
  const message = entry?.message && typeof entry.message === "object"
    ? entry.message
    : entry;
  if (message?.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => typeof part.text === "string" ? part.text : "")
      .join("\n");
  }
  return null;
}

function decodeLineParts(parts) {
  const nonEmpty = parts.filter((part) => part && part.length > 0);
  if (!nonEmpty.length) return "";
  if (nonEmpty.length === 1) return nonEmpty[0].toString("utf-8");
  return Buffer.concat(nonEmpty).toString("utf-8");
}

function forEachLineFromEnd(filePath, callback) {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    let position = stat.size;
    // 保存“较旧前缀 + 已读到的较新部分”，只在真正找到换行时拼一次。
    // 不能每读 64KB 都 Buffer.concat(carry)，否则超长单行会退化成 O(n²) 拷贝。
    let carryParts = [];
    while (position > 0) {
      const readSize = Math.min(BACKWARD_CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);

      let lineEnd = chunk.length;
      let foundNewline = false;
      const newerParts = carryParts;
      for (let i = chunk.length - 1; i >= 0; i -= 1) {
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

function lastUserMessage(filePath) {
  let result = null;
  try {
    forEachLineFromEnd(filePath, (line) => {
      try {
        const entry = JSON.parse(line);
        const text = extractText(entry);
        if (!text || !text.trim()) return false;
        const message = entry?.message && typeof entry.message === "object"
          ? entry.message
          : entry;
        const time = normalizeTimestamp(message.timestamp ?? entry.timestamp ?? entry.ts);
        if (!Number.isFinite(time) || time <= 0) return false;
        result = { text, time };
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  return result;
}

function cleanTitle(text) {
  let title = String(text || "")
    .replace(/<mood>[\s\S]*?<\/mood>/gi, "")
    .replace(/\[[^\]]*\][\s\S]*?\[\/[^\]]*\]/gi, "")
    .replace(/【[^】]*】[\s\S]*?【\/[^】]*】/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title.slice(0, 40);
}

export function agentIdFromSessionPath(sessionPath) {
  try {
    const full = path.resolve(String(sessionPath || ""));
    const relative = path.relative(path.join(HANA_HOME, "agents"), full);
    const parts = relative.split(path.sep);
    if (parts.length !== 3 || parts[1].toLowerCase() !== "sessions") return "";
    if (!parts[0] || !parts[2].toLowerCase().endsWith(".jsonl")) return "";
    return parts[0];
  } catch {
    return "";
  }
}

export function isSessionPathForAgent(sessionPath, agentId) {
  const expected = String(agentId || "");
  if (!expected || agentIdFromSessionPath(sessionPath) !== expected) return false;
  try {
    const fullPath = path.resolve(String(sessionPath));
    const sessionsRoot = path.resolve(path.join(HANA_HOME, "agents", expected, "sessions"));
    const realPath = fs.realpathSync(fullPath);
    const realRoot = fs.realpathSync(sessionsRoot);
    const relative = path.relative(realRoot, realPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    return fs.statSync(realPath).isFile();
  } catch {
    return false;
  }
}

// ─── 粗筛：返回各助手 sessions 目录下按 mtime 降序的前 maxScan 个 jsonl 候选 ───
// 不读文件内容，只 stat 拿 mtime。最后一条用户消息必然发生在最近读写过的文件里，
// 所以只对候选读尾部找最后用户消息，不必扫全部会话文件。
function recentSessionCandidates(sessionsDir, maxScan = 60) {
  let entries = [];
  let files;
  try {
    files = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const de of files) {
    if (!de.isFile() || !de.name.toLowerCase().endsWith(".jsonl")) continue;
    const full = path.join(sessionsDir, de.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    entries.push({ full, mtime: st.mtimeMs, size: st.size });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, maxScan);
}

const RECENT_SCAN_CANDIDATES = 60;

export function listRecentSessions(agentIds, limit = 12) {
  const allowed = new Set((agentIds || []).filter((id) => typeof id === "string" && id));
  const list = [];
  for (const agentId of allowed) {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    const candidates = recentSessionCandidates(sessionsDir, RECENT_SCAN_CANDIDATES);
    for (const { full: sessionPath, size } of candidates) {
      if (size <= 0) continue;
      try {
        const last = lastUserMessage(sessionPath);
        if (!last) continue;
        list.push({
          agentId,
          sessionPath,
          title: cleanTitle(last.text),
          lastUserTime: last.time,
        });
      } catch {
        // 会话可能正在被 Hana 清理，跳过这一项。
      }
    }
  }
  list.sort((a, b) => b.lastUserTime - a.lastUserTime);
  return list.slice(0, Math.max(0, Number(limit) || 0));
}

export async function listNamedSessions(bus, agentIds, selectedAgentId = "", limit = 5) {
  const allowed = new Set((agentIds || []).filter((id) => typeof id === "string" && id));
  const selected = String(selectedAgentId || "");
  if (selected && !allowed.has(selected)) return [];

  const fallback = listRecentSessions(
    selected ? [selected] : [...allowed],
    Math.max((Number(limit) || 0) * 3, 24),
  );
  const fallbackByPath = new Map(
    fallback.map((item) => [path.normalize(item.sessionPath), item]),
  );

  try {
    if (!bus || typeof bus.request !== "function") return fallback.slice(0, limit);
    const result = await withTimeout(bus.request("session:list", {}), SESSION_LIST_TIMEOUT_MS, "session:list");
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    const normalized = sessions
      .filter((item) => item && typeof item.path === "string" && item.path)
      .map((item) => {
        const sessionPath = path.resolve(item.path);
        const matched = fallbackByPath.get(path.normalize(sessionPath));
        const agentId = String(item.agentId || matched?.agentId || agentIdFromSessionPath(sessionPath) || "");
        if (!allowed.has(agentId) || (selected && agentId !== selected)) return null;
        if (!isSessionPathForAgent(sessionPath, agentId)) return null;
        const title = String(item.title || item.firstMessage || matched?.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        const modified = normalizeTimestamp(item.modified ?? 0);
        return {
          agentId,
          sessionPath,
          title,
          lastUserTime: matched?.lastUserTime || (Number.isFinite(modified) ? modified : 0),
        };
      })
      .filter(Boolean);
    const merged = new Map(fallback.map((item) => [path.normalize(item.sessionPath), item]));
    for (const item of normalized) {
      const key = path.normalize(item.sessionPath);
      const previous = merged.get(key);
      merged.set(key, {
        ...previous,
        ...item,
        title: item.title || previous?.title || "",
        lastUserTime: previous?.lastUserTime || item.lastUserTime || 0,
      });
    }
    return [...merged.values()]
      .sort((a, b) => b.lastUserTime - a.lastUserTime)
      .slice(0, limit);
  } catch {
    return fallback.slice(0, limit);
  }
}

export function displayNameFromConfig(agentId) {
  if (!agentId) return "";
  try {
    const configPath = path.join(HANA_HOME, "agents", agentId, "config.yaml");
    const yaml = fs.readFileSync(configPath, "utf-8");
    const block = yaml.match(/^agent:\s*\r?\n([\s\S]*?)(?=^\S|\s*$)/m);
    const scope = block ? block[1] : yaml;
    const match = scope.match(/^\s*name:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || agentId;
  } catch {
    return agentId;
  }
}
