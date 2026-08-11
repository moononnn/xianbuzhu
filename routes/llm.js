// routes/llm.js — 模型配置域路由
// /api/llm-providers、/api/llm-custom-fetch、/api/llm-supplement-key、/api/llm-custom-save、/api/llm-settings、/api/llm-test

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadData,
  saveData,
  nowISO,
  withDataLock,
} from "../lib/data.js";
import {
  getAvailableModels,
  getLLMConfig,
  saveLLMConfig,
  callLLM,
  fetchCustomModels,
  encryptKey,
} from "../lib/providers.js";
import { isValidAgentId } from "../lib/validate.js";
import { readBody, json } from "./_helpers.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export function registerLlm(app, ctx) {
  // ════════════════════════════════════════
  //  GET /api/llm-providers — 获取可用供应商和模型列表
  // ════════════════════════════════════════
  app.get("/api/llm-providers", (c) => {
    const providers = getAvailableModels();
    const config = getLLMConfig();
    // 把自定义配置也带回去，前端可以回显
    const data = loadData();
    const customRaw = data.llmCustom || {};
    const custom = customRaw.apiKey
      ? {
          baseUrl: customRaw.baseUrl,
          api: customRaw.api,
          modelId: customRaw.modelId,
          label: customRaw.label,
          hasApiKey: true,
          updatedAt: customRaw.updatedAt,
        }
      : customRaw;
    return json({ success: true, providers, selected: config, custom });
  });

  // ════════════════════════════════════════
  //  POST /api/llm-custom-fetch — 测试自定义连接并拉取模型
  // ════════════════════════════════════════
  app.post("/api/llm-custom-fetch", async (c) => {
    try {
      const input = await readBody(c);
      const models = await fetchCustomModels(
        input.baseUrl,
        input.apiKey,
        input.api || "openai-completions",
      );
      return json({ success: true, models });
    } catch (e) {
      return json({ success: false, error: e?.message || "连接失败" }, 500);
    }
  });

  // ════════════════════════════════════════
  //  POST /api/llm-supplement-key — 补填供应商 API Key
  // ════════════════════════════════════════
  app.post("/api/llm-supplement-key", async (c) => {
    try {
      const input = await readBody(c);
      if (!input.providerId || !input.apiKey) {
        return json({ success: false, error: "请填写 API Key" }, 400);
      }
      // 供应商 ID 白名单（providerId 会作为 supplementKeys 的对象 key，防原型污染）
      if (!isValidAgentId(input.providerId)) {
        return json({ success: false, error: "无效的供应商 ID" }, 400);
      }

      return withDataLock(async () => {
        const data = loadData();
        if (!data.supplementKeys) data.supplementKeys = {};

        // 从 models.json 读取该供应商的 baseUrl 和 api
        let catalog;
        try {
          catalog = JSON.parse(
            fs.readFileSync(path.join(HANA_HOME, "models.json"), "utf-8"),
          );
        } catch (e2) {
          return json(
            { success: false, error: "models.json 读取失败: " + e2.message },
            500,
          );
        }
        const provider = catalog.providers?.[input.providerId];
        if (!provider) {
          return json({ success: false, error: "供应商信息不存在" }, 400);
        }

        data.supplementKeys[input.providerId] = {
          apiKey: encryptKey(input.apiKey),
          baseUrl: provider.baseUrl,
          api: provider.api,
          updatedAt: nowISO(),
        };

        // 同时也设为当前使用的模型
        if (input.modelId) {
          data.llmConfig = {
            providerId: input.providerId,
            modelId: input.modelId,
            updatedAt: nowISO(),
          };
        }

        if (!saveData(data)) {
          return json({ success: false, error: "数据保存失败，请重试" }, 500);
        }
        return json({ success: true });
      });
    } catch (e) {
      return json({ success: false, error: e?.message || "保存失败" }, 500);
    }
  });

  // ════════════════════════════════════════
  //  POST /api/llm-custom-save — 保存自定义供应商配置
  // ════════════════════════════════════════
  app.post("/api/llm-custom-save", async (c) => {
    try {
      const input = await readBody(c);
      if (!input.baseUrl || !input.apiKey || !input.modelId) {
        return json({ success: false, error: "请填写完整信息" }, 400);
      }

      // 输入校验：URL 协议 + 长度限制
      if (typeof input.baseUrl !== "string" || input.baseUrl.length > 500) {
        return json({ success: false, error: "API 地址格式错误" }, 400);
      }
      try {
        const urlCheck = new URL(input.baseUrl);
        if (!["http:", "https:"].includes(urlCheck.protocol)) {
          return json(
            {
              success: false,
              error: "API 地址必须以 http:// 或 https:// 开头",
            },
            400,
          );
        }
      } catch {
        return json({ success: false, error: "API 地址格式错误" }, 400);
      }
      if (typeof input.apiKey !== "string" || input.apiKey.length > 200) {
        return json({ success: false, error: "API Key 格式错误" }, 400);
      }

      return withDataLock(async () => {
        const data = loadData();
        data.llmCustom = {
          baseUrl: input.baseUrl,
          apiKey: encryptKey(input.apiKey),
          api: input.api || "openai-completions",
          modelId: input.modelId,
          label: input.label || "自定义",
          updatedAt: nowISO(),
        };
        // 同时也更新 llmConfig，指向自定义
        data.llmConfig = {
          providerId: "__custom__",
          modelId: input.modelId,
          updatedAt: nowISO(),
        };
        if (!saveData(data)) {
          return json({ success: false, error: "数据保存失败，请重试" }, 500);
        }
        return json({ success: true });
      });
    } catch (e) {
      return json({ success: false, error: e?.message || "保存失败" }, 500);
    }
  });

  // ════════════════════════════════════════
  //  GET /api/llm-settings — 获取当前 LLM 配置
  // ════════════════════════════════════════
  app.get("/api/llm-settings", (c) => {
    const config = getLLMConfig();
    return json({ success: true, config });
  });

  // ════════════════════════════════════════
  //  POST /api/llm-settings — 保存 LLM 配置
  // ════════════════════════════════════════
  app.post("/api/llm-settings", async (c) => {
    const input = await readBody(c);
    if (!input.providerId || !input.modelId) {
      return json({ success: false, error: "请选择供应商和模型" }, 400);
    }
    const saved = await saveLLMConfig({
      providerId: input.providerId,
      modelId: input.modelId,
    });
    if (!saved) {
      return json({ success: false, error: "数据保存失败，请重试" }, 500);
    }
    return json({ success: true });
  });

  // ════════════════════════════════════════
  //  POST /api/llm-test — 测试模型连接
  // ════════════════════════════════════════
  app.post("/api/llm-test", async (c) => {
    try {
      const input = await readBody(c);
      const pid = input.providerId || "";
      const mid = input.modelId || "";
      if (!pid || !mid) {
        return json({ success: false, error: "请先选择供应商和模型" }, 400);
      }
      const result = await callLLM(
        "请用一句话回应：你好，这是一条闲不住连接测试消息。只输出回应内容。",
        {
          providerId: pid,
          modelId: mid,
          temperature: 0.5,
          maxTokens: 100,
          timeout: 15000,
        },
      );
      return json({ success: true, reply: result.trim() });
    } catch (e) {
      return json({ success: false, error: e?.message || "连接失败" }, 500);
    }
  });
}
