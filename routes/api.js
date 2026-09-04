// routes/api.js — 路由聚合壳（原 1321 行的单文件已按域拆分）
// 职责：页面渲染（/page、/assets/*）+ 聚合注册五个域路由
//   visits.js    展板与互动域（/api/data、/api/visit、/api/update-narrative、/api/current-agent）
//   economy.js   经济与装饰域（光粒/充电/状态收藏/装饰/排序/隐藏/刷新）
//   llm.js       模型配置域（供应商/自定义/补 Key/测试）
//   fengling.js  风铃悬浮球域（启动/停止/状态/自动启动）
//   settings.js  设置与杂项域（心意/状态开关/卸载/检查更新/头像/小纸条）
// 本文件保持 register 入口与导出签名不变（default + named 双保险），测试与调用方零改动。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./_helpers.js";
import { registerVisits } from "./visits.js";
import { registerEconomy } from "./economy.js";
import { registerLlm } from "./llm.js";
import { registerFengling } from "./fengling.js";
import { registerSettings } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ─── 渲染页面 ───
function renderPage(token, pluginBase) {
  let css = "",
    js = "";
  try {
    // 同页档案只加载一套完整视觉系统，避免旧主题相互覆盖。
    css = fs.readFileSync(path.join(PUBLIC_DIR, "style.css"), "utf-8");
    js = fs
      .readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf-8")
      .replace(/<\/script>/gi, "<\\/script>");
    // v0.4.3：替换 CSS 里的 __PLUGIN_BASE__ 占位符，并追加 auth token
    // Hana 全局鉴权中间件会拦截所有无 token 请求（含 CSS url()），必须带 ?token=xxx
    // 例如 url("__PLUGIN_BASE__/assets/border-vine.jpg") → url("/api/plugins/work-visit/assets/border-vine.jpg?token=xxx")
    if (pluginBase) {
      if (token) {
        css = css.replace(
          /__PLUGIN_BASE__(\/[^"'\s)]+)/g,
          pluginBase + "$1?token=" + encodeURIComponent(token),
        );
      } else {
        css = css.replace(/__PLUGIN_BASE__/g, pluginBase);
      }
    }
  } catch (e) {
    return "<h1>资源加载失败</h1><p>" + e.message + "</p>";
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>闲不住</title>
<style>${css}</style>
</head>
<body>
<div id="app"><div class="loading-spin">✨</div></div>
<script>window.__TOKEN=${JSON.stringify(token).replace(/</g, "\\u003c")};</script>
<script>${js}</script>
</body></html>`;
}

// ==========================================
//  路由注册（聚合入口）
// ==========================================
// v0.4.2: 函数名必须叫 `register`（hana-roundtable 是这样命名的，plugin runtime 似乎按名称查找）
export default async function register(app, ctx = {}) {
  // 读取插件元数据（版本号 + id，用于构造资源 URL）
  const { version: pluginVersion, id: pluginId } = loadManifest();
  // v0.4.2：所有静态资源（CSS 里的 url()）的 base 路径
  const PLUGIN_BASE = `/api/plugins/${pluginId}`;

  // 子域路由需要读取版本号（如 /api/data 返回 version），挂到 ctx 上共享
  ctx.pluginVersion = pluginVersion;

  // ── 页面 ──
  app.get("/page", (c) => {
    const url = new URL(c.req.url, "http://localhost");
    const token = url.searchParams.get("token") || "";
    const html = renderPage(token, PLUGIN_BASE);
    // 页面 HTML 禁缓存：否则 webview 可能一直显示旧版内联代码（UI 退回旧版）
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  // ════════════════════════════════════════
  //  GET /assets/* — 静态素材路由（v0.4.2 修正）
  //  参考 hana-roundtable 的实现：用通配符 /* + ctx.pluginDir
  //  文件放在 <plugin-dir>/assets/ 下，访问路径为 /api/plugins/<name>/assets/<file>
  // ════════════════════════════════════════
  const pluginDir = ctx.pluginDir || path.join(__dirname, "..");
  const MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".css": "text/css",
    ".js": "application/javascript",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
  };
  app.get("/assets/*", async (c) => {
    const assetPath = c.req.param("*") || "";
    const safePath = path
      .normalize(assetPath)
      .replace(/^(\\|\.\.(\\|\/)|\/)+/, "");
    const file = path.join(pluginDir, "assets", safePath);
    try {
      const content = await fs.promises.readFile(file);
      const ext = path.extname(file).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (e) {
      return new Response("Not Found: " + safePath, { status: 404 });
    }
  });

  // ── 五个业务域路由 ──
  registerVisits(app, ctx);
  registerEconomy(app, ctx);
  registerLlm(app, ctx);
  registerFengling(app, ctx);
  registerSettings(app, ctx);
}

// v0.4.2: named export 'register'，双保险（plugin runtime 无论是 default 还是 named import 都能找到）
export { register };
