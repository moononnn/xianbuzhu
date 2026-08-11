// lib/notes.js — 小纸条流水线（从原 llm.js 拆出）
// 职责：纸条生成（初审 → 审核员复审 → 带理由重写，宁缺毋滥）、触发判断、冷却
// 依赖：providers（callLLM/getLLMConfig）、prompts（提示词/素材/八股检测）、data（写入）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadData, saveData, nowISO } from "./data.js";
import { getUserDisplayName } from "./activity.js";
import { getLLMConfig, callLLM } from "./providers.js";
import {
  loadAgentDescription,
  loadAgentMemory,
  sanitizeUserName,
  hasAiFlavor,
  buildNotePrompt,
  buildReviewPrompt,
  formatDateTime,
} from "./prompts.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const NOTES_DIR = path.join(HANA_HOME, "data", "work-visit", "小纸条");

// ─── 解析审核员 JSON 回复（兼容 markdown 代码块 / 带引号值 / 纯文本） ───
export function parseReview(raw) {
  const cleaned = String(raw || "").replace(/```(?:json)?/gi, "").trim();

  // 1. 严格 JSON 解析（兼容 markdown 代码块包裹）
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === "object" && obj.pass !== undefined) {
      if (obj.pass === true) return { pass: true, reasons: [], suggestion: "" };
      const reasons = Array.isArray(obj.reasons)
        ? obj.reasons.map(String).filter(Boolean).slice(0, 3)
        : [];
      return {
        pass: false,
        reasons: reasons.length ? reasons : ["纸条不够自然"],
        suggestion: typeof obj.suggestion === "string" ? obj.suggestion : "重写一版更自然的",
      };
    }
  } catch {}

  // 2. 宽松匹配 pass 字段（兼容带引号值/全角冒号）
  const m = cleaned.match(/"pass"\s*[:：]\s*(?:"(true|false)"|(true|false))/i);
  if (m) {
    const pass = (m[1] || m[2]).toLowerCase() === "true";
    if (pass) return { pass: true, reasons: [], suggestion: "" };
    const reasons = [...cleaned.matchAll(/"([^"]{2,40})"/g)]
      .map((x) => x[1])
      .filter((x) => !["pass", "false", "true", "reasons", "suggestion"].includes(x.toLowerCase()));
    const sug = cleaned.match(/"suggestion"\s*[:：]\s*"([^"]+)"/);
    return {
      pass: false,
      reasons: reasons.length ? reasons.slice(0, 3) : ["纸条不够自然"],
      suggestion: sug ? sug[1] : "重写一版更自然的",
    };
  }

  // 3. 中文/英文关键词兜底（明确的否定词优先）
  if (/不通过|不过关|不合格|未通过|退稿|太差/i.test(cleaned)) {
    return { pass: false, reasons: ["审核未通过"], suggestion: "重写一版更自然的" };
  }
  if (/通过|合格|过关|\bpass\b|\bok\b/i.test(cleaned)) {
    return { pass: true, reasons: [], suggestion: "" };
  }

  // 4. 完全无法解析：保守不通过
  return { pass: false, reasons: ["审核结果无法解析"], suggestion: "重新写一版更自然的" };
}

// ─── 审核员复审（私有：由生成流水线调用） ───
async function reviewNote(noteContent, llmConfig, signal) {
  try {
    const raw = await callLLM(buildReviewPrompt(noteContent), {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 0.3,
      maxTokens: 300,
      signal,
    });
    return parseReview(raw);
  } catch (e) {
    console.error("[闲不住] 小纸条审核失败:", e.message);
    return { pass: false, reasons: ["审核环节出错"], suggestion: "重新生成" };
  }
}

// ─── 生成小纸条（质量流水线：规则初审 → 审核员复审 → 带理由重写，宁缺毋滥） ───
const MAX_NOTE_ATTEMPTS = 4; // 初稿 + 最多 3 次重写

export async function generateAndSaveNote(visit, partnerId, signal) {
  const llmConfig = getLLMConfig();
  const desc = loadAgentDescription(partnerId);
  const memory = loadAgentMemory(partnerId);
  const data = loadData();
  const partnerName = data.partnerConfig?.[partnerId]?.name || partnerId;

  const userName = sanitizeUserName(getUserDisplayName());
  let eventDesc = "";
  if (visit.type === "gift") {
    eventDesc = `收到${userName}送的${visit.icon || ""} ${visit.itemName}`;
  } else if (visit.type === "interact") {
    eventDesc = `${userName}${visit.itemName}`;
  }

  const basePrompt = buildNotePrompt({ partnerName, desc, memory, userName, eventDesc });

  let noteContent = "";
  let review = null;
  for (let attempt = 1; attempt <= MAX_NOTE_ATTEMPTS; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : buildNotePrompt({ partnerName, desc, memory, userName, eventDesc, feedback: review });
    let draft = "";
    try {
      draft = await callLLM(prompt, {
        providerId: llmConfig.providerId,
        modelId: llmConfig.modelId,
        temperature: 0.9,
        maxTokens: 300,
        signal,
      });
    } catch (e) {
      console.error(`[闲不住] 生成小纸条第 ${attempt} 次失败:`, e.message);
      review = { pass: false, reasons: ["模型调用失败"], suggestion: "重试一次" };
      continue;
    }
    draft = draft.trim();
    if (!draft) {
      review = { pass: false, reasons: ["纸条为空"], suggestion: "写点内容再交稿" };
      continue;
    }
    if (hasAiFlavor(draft)) {
      review = { pass: false, reasons: ["含有 AI 八股味词汇"], suggestion: "用大白话重写，别用比喻和抒情词" };
      continue;
    }
    review = await reviewNote(draft, llmConfig, signal);
    if (review.pass) {
      noteContent = draft;
      break;
    }
  }

  if (!noteContent) {
    console.error(`[闲不住] 小纸条 ${MAX_NOTE_ATTEMPTS} 次尝试均未过审，放弃本条（宁缺毋滥）`);
    return null;
  }

  const data2 = loadData();

  // 写入 data.json 的 notes 字段
  if (!data2.notes) data2.notes = {};
  if (!data2.notes[partnerId]) data2.notes[partnerId] = [];
  const noteId = data2.notes[partnerId].length + 1;
  data2.notes[partnerId].push({
    id: noteId,
    content: noteContent,
    triggerType: visit.type,
    itemName: visit.itemName || "",
    createdAt: nowISO(),
  });

  // 写入文件系统
  const partnerDir = path.join(NOTES_DIR, partnerId);
  if (!fs.existsSync(partnerDir)) {
    fs.mkdirSync(partnerDir, { recursive: true });
  }

  const triggerLabel =
    visit.type === "gift" ? `🎁 收到 ${visit.itemName}` : "💬 日常互动";
  const fileContent = [
    `# 📝 小纸条 · #${noteId}`,
    "",
    `*来自 ${partnerName} · ${formatDateTime(nowISO())} · ${triggerLabel}*`,
    "",
    "---",
    "",
    noteContent,
    "",
  ].join("\n");

  const filePath = path.join(
    partnerDir,
    String(noteId).padStart(3, "0") + ".md",
  );
  fs.writeFileSync(filePath, fileContent, "utf-8");
  saveData(data2);

  return { noteId, content: noteContent };
}

