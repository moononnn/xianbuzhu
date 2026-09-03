// lib/providers.js — 供应商配置与模型调用核心（从原 llm.js 拆出）
// 职责：API Key 混淆存储、供应商/模型配置读取、callLLM 模型调用、自定义供应商测试
// 依赖方向：只依赖 data.js（数据层），被 responses/notes/events 引用

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadData, nowISO, withDataLock, saveData } from "./data.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROVIDERS_FILE = path.join(HANA_HOME, "added-models.yaml");
const PROVIDER_CATALOG_FILE = path.join(HANA_HOME, "provider-catalog.json");
const MODELS_CATALOG = path.join(HANA_HOME, "models.json");

// ─── API Key 混淆存储（XOR + base64，enc: 前缀，向后兼容明文） ───
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

// ─── 读取 added-models.yaml（获取 API key/base URL） ───
//  只处理闲不住需要的格式，不追求通用 YAML 解析
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

// ─── 读取 models.json（获取模型详细信息） ───
export function loadModelsCatalog() {
  try {
    if (!fs.existsSync(MODELS_CATALOG)) return { providers: {} };
    return JSON.parse(fs.readFileSync(MODELS_CATALOG, "utf-8"));
  } catch (e) {
    console.error("[闲不住] models.json 读取失败:", e.message);
    return { providers: {} };
  }
}

// ─── 获取完整的供应商和模型列表（给前端展示用） ───
//  从 models.json 遍历所有供应商，用 added-models.yaml 补充 API key
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

// ─── LLM 配置读取 / 保存 ───
export function getLLMConfig() {
  const data = loadData();
  return data.llmConfig || { providerId: "", modelId: "" };
}

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

// ─── 调模型（核心函数） ───
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
    // 需要短正文的调用可以显式控制思考模式；DeepSeek V4 等思考模型若把预算耗在
    // reasoning_content 上，message.content 可能为空，闲不住就会把它误判成无回复。
    // 官方参数是 thinking: { type }，不要用 thinking_level（那是 Hana 网关的字段）。
    if (options.thinking && typeof options.thinking === "object") {
      body.thinking = options.thinking;
    } else if (providerId === "minimax" && /^MiniMax-M3/.test(modelId)) {
      body.thinking = { type: "disabled" };
    }
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
    const respText =
      data.output_text ||
      data.output
        ?.filter((o) => o.type === "message")
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
    if (respText) return respText;
    // 兼容：声明 responses 协议但实际返回 chat completions 格式的网关（如部分自建代理），
    // 否则模型明明有回复也会被解析成空串（闲不住会报「怪话生成失败」）
    return data.choices?.[0]?.message?.content || "";
  }
  const content = data.choices?.[0]?.message?.content || "";
  if (content) return content;
  // 反向兜底：声明 completions 协议但返回 responses 格式的网关
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

// ─── 测试自定义供应商连接并拉取模型列表 ───
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
