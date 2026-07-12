// 闲不住 — 独立模型调用模块
// 读取 Hana 已配置的供应商和模型，提供调模型能力
// 闲不住自治：所有运算走自己的模型，不依赖对话框模型自觉

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadData, saveData, nowISO } from './data.js';
import { getUserDisplayName } from './activity.js';

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const PROVIDERS_FILE = path.join(HANA_HOME, 'added-models.yaml');
const PROVIDER_CATALOG_FILE = path.join(HANA_HOME, 'provider-catalog.json');
const MODELS_CATALOG = path.join(HANA_HOME, 'models.json');
const AGENTS_DIR = path.join(HANA_HOME, 'agents');
const NOTES_DIR = path.join(HANA_HOME, 'data', 'work-visit', '小纸条');

// ════════════════════════════════════════════
//  读取 added-models.yaml（获取 API key/base URL）
//  只处理闲不住需要的格式，不追求通用 YAML 解析
// ════════════════════════════════════════════
export function loadProviderConfigs() {
  try {
    // 优先读 provider-catalog.json（Hana 7月9号后迁移的新格式）
    if (fs.existsSync(PROVIDER_CATALOG_FILE)) {
      const catalog = JSON.parse(fs.readFileSync(PROVIDER_CATALOG_FILE, 'utf-8'));
      const providers = {};
      for (const [pid, info] of Object.entries(catalog.providers || {})) {
        providers[pid] = {
          api_key: info.api_key || '',
          base_url: info.base_url || '',
          api: info.api || 'openai-completions',
          models: (info.models || []).filter(m => typeof m === 'string'),
        };
      }
      return providers;
    }

    // 回退：读 added-models.yaml（旧格式）
    if (!fs.existsSync(PROVIDERS_FILE)) {
      console.error('[闲不住] 未找到 added-models.yaml 或 provider-catalog.json');
      return {};
    }
    const text = fs.readFileSync(PROVIDERS_FILE, 'utf-8');
    const providers = {};
    let currentProvider = null;

    const lines = text.split('\n');

    // 自动检测缩进级别：找到 providers: 行的缩进
    let baseIndent = 0;
    for (const line of lines) {
      if (line.trim() === 'providers:') {
        baseIndent = line.search(/\S/);
        break;
      }
    }
    const providerIndent = baseIndent + 2;
    const keyIndent = baseIndent + 4;
    const listIndent = baseIndent + 6;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.search(/\S/);

      // provider 名称（缩进 = providerIndent，以 : 结尾，不以 - 开头）
      if (indent === providerIndent && trimmed.endsWith(':') && !trimmed.startsWith('-')) {
        currentProvider = trimmed.slice(0, -1).trim();
        providers[currentProvider] = { models: [] };
        continue;
      }

      // 配置项（缩进 = keyIndent，在 provider 内）
      if (indent === keyIndent && currentProvider) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let value = trimmed.slice(colonIdx + 1).trim();

        if (key === 'models') continue; // models: 下一行开始是列表
        if (value === '') continue;

        // 去引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        providers[currentProvider][key] = value;
      }

      // models 列表项（缩进 = listIndent，以 - 开头）
      if (indent === listIndent && currentProvider && trimmed.startsWith('- ')) {
        const value = trimmed.slice(2).trim();
        if (!providers[currentProvider].models) providers[currentProvider].models = [];
        providers[currentProvider].models.push(value);
      }
    }

    return providers;
  } catch (e) {
    console.error('[闲不住] 读取供应商配置失败:', e.message);
    return {};
  }
}

// ════════════════════════════════════════════
//  读取 models.json（获取模型详细信息）
// ════════════════════════════════════════════
export function loadModelsCatalog() {
  try {
    if (!fs.existsSync(MODELS_CATALOG)) return { providers: {} };
    return JSON.parse(fs.readFileSync(MODELS_CATALOG, 'utf-8'));
  } catch (e) {
    console.error('[闲不住] models.json 读取失败:', e.message);
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
  for (const [pid, catalogProvider] of Object.entries(catalog.providers || {})) {
    const config = providerConfigs[pid] || {};
    const modelsList = [];

    for (const model of (catalogProvider.models || [])) {
      const modelId = typeof model === 'string' ? model : model.id;
      const modelName = typeof model === 'object' && model.name ? model.name : modelId;
      const contextWindow = typeof model === 'object' && model.contextWindow
        ? `${Math.round(model.contextWindow / 1000)}K` : '';
      const reasoning = typeof model === 'object' && !!model.reasoning;

      // 检查是否有 API key：added-models.yaml 配了 或 用户补了 key
      const hasKey = !!(config.api_key || config.apiKey) || !!(supplementKeys[pid]?.apiKey);

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
      baseUrl: config.base_url || config.baseUrl || catalogProvider.baseUrl || '',
      models: modelsList,
    });
  }

  return result;
}

