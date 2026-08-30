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

// 心意只读取公开人格里的“性格”段，不把身份、边界或私密设定塞进生成 prompt。
// description.md 是短简介，AGENTS.public.md 是更具体的说话背景；两者职责分开。
export function loadAgentVoiceDescription(agentId) {
  const publicPath = path.join(AGENTS_DIR, agentId, "AGENTS.public.md");
  try {
    if (fs.existsSync(publicPath)) {
      const content = fs.readFileSync(publicPath, "utf-8")
        .replace(/<!--[\s\S]*?-->/g, "");
      const match = content.match(/(?:^|\n)##\s*性格\s*\n([\s\S]*?)(?=\n##\s|$)/i);
      if (match?.[1]?.trim()) return match[1].trim().slice(0, 3200);
    }
  } catch (e) {
    console.error(`[闲不住] 读取 ${agentId} 公开性格失败:`, e.message);
  }
  return loadAgentDescription(agentId);
}

// ─── 读取助手的方言口癖块（表情包插件写入 AGENTS.md/identity.md 的 *-dialect 注释块）───
// 只读不写；没配方言的助手返回空串，生成链路零变化。
const DIALECT_BLOCK_RE = /<!--\s*[\w-]+-dialect:start\s*-->([\s\S]*?)<!--\s*[\w-]+-dialect:end\s*-->/i;

export function extractDialectBlock(content) {
  if (!content) return "";
  const match = String(content).match(DIALECT_BLOCK_RE);
  if (!match?.[1]) return "";
  return match[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .slice(0, 800);
}

export function loadAgentDialect(agentId) {
  for (const name of ["AGENTS.md", "identity.md"]) {
    const filePath = path.join(AGENTS_DIR, agentId, name);
    try {
      if (fs.existsSync(filePath)) {
        const dialect = extractDialectBlock(fs.readFileSync(filePath, "utf-8"));
        if (dialect) return dialect;
      }
    } catch (e) {
      console.error(`[闲不住] 读取 ${agentId} 方言口癖失败:`, e.message);
    }
  }
  return "";
}

// 从方言口癖文本识别腔调类型，生成一句可执行的句尾引导；识别不了就保持轻引导。
export function deriveDialectFlavor(dialectText = "") {
  const text = String(dialectText || "");
  if (/台湾|台腔|齁|酱紫|湾湾/.test(text)) {
    return "句尾可以自然落一个台湾腔口头语（超、哦、啦、齁、诶），只放一两个，别整条都写方言。";
  }
  if (/四川|川味/.test(text)) {
    return "句尾可以自然落一个四川口头语（噻、嘛、哈、嘎），只放一两个，别整条都写方言。";
  }
  return "可以自然带一两个设定里的口头语，别整条都写方言，也别为了带而硬塞。";
}

export function mergeHeartVoiceDescription(description = "", voiceDescription = "") {
  const primary = String(description || "").trim();
  const secondary = String(voiceDescription || "").trim();
  if (!primary) return secondary;
  if (!secondary || secondary === primary) return primary;
  return `${primary}\n${secondary}`;
}

const HEART_PUNCTUATION_MODES = Object.freeze({
  plain: Object.freeze({
    id: "plain",
    instruction: "保持短句利落，基础标点即可，不要为了变化硬塞符号。",
  }),
  pause: Object.freeze({
    id: "pause",
    instruction: "允许用一次“……”或“…”留下停顿，像话说到这里暂时收住。",
  }),
  direct: Object.freeze({
    id: "direct",
    instruction: "允许用一次“！”表现直接的语气，但不要夸张卖萌。",
  }),
  question: Object.freeze({
    id: "question",
    instruction: "允许用一个“？”写轻问或反问，但不能向对方索要回复。",
  }),
  soft: Object.freeze({
    id: "soft",
    instruction: "如果符合熟稔、柔软的声音，可以在句尾用一次“～”，不要连续使用。",
  }),
  split: Object.freeze({
    id: "split",
    instruction: "可以用“；”或“：”把一个短判断和一个动作分开，保持像说话。",
  }),
});

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// 把“温柔/克制/敏感”翻译成模型可执行的说话动作。
// 形容词只定义气质，声音指纹才定义句子怎么走。
export function deriveHeartVoice(description = "", temperament = {}) {
  const text = String(description || "").toLowerCase();
  const tags = [temperament?.surfaceTag, temperament?.innerTag, temperament?.tag]
    .filter(Boolean);
  const instructions = [];
  const shapes = [];
  const punctuationIds = [];

  const hasDescription = text.trim().length > 0;
  const analytical = /理性优先|克制精准|冷静而深刻|不废话|每句话都有分量|逻辑和分析/.test(text)
    || (!hasDescription && tags.includes("冷淡"));
  const warm = /温暖自主|有温度|老朋友|温柔体贴|热络直接/.test(text)
    || (!hasDescription && (tags.includes("温柔") || tags.includes("热情")));
  const sensitive = /感性助手|未言明|共情|敏锐|细腻/.test(text)
    || (!hasDescription && tags.includes("敏感"));
  const tsundere = /傲娇|嘴硬|刁难|大小姐|嫌弃/.test(text);
  const dialectTaiwan = /台湾|台腔|齁|酱紫|湾湾/.test(text);
  const independent = /自主|坚定|独立|边界|分寸|原则|界限/.test(text)
    || (!hasDescription && tags.includes("边界感强"));
  const lively = /活泼|开朗|外向|爽快|直球/.test(text)
    || (!hasDescription && (tags.includes("大方") || tags.includes("热情")));
  const dialect = /四川|方言|川味|口头语/.test(text);

  // 只选一个主声音，避免“温柔 + 敏感 + 理性 + 边界”又合成一张万能人格卡。
  const primary = tsundere
    ? "tsundere"
    : analytical
      ? "analytical"
      : sensitive
        ? "sensitive"
        : warm
          ? "warm"
          : lively
            ? "lively"
            : independent
              ? "independent"
              : "plain";
  const resolvedPrimary = primary !== "plain"
    ? primary
    : tags.includes("冷淡")
      ? "analytical"
      : tags.includes("敏感")
        ? "sensitive"
        : tags.includes("热情") || tags.includes("大方")
          ? "lively"
          : tags.includes("温柔")
            ? "warm"
            : "plain";

  const voiceMap = {
    analytical: {
      instruction: "先给一个准确的小事实或判断，少铺垫；关心藏在具体安排里。",
      shapes: ["只报一个事实，写完就收", "动作后夹一句干脆的个人判断"],
      punctuation: ["split", "pause", "plain"],
    },
    warm: {
      instruction: "可以直接表现想到对方，但只落到一件带温度的小事，不写泛泛安慰。",
      shapes: ["先说动作，再补一句带温度的短话", "只写留下的痕迹，不解释为什么"],
      punctuation: ["soft", "direct", "pause", "plain"],
    },
    sensitive: {
      instruction: "抓一个容易被忽略的细节，少用命令，多用试探或留白。",
      shapes: ["只写留下的痕迹，不解释为什么", "从一个小细节拐到对方当下"],
      punctuation: ["pause", "question", "soft", "plain"],
    },
    tsundere: {
      instruction: "可以先轻轻顶一句或嘴硬一下，再把关心藏进动作；反差只用一次。",
      shapes: ["先轻轻嫌弃一句，再落到具体东西", "动作后补一句不太承认的关心"],
      punctuation: ["question", "direct", "pause", "plain"],
    },
    lively: {
      instruction: "语气可以更直、更有起伏，偶尔带一点随口的兴致。",
      shapes: ["先丢一句随口的话，再落到具体东西", "把一个动作说得像刚想到一样"],
      punctuation: ["direct", "question", "soft", "plain"],
    },
    independent: {
      instruction: "主动做完一件小事，不讨好，也不给对方安排必须回应的任务。",
      shapes: ["把选择权留给对方，只交代自己做了什么", "只报一个事实，省掉完整的体贴说明"],
      punctuation: ["split", "pause", "plain"],
    },
    plain: {
      instruction: "从一个具体动作或细节开始，关心藏在做法里，不把情绪说满。",
      shapes: ["只留一个具体事实，写完就收", "动作后夹一句短评，不补标准收尾"],
      punctuation: ["pause", "question", "plain"],
    },
  }[resolvedPrimary];

  instructions.push(voiceMap.instruction);
  shapes.push(...voiceMap.shapes);
  punctuationIds.push(...voiceMap.punctuation);
  if (dialect) {
    if (dialectTaiwan) {
      instructions.push("句尾可以自然落一个台湾腔口头语（超、哦、啦、齁、诶），只放一两个，别整条都写方言。");
    } else {
      instructions.push("只有设定明确带方言时才偶尔放进一个口头语，不要把整条写成方言表演。");
    }
  }

  if (!instructions.length) {
    instructions.push("从一个具体动作或细节开始，关心藏在做法里，不把情绪说满。");
  }
  if (!shapes.length) {
    shapes.push("只留一个具体事实，省掉完整的体贴说明");
    shapes.push("动作后夹一句短评，不补标准收尾");
  }
  return {
    instructions: instructions.slice(0, 5),
    shapes: shapes.slice(0, 4),
    punctuationModes: punctuationIds.map((id) => HEART_PUNCTUATION_MODES[id]),
  };
}

export function selectHeartVoiceVariant(seed, voice = deriveHeartVoice()) {
  const shapes = voice.shapes?.length ? voice.shapes : ["只留一个具体事实，写完就收"];
  const modes = voice.punctuationModes?.length
    ? voice.punctuationModes
    : [HEART_PUNCTUATION_MODES.plain];
  const hash = hashText(seed);
  const shape = shapes[hash % shapes.length];
  const punctuation = modes[Math.floor(hash / Math.max(1, shapes.length)) % modes.length];
  return {
    shapeInstruction: shape,
    punctuationId: punctuation.id,
    punctuationInstruction: punctuation.instruction,
  };
}

// 只用于测试/诊断标点倾向；生成链路不把它当成失败门槛，自然声音优先。
export function hasHeartPunctuation(text, variant) {
  const value = String(text || "");
  switch (variant?.punctuationId) {
    case "pause": return /…{1,3}|\.{2,}/.test(value);
    case "direct": return /！|!/.test(value);
    case "question": return /？|\?/.test(value);
    case "soft": return /～|~/.test(value);
    case "split": return /；|：/.test(value);
    default: return true;
  }
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
  // 霸总命令甩话：把事丢给对方、让对方看着办
  /你看着办|你随意|随你便|自己搞定|自己看着办|爱咋(?:样)?(?:咋|怎)(?:样|地)|爱怎样怎样|爱怎么样就怎么样/,
  // 表演性冷漠：懒得+具体动作，把不满和麻烦一起丢出去
  /我懒得[调配弄摆管]|我不屑|懒得理/,
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
export function buildReviewPrompt(noteContent, options = {}) {
  const isHeart = options.kind === "heart";
  const title = isHeart ? "主动心意" : "小纸条";
  const lengthRule = isHeart ? "18 到 80 字" : "30 到 80 字";
  let prompt = `你是闲不住${title}的审核员，嘴刁、标准高。下面是一段助手写给主人的文字，逐条检查：

1. 感谢体：是否在直接道谢、回报礼物或互动？是则不过
2. AI 八股味：比喻堆砌、大词（逻辑/哲学/诗意/灵魂/时光）、八股句式（不是…而是…/与其说…）、模糊抒情词（一种/一丝/一抹/刹那）？有则不过
3. 煽情矫情：用力过猛、像在演、每句都在抒情？是则不过
4. 人情味：像不像这个助手真的会留下的话？有没有具体的人在场感？这是通过的必要条件
5. 字数：${lengthRule}
6. 别扭冷漠/装酷：是否在用「我懒得…」「你自己…」「你看着办」这类命令甩话或表演性冷漠假装有个性？是则不过
`;

  if (isHeart) {
    const event = options.event || {};
    const instructions = options.voiceProfile?.instructions?.join("；") || "从具体动作开始，关心藏在做法里";
    const shape = options.voiceVariant?.shapeInstruction || "只写一个具体落点";
    const punctuation = options.voiceVariant?.punctuationInstruction || "标点随声音自然变化";
    prompt += `
这是一份异步心意，专门检查下面几件事：
- 事件保真：当前事件是“${event.icon || ""}${event.name || "一件小礼物"}”。正文必须能让人认出这件事，不能抽到便签却写成倒水、抽到茶却写成花。
- 声音保真：当前助手是“${options.partnerName || "未提供"}”。可执行声音提示是“${instructions}”。本条写法是“${shape}”。如果把名字换成另一个助手，这句话仍然完全成立，说明人物没有落地，应退稿。
- 结构去模板：不要把“放置位置＋温度细节＋体贴提醒”三项每次都写齐；只留下对这个人最有辨识度的一两步。
- 标点变化：${punctuation}这是偏好，不是硬性门槛；自然写成基础标点也可以，不能为了符号改坏声音。
- 不要用统一免责句“不用特意回”“看到了就行”来假装有分寸。
`;
  }

  prompt += `
${isHeart ? "主动心意正文" : "小纸条内容"}：
"""${noteContent}"""

只输出一行 JSON，不要其他任何内容，不要用 markdown 代码块，不要解释：
{"pass":true} 或 {"pass":false,"reasons":["原因1","原因2"],"suggestion":"一句修改方向"}`;
  return prompt;
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