// ─── 小纸条触发判断（纯函数，可测） ───
//  互动/恶作剧 2%，礼物按价格阶梯（不再有必出档，少而精）
//  注意：不依赖 visit.status（互动/礼物是 completed 状态）
export function shouldTriggerNote(visit) {
  if (visit.type === "interact" || visit.type === "prank") {
    return Math.random() < 0.02;
  }
  if (visit.type === "gift") {
    const price = visit.price || 0;
    if (price >= 150) return Math.random() < 0.5;
    if (price >= 100) return Math.random() < 0.3;
    if (price >= 50) return Math.random() < 0.12;
    return Math.random() < 0.08;
  }
  return false;
}

// ─── 小纸条冷却：同一位助手 8 小时内最多一张（纯函数，可测） ───
export const NOTE_COOLDOWN_MS = 8 * 60 * 60 * 1000;

export function isNoteOnCooldown(notes, now = Date.now()) {
  if (!Array.isArray(notes) || notes.length === 0) return false;
  let lastTs = 0;
  for (const n of notes) {
    const ts = n?.createdAt ? new Date(n.createdAt).getTime() : NaN;
    if (!Number.isNaN(ts) && ts > lastTs) lastTs = ts;
  }
  if (!lastTs) return false;
  return now - lastTs < NOTE_COOLDOWN_MS;
}
