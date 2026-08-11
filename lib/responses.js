// lib/responses.js — 助手回应文本生成（从原 llm.js 拆出）
// 职责：generateReply（互动/礼物回应）、generateCrashReply（关机键崩溃剧本）、generateBrainrot（怪话）
// 依赖：providers（callLLM/getLLMConfig）、prompts（描述/清洗）、data（变量/事件）

import { loadData, buildMoodContext } from "./data.js";
import { getUserDisplayName } from "./activity.js";
import { getLLMConfig, callLLM } from "./providers.js";
import {
  loadAgentDescription,
  sanitizeUserName,
} from "./prompts.js";

// ─── 生成互动回应文本（含变量状态注入） ───
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

// ─── 生成关机崩溃表演文本（供 autoReply 使用） ───
//  代替原来的「平淡回应」，让模型直接表演崩溃→吐槽→继续
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

// ─── 生成脑洞袭击内容（冷笑话/脑筋急转弯/抽象话，随机一种） ───
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
