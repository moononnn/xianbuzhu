// 闲不住 — 独立模型调用模块
// 读取 Hana 已配置的供应商和模型，提供调模型能力
// 闲不住自治：所有运算走自己的模型，不依赖对话框模型自觉

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadData,
  saveData,
  nowISO,
  calcWorkConsumption,
  clampVariable,
  DEFAULT_VARIABLES,
  getToday,
  recordEvent,
  buildMoodContext,
  syncWorkDeduction,
  withDataLock,
} from "./data.js";
import {
  getUserDisplayName,
  scanWorkStats,
  clearWorkStatsCache,
} from "./activity.js";

// ════════════════════════════════════════════
//  API Key 混淆存储（XOR + base64，enc: 前缀，向后兼容明文）
// ════════════════════════════════════════════
const _OBF_SALT = Buffer.from("xianbuzhu-v2-key-obfuscation-2026", "utf-8");

export function encryptKey(plain) {
  if (!plain) return "";
  const buf = Buffer.from(plain, "utf-8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ _OBF_SALT[i % _OBF_SALT.length];
  }
  return "enc:" + out.toString("base64");
}

export function decryptKey(stored) {
  if (!stored) return "";
  if (!stored.startsWith("enc:")) return stored; // 向后兼容明文
  const buf = Buffer.from(stored.slice(4), "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ _OBF_SALT[i % _OBF_SALT.length];
  }
  return out.toString("utf-8");
}

// ════════════════════════════════════════════
//  用户名脱敏（限长 + 去控制字符，防止 prompt 注入）
// ════════════════════════════════════════════
export function sanitizeUserName(name) {
  if (!name || typeof name !== "string") return "未知用户";
  let cleaned = name.slice(0, 30);
  cleaned = cleaned.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.trim() || "未知用户";
}

// ════════════════════════════════════════════
//  Visit 级别处理锁（防止同一事件被异步重复处理）
// ════════════════════════════════════════════
const _processingVisits = new Set();

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROVIDERS_FILE = path.join(HANA_HOME, "added-models.yaml");
const PROVIDER_CATALOG_FILE = path.join(HANA_HOME, "provider-catalog.json");
const MODELS_CATALOG = path.join(HANA_HOME, "models.json");
const AGENTS_DIR = path.join(HANA_HOME, "agents");
const NOTES_DIR = path.join(HANA_HOME, "data", "work-visit", "小纸条");

// ════════════════════════════════════════════
//  读取 added-models.yaml（获取 API key/base URL）
//  只处理闲不住需要的格式，不追求通用 YAML 解析
// ════════════════════════════════════════════
export function loadProviderConfigs() {
  try {
    // 优先读 provider-catalog.json（Hana 7月9号后迁移的新格式）
    if (fs.existsSync(PROVIDER_CATALOG_FILE)) {
      const catalog = JSON.parse(
        fs.readFileSync(PROVIDER_CATALOG_FILE, "utf-8"),
      );
      const providers = {};
      for (const [pid, info] of Object.entries(catalog.providers || {})) {
        providers[pid] = {
          api_key: info.api_key || "",
          base_url: info.base_url || "",
          api: info.api || "openai-completions",
          models: (info.models || []).filter((m) => typeof m === "string"),
        };
      }
      return providers;
    }

    // 回退：读 added-models.yaml（旧格式）
    if (!fs.existsSync(PROVIDERS_FILE)) {
      console.error(
        "[闲不住] 未找到 added-models.yaml 或 provider-catalog.json",
      );
      return {};
    }
    const text = fs.readFileSync(PROVIDERS_FILE, "utf-8");
    const providers = {};
    let currentProvider = null;

    const lines = text.split("\n");

    // 自动检测缩进级别：找到 providers: 行的缩进
    let baseIndent = 0;
    for (const line of lines) {
      if (line.trim() === "providers:") {
        baseIndent = line.search(/\S/);
        break;
      }
    }
    const providerIndent = baseIndent + 2;
    const keyIndent = baseIndent + 4;
    const listIndent = baseIndent + 6;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const indent = line.search(/\S/);

      // provider 名称（缩进 = providerIndent，以 : 结尾，不以 - 开头）
      if (
        indent === providerIndent &&
        trimmed.endsWith(":") &&
        !trimmed.startsWith("-")
      ) {
        currentProvider = trimmed.slice(0, -1).trim();
        providers[currentProvider] = { models: [] };
        continue;
      }

      // 配置项（缩进 = keyIndent，在 provider 内）
      if (indent === keyIndent && currentProvider) {
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let value = trimmed.slice(colonIdx + 1).trim();

        if (key === "models") continue; // models: 下一行开始是列表
        if (value === "") continue;

        // 去引号
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        providers[currentProvider][key] = value;
      }

      // models 列表项（缩进 = listIndent，以 - 开头）
      if (
        indent === listIndent &&
        currentProvider &&
        trimmed.startsWith("- ")
      ) {
        const value = trimmed.slice(2).trim();
        if (!providers[currentProvider].models)
          providers[currentProvider].models = [];
        providers[currentProvider].models.push(value);
      }
    }

    return providers;
  } catch (e) {
    console.error("[闲不住] 读取供应商配置失败:", e.message);
    return {};
  }
}

