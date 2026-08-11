// routes/_helpers.js — 路由层共享工具
// 供各域路由文件（visits/economy/llm/fengling/settings）复用，避免每个文件重复实现

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 解析请求体（容错：非法 JSON 返回空对象） ───
export async function readBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

// ─── JSON 响应 ───
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// ─── 读取插件元数据（版本号 + id，用于构造资源 URL） ───
export function loadManifest() {
  try {
    const manifestPath = path.join(__dirname, "..", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return {
      version: manifest.version || "0.1.0",
      id: manifest.id || "work-visit",
    };
  } catch (e) {
    console.error("[闲不住] 读取 manifest 失败:", e.message);
    return { version: "0.1.0", id: "work-visit" };
  }
}
