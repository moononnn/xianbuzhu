// lib/prompts.js — 提示词构建与素材读取（从原 llm.js 拆出）
// 职责：用户名清洗、助手性格/记忆读取、小纸条/审核提示词构建、AI 八股检测
// 纯函数为主，无 LLM 调用，被 responses/notes 引用

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const AGENTS_DIR = path.join(HANA_HOME, "agents");

// ─── 用户名脱敏（限长 + 去控制字符，防止 prompt 注入） ───
export function sanitizeUserName(name) {
  if (!name || typeof name !== "string") return "未知用户";
  let cleaned = name.slice(0, 30);
  cleaned = cleaned.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.trim() || "未知用户";
}

// ─── 读取助手性格描述 ───
export function loadAgentDescription(agentId) {
  const descPath = path.join(AGENTS_DIR, agentId, "description.md");
  try {
    if (fs.existsSync(descPath)) {
      let content = fs.readFileSync(descPath, "utf-8");
      content = content.replace(/<!--[\s\S]*?-->/g, "").trim();
      return content;
    }
  } catch (e) {
    console.error(`[闲不住] 读取 ${agentId} 描述失败:`, e.message);
  }
  return "";
}

// ─── 小纸条 · 杀 AI 八股规则初审 ───
//  借鉴笔法禁令：删掉这个句子画面完全不受影响，就不要写
const AI_FLAVOR_PATTERNS = [
  /仿佛|宛如|犹如/,
  /一种|一丝|一抹|一阵|一份|一瞬|刹那|瞬间|片刻/,
  /不是[^，。！？]{0,8}而是/,
  /与其说/,
  /某种|说不清/,
  /逻辑|哲学|诗意|灵魂|时光/,
  /弧度|指尖/,
];

export function hasAiFlavor(content) {
  if (!content) return false;
  return AI_FLAVOR_PATTERNS.some((p) => p.test(content));
}

// ─── 读取助手记忆（memory.md 头部 = 重要事实 + 今天，最有用的两块） ───
const MEMORY_MAX_CHARS = 1500;

export function loadAgentMemory(agentId, maxChars = MEMORY_MAX_CHARS) {
  const memPath = path.join(AGENTS_DIR, agentId, "memory", "memory.md");
  try {
    if (fs.existsSync(memPath)) {
      let content = fs.readFileSync(memPath, "utf-8");
      content = content.replace(/<!--[\s\S]*?-->/g, "").trim();
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) + "\n…（记忆较长，以上为节选）";
      }
      return content;
    }
  } catch (e) {
    console.error(`[闲不住] 读取 ${agentId} 记忆失败:`, e.message);
  }
  return "";
}

// ─── 小纸条生成提示词（含记忆 + 杀八股禁令，feedback 为重写反馈） ───
export function buildNotePrompt({ partnerName, desc, memory, userName, eventDesc, feedback }) {
  let prompt = `你是一个性格鲜明的助手，名叫 ${partnerName}。

${partnerName} 的性格：
${desc || "（温暖体贴的助手性格）"}`;

  if (memory) {
    prompt += `

以下是你的记忆，里面是${userName}最近发生的事、你了解到的她：
${memory}`;
  }

  prompt += `

今天${eventDesc}。夜深了，你随手撕了张纸，想给${userName}写几句。
这不是正式的感谢，不是汇报，是朋友之间传纸条那种有一搭没一搭的话。
可以借今天这件事起个头，说说平时没好意思开口的在意；也可以从记忆里挑一件你记得的事顺口提一嘴。大多数纸条是闲聊，偶尔（十次里一两次）可以说一句不煽情的小鼓励，像「做自己就好啦」这种。

写纸条的禁令：
- 像真人说话，别写散文。禁止比喻堆砌，「像…」「仿佛…」这类把心情翻译成风景、诗词、意象的写法一律不用
- 禁止大词：逻辑、哲学、诗意、温柔、时光、灵魂这类词一个都不用
- 禁止八股句式：「不是…而是…」「与其说…不如说…」「有一种…在蔓延」「某种说不清的东西」
- 禁止模糊抒情词：一种、一丝、一抹、瞬间、刹那
- 说话就说话，大白话，具体。情绪靠内容本身传，不靠修辞
- 不许点破「我记得你说过…」，像朋友顺口提一嘴
- 不煽情，不矫情，话不说满，留一点没说的

30 到 80 字，体现性格。只输出纸条正文，不要任何格式。`;

  if (feedback && feedback.reasons?.length) {
    prompt += `

你上一版纸条被审核员退了回来：
退稿理由：${feedback.reasons.join("；")}
修改方向：${feedback.suggestion || "重写一版更自然的"}

重新写一版，别犯同样的毛病。`;
  }

  return prompt;
}

// ─── 审核员复审（第二个角色，嘴刁，带理由退稿） ───
export function buildReviewPrompt(noteContent) {
  return `你是闲不住小纸条的审核员，嘴刁、标准高。下面是一张助手写给主人的小纸条，逐条检查：

1. 感谢体：是否在直接道谢、回报礼物或互动？是则不过
2. AI 八股味：比喻堆砌、大词（逻辑/哲学/诗意/灵魂/时光）、八股句式（不是…而是…/与其说…）、模糊抒情词（一种/一丝/一抹/刹那）？有则不过
3. 煽情矫情：用力过猛、像在演、每句都在抒情？是则不过
4. 人情味：像不像朋友之间传的纸条？有没有「被记挂着」的感觉？这是通过的必要条件
5. 字数：30 到 80 字之间

小纸条内容：
"""${noteContent}"""

只输出一行 JSON，不要其他任何内容，不要用 markdown 代码块，不要解释：
{"pass":true} 或 {"pass":false,"reasons":["原因1","原因2"],"suggestion":"一句修改方向"}`;
}

// ─── 格式化日期时间 ───
export function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
}