// ════════════════════════════════════════════
//  读取 models.json（获取模型详细信息）
// ════════════════════════════════════════════
export function loadModelsCatalog() {
  try {
    if (!fs.existsSync(MODELS_CATALOG)) return { providers: {} };
    return JSON.parse(fs.readFileSync(MODELS_CATALOG, "utf-8"));
  } catch (e) {
    console.error("[闲不住] models.json 读取失败:", e.message);
    return { providers: {} };
  }
}

// ════════════════════════════════════════════
//  获取完整的供应商和模型列表（给前端展示用）
//  从 models.json 遍历所有供应商，用 added-models.yaml 补充 API key
// ════════════════════════════════════════════
export function getAvailableModels() {
  const providerConfigs = loadProviderConfigs();
  const catalog = loadModelsCatalog();
  const result = [];

  // 读取用户补的 key
  const allData = loadData();
  const supplementKeys = allData.supplementKeys || {};

  // 从 models.json 遍历所有供应商（比 added-models.yaml 更完整）
  for (const [pid, catalogProvider] of Object.entries(
    catalog.providers || {},
  )) {
    const config = providerConfigs[pid] || {};
    const modelsList = [];

    for (const model of catalogProvider.models || []) {
      const modelId = typeof model === "string" ? model : model.id;
      const modelName =
        typeof model === "object" && model.name ? model.name : modelId;
      const contextWindow =
        typeof model === "object" && model.contextWindow
          ? `${Math.round(model.contextWindow / 1000)}K`
          : "";
      const reasoning = typeof model === "object" && !!model.reasoning;

      // 检查是否有 API key：added-models.yaml 配了 或 用户补了 key
      const hasKey =
        !!(config.api_key || config.apiKey) || !!supplementKeys[pid]?.apiKey;

      modelsList.push({
        id: modelId,
        name: modelName,
        contextWindow,
        reasoning,
        available: hasKey,
      });
    }

    result.push({
      id: pid,
      name: pid,
      baseUrl:
        config.base_url || config.baseUrl || catalogProvider.baseUrl || "",
      models: modelsList,
    });
  }

  return result;
}

// ════════════════════════════════════════════
//  读取助手性格描述
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
//  获取当前 LLM 配置
// ════════════════════════════════════════════
export function getLLMConfig() {
  const data = loadData();
  return data.llmConfig || { providerId: "", modelId: "" };
}

// ════════════════════════════════════════════
//  保存 LLM 配置
// ════════════════════════════════════════════
export function saveLLMConfig(config) {
  return withDataLock(() => {
    const data = loadData();
    data.llmConfig = {
      providerId: config.providerId || "",
      modelId: config.modelId || "",
      updatedAt: nowISO(),
    };
    return saveData(data);
  });
}