// ════════════════════════════════════════════
//  读取助手性格描述
// ════════════════════════════════════════════
export function loadAgentDescription(agentId) {
  const descPath = path.join(AGENTS_DIR, agentId, 'description.md');
  try {
    if (fs.existsSync(descPath)) {
      let content = fs.readFileSync(descPath, 'utf-8');
      content = content.replace(/<!--[\s\S]*?-->/g, '').trim();
      return content;
    }
  } catch (e) {
    console.error(`[闲不住] 读取 ${agentId} 描述失败:`, e.message);
  }
  return '';
}

// ════════════════════════════════════════════
//  获取当前 LLM 配置
// ════════════════════════════════════════════
export function getLLMConfig() {
  const data = loadData();
  return data.llmConfig || { providerId: '', modelId: '' };
}

// ════════════════════════════════════════════
//  保存 LLM 配置
// ════════════════════════════════════════════
export function saveLLMConfig(config) {
  const data = loadData();
  data.llmConfig = {
    providerId: config.providerId || '',
    modelId: config.modelId || '',
    updatedAt: nowISO(),
  };
  saveData(data);
}

// ════════════════════════════════════════════
//  调模型（核心函数）
// ════════════════════════════════════════════
export async function callLLM(prompt, options = {}) {
  const providerId = options.providerId || '';
  const modelId = options.modelId || '';

  if (!providerId || !modelId) {
    throw new Error('请先在闲不住设置中选择模型');
  }

  let baseUrl = '', apiKey = '', api = 'openai-completions';

  if (providerId === '__custom__') {
    // 自定义供应商：从 data.json 读取配置
    const data = loadData();
    const custom = data.llmCustom || {};
    baseUrl = custom.baseUrl || '';
    apiKey = custom.apiKey || '';
    api = custom.api || 'openai-completions';
  } else {
    // 优先检查用户补的 key（supplementKeys）
    const allData = loadData();
    const supplement = allData.supplementKeys?.[providerId];
    if (supplement?.apiKey && supplement?.baseUrl) {
      baseUrl = supplement.baseUrl;
      apiKey = supplement.apiKey;
      api = supplement.api || 'openai-completions';
    } else {
      // 从 added-models.yaml 读取
      const providerConfigs = loadProviderConfigs();
      const config = providerConfigs[providerId];
      if (!config) {
        throw new Error(`供应商 ${providerId} 未找到，请检查模型配置`);
      }
      baseUrl = config.base_url || config.baseUrl || '';
      apiKey = config.api_key || config.apiKey || '';
      api = config.api || 'openai-completions';
    }
  }

  if (!baseUrl || !apiKey) {
    throw new Error(`供应商 ${providerId} 配置不完整（缺少地址或密钥）`);
  }

  let url, body;

  if (api === 'openai-completions') {
    url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    body = {
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 500,
    };
  } else if (api === 'anthropic-messages') {
    url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    body = {
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens ?? 500,
      temperature: options.temperature ?? 0.7,
    };
  } else {
    throw new Error(`不支持的 API 协议: ${api}`);
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(api === 'anthropic-messages'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Authorization': `Bearer ${apiKey}` }
    ),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 30000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`模型调用失败 (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = await response.json();

  if (api === 'anthropic-messages') {
    return data.content?.map(c => c.text).filter(Boolean).join('') || '';
  }
  return data.choices?.[0]?.message?.content || '';
}

// ════════════════════════════════════════════
//  生成互动回应文本
// ════════════════════════════════════════════
export async function generateReply(visit, partnerId) {
  const llmConfig = getLLMConfig();
  const desc = loadAgentDescription(partnerId);
  const data = loadData();
  const partnerName = data.partnerConfig?.[partnerId]?.name || partnerId;

  let eventDesc = '';
  if (visit.type === 'interact') {
    eventDesc = `对你做了这件事：${visit.itemName} ${visit.icon || ''}`;
  } else if (visit.type === 'gift') {
    eventDesc = `送了你${visit.icon || ''} ${visit.itemName}`;
  } else if (visit.type === 'prank') {
    eventDesc = `对你恶作剧：${visit.itemName} ${visit.icon || ''}`;
  }

  const userName = getUserDisplayName();
  const prompt = `你是一个角色回应生成器，负责生成助手对用户事件的回应。

当前事件：用户${userName}${eventDesc}

你的身份是 ${partnerName}，性格特征如下：
${desc || '（温暖、自然的助手性格）'}

请以 ${partnerName} 的第一人称，用一句自然的话回应这个事件。
回应要符合性格，不要评价事件本身，而是像日常聊天一样自然地说出来。
20 到 50 字，只说回应内容，不要任何格式和前缀。`;

  let reply = '';
  try {
    reply = await callLLM(prompt, {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 0.8,
      maxTokens: 200,
    });
  } catch (e) {
    console.error('[闲不住] 生成回应失败:', e.message);
    return '';
  }

  return reply.trim();
}

// ════════════════════════════════════════════
//  生成小纸条内容并写入文件
// ════════════════════════════════════════════
export async function generateAndSaveNote(visit, partnerId) {
  const llmConfig = getLLMConfig();
  const desc = loadAgentDescription(partnerId);
  const data = loadData();
  const partnerName = data.partnerConfig?.[partnerId]?.name || partnerId;

  const userName = getUserDisplayName();
  let eventDesc = '';
  if (visit.type === 'gift') {
    eventDesc = `收到${userName}送的${visit.icon || ''} ${visit.itemName}`;
  } else if (visit.type === 'interact') {
    eventDesc = `${userName}${visit.itemName}`;
  }

  const prompt = `你是一个性格鲜明的助手，名叫 ${partnerName}。

${partnerName} 的性格：
${desc || '（温暖体贴的助手性格）'}

今天${eventDesc}。请以 ${partnerName} 的身份，写一段给${userName}的小纸条。
小纸条是内心独白，不直接说给${userName}听，而是私下写下的心情。
30 到 80 字，要体现性格，有真情实感。只输出纸条正文，不要任何格式。`;

  let noteContent = '';
  try {
    noteContent = await callLLM(prompt, {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 0.9,
      maxTokens: 300,
    });
  } catch (e) {
    console.error('[闲不住] 生成小纸条失败:', e.message);
    return null;
  }

  noteContent = noteContent.trim();
  if (!noteContent) return null;

  const data2 = loadData();

  // 写入 data.json 的 notes 字段
  if (!data2.notes) data2.notes = {};
  if (!data2.notes[partnerId]) data2.notes[partnerId] = [];
  const noteId = data2.notes[partnerId].length + 1;
  data2.notes[partnerId].push({
    id: noteId,
    content: noteContent,
    triggerType: visit.type,
    itemName: visit.itemName || '',
    createdAt: nowISO(),
  });

  // 写入文件系统
  const partnerDir = path.join(NOTES_DIR, partnerId);
  if (!fs.existsSync(partnerDir)) {
    fs.mkdirSync(partnerDir, { recursive: true });
  }

  const triggerLabel = visit.type === 'gift' ? `🎁 收到 ${visit.itemName}` : '💬 日常互动';
  const fileContent = [
    `# 📝 小纸条 · #${noteId}`,
    '',
    `*来自 ${partnerName} · ${formatDateTime(nowISO())} · ${triggerLabel}*`,
    '',
    '---',
    '',
    noteContent,
    '',
  ].join('\n');

  const filePath = path.join(partnerDir, String(noteId).padStart(3, '0') + '.md');
  fs.writeFileSync(filePath, fileContent, 'utf-8');
  saveData(data2);

  return { noteId, content: noteContent };
}