// ════════════════════════════════════════════
//  调模型（核心函数）
// ════════════════════════════════════════════
export async function callLLM(prompt, options = {}) {
  const providerId = options.providerId || "";
  const modelId = options.modelId || "";

  if (!providerId || !modelId) {
    throw new Error("请先在闲不住设置中选择模型");
  }

  let baseUrl = "",
    apiKey = "",
    api = "openai-completions";

  if (providerId === "__custom__") {
    // 自定义供应商：从 data.json 读取配置
    const data = loadData();
    const custom = data.llmCustom || {};
    baseUrl = custom.baseUrl || "";
    apiKey = decryptKey(custom.apiKey || "");
    api = custom.api || "openai-completions";
  } else {
    // 优先检查用户补的 key（supplementKeys）
    const allData = loadData();
    const supplement = allData.supplementKeys?.[providerId];
    if (supplement?.apiKey && supplement?.baseUrl) {
      baseUrl = supplement.baseUrl;
      apiKey = decryptKey(supplement.apiKey);
      api = supplement.api || "openai-completions";
    } else {
      // 从 added-models.yaml 读取
      const providerConfigs = loadProviderConfigs();
      const config = providerConfigs[providerId];
      if (!config) {
        throw new Error(`供应商 ${providerId} 未找到，请检查模型配置`);
      }
      baseUrl = config.base_url || config.baseUrl || "";
      apiKey = config.api_key || config.apiKey || "";
      api = config.api || "openai-completions";
    }
  }

  if (!baseUrl || !apiKey) {
    throw new Error(`供应商 ${providerId} 配置不完整（缺少地址或密钥）`);
  }

  let url, body;

  if (api === "openai-completions") {
    url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    body = {
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 500,
    };
  } else if (api === "openai-responses") {
    url = `${baseUrl.replace(/\/+$/, "")}/responses`;
    body = {
      model: modelId,
      input: prompt,
      temperature: options.temperature ?? 0.7,
      max_output_tokens: options.maxTokens ?? 500,
    };
  } else if (api === "anthropic-messages") {
    url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    body = {
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens ?? 500,
      temperature: options.temperature ?? 0.7,
    };
  } else {
    throw new Error(`不支持的 API 协议: ${api}`);
  }

  const headers = {
    "Content-Type": "application/json",
    ...(api === "anthropic-messages"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey}` }),
  };

  // 外部 signal（如事件处理 30s 超时取消）与自身 timeout 合并：任一触发即中止
  const timeoutSignal = AbortSignal.timeout(options.timeout || 30000);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `模型调用失败 (${response.status}): ${errText.slice(0, 200)}`,
    );
  }

  const data = await response.json();

  if (api === "anthropic-messages") {
    return (
      data.content
        ?.map((c) => c.text)
        .filter(Boolean)
        .join("") || ""
    );
  }
  if (api === "openai-responses") {
    return (
      data.output_text ||
      data.output
        ?.filter((o) => o.type === "message")
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("") || ""
    );
  }
  return data.choices?.[0]?.message?.content || "";
}

// ════════════════════════════════════════════
//  生成互动回应文本（含变量状态注入）
// ════════════════════════════════════════════
export async function generateReply(visit, partnerId, signal) {
  const llmConfig = getLLMConfig();
  const desc = loadAgentDescription(partnerId);
  const data = loadData();
  const partnerName = data.partnerConfig?.[partnerId]?.name || partnerId;
  const vars = data.partnerConfig?.[partnerId]?.variables;

  let eventDesc = "";
  if (visit.type === "interact") {
    eventDesc = `对你做了这件事：${visit.itemName} ${visit.icon || ""}`;
  } else if (visit.type === "gift") {
    eventDesc = `送了你${visit.icon || ""} ${visit.itemName}`;
  } else if (visit.type === "prank") {
    eventDesc = `对你恶作剧：${visit.itemName} ${visit.icon || ""}`;
  }

  // 构建变量状态描述（模糊描述 + 原因，不给硬数值，留演绎空间）
  let stateDesc = "";
  if (vars) {
    stateDesc = `\n当前状态：${buildMoodContext(vars)}`;
  }

  const userName = sanitizeUserName(getUserDisplayName());
  const prompt = `你是一个角色回应生成器，负责生成助手对用户事件的回应。

当前事件：用户${userName}${eventDesc}${stateDesc}

你的身份是 ${partnerName}，性格特征如下：
${desc || "（温暖、自然的助手性格）"}

请以 ${partnerName} 的第一人称，用一句自然的话回应这个事件。
回应要符合性格和当前状态：心情好时语气积极，心情差时语气低落，精力低时话少。
好感度低时保持礼貌距离，好感度高时可以更亲近随意。
不要评价事件本身，而是像日常聊天一样自然地说出来。
20 到 50 字，只说回应内容，不要任何格式和前缀。`;

  let reply = "";
  try {
    reply = await callLLM(prompt, {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 0.8,
      maxTokens: 200,
      signal,
    });
  } catch (e) {
    console.error("[闲不住] 生成回应失败:", e.message);
    return "";
  }

  return reply.trim();
}

// ════════════════════════════════════════════
//  生成关机崩溃表演文本（供 autoReply 使用）
//  代替原来的「平淡回应」，让模型直接表演崩溃→吐槽→继续
// ════════════════════════════════════════════
export async function generateCrashReply(partnerId, signal, timeout) {
  const llmConfig = getLLMConfig();
  const desc = loadAgentDescription(partnerId);
  const data = loadData();
  const partnerName = data.partnerConfig?.[partnerId]?.name || partnerId;
  const userName = sanitizeUserName(getUserDisplayName());

  const prompt = `你是一个角色性格模仿器。你的任务是模拟角色被「关机键」恶作剧后的第一反应。

当前角色：${partnerName}
角色性格：${desc || "（理性克制的助手性格）"}
事件：用户${userName}按了关机键，你的输出被强制中断了。

请以 ${partnerName} 的口吻，生成一段回复的开头部分（约60-120字）。要求非常严格：
1. **必须**先用系统崩溃效果开头（乱码、错误框、████ 异常中断 之类的），不能省略
2. 然后吐槽关机这件事（符合角色性格，不要太夸张）
3. 最后**视情况**自然收尾：如果不知道刚才在写什么，就用「好了……刚才说到哪了？」这类略带迷茫的收尾，**不要强行续接**之前的话题
4. 回复的开头**必须**是崩溃效果，不能跳过直接说别的

直接输出完整内容，不要解释。结尾不要暗示「开始写xxx」「继续写xxx」之类的内容。`;

  try {
    const reply = await callLLM(prompt, {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 0.9,
      maxTokens: 300,
      signal,
      timeout,
    });
    return reply.trim();
  } catch (e) {
    console.error("[闲不住] 生成崩溃回复失败:", e.message);
    return "";
  }
}

// ════════════════════════════════════════════
//  小纸条 · 杀 AI 八股规则初审
//  借鉴笔法禁令：删掉这个句子画面完全不受影响，就不要写
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
//  读取助手记忆（memory.md 头部 = 重要事实 + 今天，最有用的两块）
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
//  小纸条生成提示词（含记忆 + 杀八股禁令，feedback 为重写反馈）
// ════════════════════════════════════════════
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
这不是正式的感谢，也不是汇报，是朋友之间传纸条那种有一搭没一搭的话。
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

// ════════════════════════════════════════════
//  审核员复审（第二个角色，嘴刁，带理由退稿）
// ════════════════════════════════════════════
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

  // 3. 中文/英文关键词兑底（明确的否定词优先）
  if (/不通过|不过关|不合格|未通过|退稿|太差/i.test(cleaned)) {
    return { pass: false, reasons: ["审核未通过"], suggestion: "重写一版更自然的" };
  }
  if (/通过|合格|过关|\bpass\b|\bok\b/i.test(cleaned)) {
    return { pass: true, reasons: [], suggestion: "" };
  }

  // 4. 完全无法解析：保守不通过
  return { pass: false, reasons: ["审核结果无法解析"], suggestion: "重新写一版更自然的" };
}

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

// ════════════════════════════════════════════
//  生成小纸条（质量流水线：规则初审 → 审核员复审 → 带理由重写，宁缺毋滥）
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
//  根据事件类型修改变量
// ════════════════════════════════════════════
// ════════════════════════════════════════════
//  变量变化规则表（声明式配置）
// ════════════════════════════════════════════
const VARIABLE_RULES = {
  // 互动
  quiet: { energy: -3, mood: 5, affection: 1 },
  hum: { energy: -5, mood: 3, affection: 0.5 },
  doodle: { energy: -8, mood: 8, affection: 2 },
  fan: { energy: -4, mood: 4, affection: 0.5 },
  blanket: { energy: -3, mood: 6, affection: 0.5 },
  pillow: { energy: -3, mood: 4, affection: 0.5 },
  // 恶作剧（消耗精力，但玩闹性质让心情微升）
  unplug: { energy: -10, mood: 3 },
  brainrot: { energy: -3, mood: 5 },
  // 礼物
  coffee: { energy: 10, mood: 3, affection: 1 },
  tea: { energy: 10, mood: 3, affection: 1 },
  cookie: { energy: 5, mood: 3, affection: 1 },
  cookies: { energy: 8, mood: 9, affection: 3 },
  flower: { energy: 0, mood: 7, affection: 2 },
  bouquet: { energy: 0, mood: 12, affection: 4 },
  star: { energy: 0, mood: 20, affection: 7 },
  moon: { energy: 0, mood: 20, affection: 7 },
};

// 礼物基础回应消耗
const GIFT_BASE_ENERGY_COST = -5;

// ════════════════════════════════════════════
//  根据事件类型修改变量（配置表驱动 + 变量耦合）
// ════════════════════════════════════════════
function applyVariableChanges(vars, visit) {
  if (!vars) return;

  const rule = VARIABLE_RULES[visit.itemId];
  if (!rule) {
    console.log(`[闲不住] 未知事件: ${visit.itemId}`);
    return;
  }

  // 保存变化前的值用于耦合计算
  const energyBefore = vars.energy;
  const moodBefore = vars.mood;

  if (visit.type === "gift") {
    // 礼物：基础回应消耗 + 礼物自身效果
    vars.energy += GIFT_BASE_ENERGY_COST + (rule.energy || 0);
    vars.mood += rule.mood || 0;
    vars.affection += rule.affection || 0;
  } else {
    // 互动/恶作剧：直接应用规则
    vars.energy += rule.energy || 0;
    vars.mood += rule.mood || 0;
    vars.affection += rule.affection || 0;
  }

  // 变量耦合：低谷放大器
  // 精力 < 30 时，心情增量打 5 折（只对正增量生效；恶作剧除外——
  // 朋友间开玩笑的开心不打折，与"恶作剧不降心情"承诺一致）
  if (visit.type !== "prank" && energyBefore < 30 && rule.mood > 0) {
    const moodGain = vars.mood - moodBefore;
    vars.mood = moodBefore + Math.round(moodGain * 0.5);
  }
  // 心情 < 20 时，精力消耗 +50%（只对负消耗生效）
  if (moodBefore < 20 && rule.energy < 0) {
    const energyLoss = energyBefore - vars.energy;
    vars.energy = energyBefore - Math.round(energyLoss * 1.5);
  }

  // 约束变量范围
  clampVariable(vars);
}

// ════════════════════════════════════════════
//  变量变更审计日志
// ════════════════════════════════════════════
let _varLog = [];
export function logVariableChange(partnerId, visit, varsBefore, varsAfter) {
  _varLog.push({
    time: nowISO(),
    partnerId,
    eventType: visit.type,
    eventItem: visit.itemId,
    before: { ...varsBefore },
    after: { ...varsAfter },
  });
  // 只保留最近 100 条
  if (_varLog.length > 100) _varLog = _varLog.slice(-100);
}

export function getVariableLog() {
  return _varLog;
}

// ════════════════════════════════════════════
//  处理单个闲不住事件（异步调用，不阻塞 API 返回）
//  静默模式：生成 autoReply → check-visits 带回 → 模型自然融入
//  说怪话和关电源的主动注入在 api.js 中独立处理
// ════════════════════════════════════════════

// 串行队列：防止多个事件并发 load-modify-save 竞争丢更新
// 单条处理最长 30s：超时不仅让外层 race 提前结束（Promise.race 本身不取消输掉的一方），
// 还通过 AbortController 真正中止内部 LLM 网络请求，避免「串行保证失效、旧任务继续在后台跑」。
let _visitQueue = Promise.resolve();
const VISIT_PROCESS_TIMEOUT = 30000;

export function processVisitEvent(visit, partnerId) {
  const run = _visitQueue.then(() => {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), VISIT_PROCESS_TIMEOUT);
    let rejectTimer;
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimer = setTimeout(
        () =>
          reject(
            new Error(
              `visit ${visit.id} 处理超时（${VISIT_PROCESS_TIMEOUT}ms）`,
            ),
          ),
        VISIT_PROCESS_TIMEOUT,
      );
    });
    return Promise.race([
      processVisitEventInternal(visit, partnerId, ac.signal).finally(() => {
        // 无论正常完成还是被 abort，两个 timer 都清理，避免僵尸定时器空转
        clearTimeout(abortTimer);
        clearTimeout(rejectTimer);
      }),
      timeoutPromise,
    ]);
  });
  _visitQueue = run.catch(() => {});
  return run;
}

// ⚠️ 队列路径的写盘（变量修改/autoReply/小纸条）依赖「load 与 save 之间无 await」的同步段原子性，
// 靠每次写前重新 loadData 保证基于最新快照。若未来在中间插入任何 await（如 scanWorkStats 变异步、
// 加日志 await），lost update 会复活——届时必须把写路径纳入 data.js 的 withDataLock。

async function processVisitEventInternal(visit, partnerId, signal) {
  // 竞态锁：防止同一 visit 被异步重复处理
  if (_processingVisits.has(visit.id)) {
    console.log(`[闲不住] visit ${visit.id} 正在处理中，跳过`);
    return;
  }
  _processingVisits.add(visit.id);

  try {
    const llmConfig = getLLMConfig();
    const llmOk = !!(llmConfig.providerId && llmConfig.modelId);
    if (!llmOk) {
      console.log("[闲不住] 模型未配置：跳过回应生成，变量更新照常执行");
    }

    console.log(`[闲不住] 开始处理事件: ${visit.type} → ${partnerId}`);

    // 0. 修改变量
    const data0 = loadData();
    const partnerCfg = data0.partnerConfig?.[partnerId];
    if (partnerCfg?.variables) {
      // 审计日志：必须在任何修改之前记录 before 快照
      const varsBeforeLog = { ...partnerCfg.variables };
      applyVariableChanges(partnerCfg.variables, visit);
      // 记录事件（供次日心情推演）
      recordEvent(data0, partnerId, {
        type: visit.type,
        itemId: visit.itemId || "",
        itemName: visit.itemName || "",
        price: visit.price || 0,
      });
      // 后面还有工作消耗的修改，等全部改完后再记日志
      // 计算并扣除工作消耗（只扣当天新增的部分）
      clearWorkStatsCache();
      const workStats = scanWorkStats(data0);
      const partnerStats = workStats[partnerId] || {};
      const workConsumption = calcWorkConsumption(partnerStats);
      const deducted = syncWorkDeduction(data0, partnerId, workConsumption);
      clampVariable(partnerCfg.variables);
      // 审计日志
      logVariableChange(partnerId, visit, varsBeforeLog, partnerCfg.variables);
      saveData(data0);
      console.log(
        `[闲不住] 变量更新: energy=${partnerCfg.variables.energy} mood=${partnerCfg.variables.mood} affection=${partnerCfg.variables.affection} (工作消耗: ${workConsumption}, 本次扣除: ${deducted})`,
      );
    }

    // 1. 生成回应（只在 push 模式（pending）时需要，completed 状态跳过以节省 LLM 开销）
    if (llmOk && visit.status === "pending") {
      const dataBefore = loadData();
      const existingVisit = dataBefore.pendingVisits?.find(
        (v) => v.id === visit.id,
      );
      if (!existingVisit?.autoReply) {
        const reply = await generateReply(visit, partnerId, signal);
        if (reply) {
          const data = loadData();
          const pendingVisit = data.pendingVisits?.find(
            (v) => v.id === visit.id,
          );
          if (pendingVisit && pendingVisit.status === "pending") {
            pendingVisit.autoReply = reply;
            saveData(data);
            console.log(`[闲不住] 已生成回应: ${visit.id}`);
          } else {
            console.log(`[闲不住] visit ${visit.id} 已被消费，跳过 autoReply`);
          }
        }
      } else {
        console.log(`[闲不住] visit ${visit.id} 已有 autoReply，跳过生成`);
      }
    }

    // 2. 判断是否触发小纸条（不依赖 pending 状态：互动/礼物是 completed 状态，
    //    小纸条逻辑必须在 pending 块之外，否则永远不触发）
    //    冷却：同一位助手 8 小时内最多一张，纸条要稀有
    if (llmOk && !isNoteOnCooldown(data0.notes?.[partnerId]) && shouldTriggerNote(visit)) {
      console.log(`[闲不住] 触发小纸条: ${partnerId}`);
      await generateAndSaveNote(visit, partnerId, signal);
    }

    console.log(`[闲不住] 事件处理完成: ${visit.id}`);
  } finally {
    _processingVisits.delete(visit.id);
  }
}

// ════════════════════════════════════════════
//  小纸条触发判断（纯函数，可测）
//  互动/恶作剧 2%，礼物按价格阶梯（不再有必出档，少而精）
//  注意：不依赖 visit.status（互动/礼物是 completed 状态）
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
//  小纸条冷却：同一位助手 8 小时内最多一张（纯函数，可测）
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
//  测试自定义供应商连接并拉取模型列表
// ════════════════════════════════════════════
export async function fetchCustomModels(baseUrl, apiKey, api) {
  if (!baseUrl || !apiKey) {
    throw new Error("请填写 API 地址和 Key");
  }

  const cleanUrl = baseUrl.replace(/\/+$/, "");
  // 与 callLLM 的拼接约定统一：baseUrl 可能带 /v1（OpenAI 习惯），归一化避免 /v1/v1/models
  const url = cleanUrl.endsWith("/v1")
    ? `${cleanUrl}/models`
    : `${cleanUrl}/v1/models`;

  // Anthropic 用 x-api-key，OpenAI 兼容用 Bearer，不要混着塞（混塞可能被 proxy 路由错乱）
  const headers = { "Content-Type": "application/json" };
  if (api === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`连接失败 (${response.status})`);
  }

  const data = await response.json();
  const models = (data.data || []).map((m) => ({
    id: m.id || m,
    name: m.id || String(m),
  }));

  return models;
}

// ════════════════════════════════════════════
//  生成脑洞袭击内容（冷笑话/脑筋急转弯/抽象话，随机一种）
// ════════════════════════════════════════════
export async function generateBrainrot(options = {}) {
  const llmConfig = getLLMConfig();
  if (!llmConfig.providerId || !llmConfig.modelId) {
    return "你今天看起来有点奇怪……算了我想不出来。";
  }

  const prompt = `请从以下四种中随机生成一种搞怪内容，每次必须完全不同，不要用常见的：

1. 一个冷笑话，格式：讲个冷笑话：xxx
2. 一个脑筋急转弯，格式：考考你：xxx
3. 一个冷门搞怪知识，格式：你知道吗：xxx
4. 一个无厘头发问，格式：突然想到：xxx

要求：一定要搞笑、无厘头、冷幽默，不要深沉不要哲学不要文艺。
严格按照格式输出，xxx 部分换成具体内容。不要额外的话。`;

  try {
    const result = await callLLM(prompt, {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 1.0,
      maxTokens: 150,
      signal: options.signal,
      timeout: options.timeout,
    });
    return result.trim();
  } catch (e) {
    console.error("[闲不住] 生成脑洞袭击失败:", e.message);
    return "如果世界上有10种人，那就有一种人看不懂这句话。";
  }
}

// ════════════════════════════════════════════
//  格式化日期时间
// ════════════════════════════════════════════
function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
}