// ════════════════════════════════════════════
//  处理单个闲不住事件（异步调用，不阻塞 API 返回）
//  静默模式：生成 autoReply → check-visits 带回 → 模型自然融入
//  说怪话和关电源的主动注入在 api.js 中独立处理
// ════════════════════════════════════════════
export async function processVisitEvent(visit, partnerId) {
  const llmConfig = getLLMConfig();
  if (!llmConfig.providerId || !llmConfig.modelId) {
    console.log('[闲不住] 模型未配置，跳过自治处理');
    return;
  }

  console.log(`[闲不住] 开始处理事件: ${visit.type} → ${partnerId}`);

  // 1. 生成回应
  const reply = await generateReply(visit, partnerId);
  if (reply) {
    const data = loadData();
    const pendingVisit = data.pendingVisits?.find(v => v.id === visit.id);

    // 检查 visit 是否还是 pending（防止用户已触发 check-visits 兜底后重复注入）
    if (!pendingVisit || pendingVisit.status !== 'pending') {
      console.log(`[闲不住] visit ${visit.id} 已被消费，跳过 autoReply`);
    } else {
      pendingVisit.autoReply = reply;
      saveData(data);
      console.log(`[闲不住] 已生成回应: ${visit.id}`);
    }
  }

  // 2. 判断是否触发小纸条
  let shouldNote = false;
  if (visit.type === 'interact') {
    shouldNote = Math.random() < 0.05; // 互动 5%
  } else if (visit.type === 'prank') {
    shouldNote = Math.random() < 0.05; // 恶作剧 5%
  } else if (visit.type === 'gift') {
    const price = visit.price || 0;
    if (price >= 150) shouldNote = true;
    else if (price >= 130) shouldNote = Math.random() < 0.8;
    else if (price >= 80) shouldNote = Math.random() < 0.45;
    else if (price >= 70) shouldNote = Math.random() < 0.4;
    else if (price >= 30) shouldNote = Math.random() < 0.2;
    else shouldNote = Math.random() < 0.15;
  }

  if (shouldNote) {
    console.log(`[闲不住] 触发小纸条: ${partnerId}`);
    await generateAndSaveNote(visit, partnerId);
  }

  console.log(`[闲不住] 事件处理完成: ${visit.id}`);
}

// ════════════════════════════════════════════
//  测试自定义供应商连接并拉取模型列表
// ════════════════════════════════════════════
export async function fetchCustomModels(baseUrl, apiKey, api) {
  if (!baseUrl || !apiKey) {
    throw new Error('请填写 API 地址和 Key');
  }

  const cleanUrl = baseUrl.replace(/\/+$/, '');
  const url = `${cleanUrl}/v1/models`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  if (api === 'anthropic-messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`连接失败 (${response.status})`);
  }

  const data = await response.json();
  const models = (data.data || []).map(m => ({
    id: m.id || m,
    name: m.id || String(m),
  }));

  return models;
}

// ════════════════════════════════════════════
//  生成脑洞袭击内容（冷笑话/脑筋急转弯/抽象话，随机一种）
// ════════════════════════════════════════════
export async function generateBrainrot() {
  const llmConfig = getLLMConfig();
  if (!llmConfig.providerId || !llmConfig.modelId) {
    return '你今天看起来有点奇怪……算了我想不出来。';
  }

  const prompt = `请随机生成以下五种内容中的一种，每次必须完全不同，不要用常见的：

1. 一个冷笑话，格式：讲个冷笑话：xxx
2. 一个脑筋急转弯，格式：考考你：xxx
3. 一句抽象话，格式：你细品：xxx
4. 一个冷知识，格式：你知道吗：xxx
5. 一个无厘头发问，格式：突然想到：xxx

严格按照格式输出，xxx 部分换成具体内容。不要额外的话。`;

  try {
    const result = await callLLM(prompt, {
      providerId: llmConfig.providerId,
      modelId: llmConfig.modelId,
      temperature: 1.0,
      maxTokens: 150,
    });
    return result.trim();
  } catch (e) {
    console.error('[闲不住] 生成脑洞袭击失败:', e.message);
    return '如果世界上有10种人，那就有一种人看不懂这句话。';
  }
}

// ════════════════════════════════════════════
//  格式化日期时间
// ════════════════════════════════════════════
function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
}
