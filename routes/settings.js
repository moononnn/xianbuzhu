// routes/settings.js — 设置与杂项域路由
// /api/uninstall、/api/check-update、/api/avatar、/api/notes、/api/notes/read

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadData,
  saveData,
  withDataLock,
} from "../lib/data.js";
import { getPartnerConfig } from "../lib/config.js";
import { readBody, json } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export function registerSettings(app, ctx) {
  // ════════════════════════════════════════
  //  GET /api/avatar/:agentId — 获取助手头像
  // ════════════════════════════════════════
  app.get("/api/avatar/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    // 路径穿越防护：agentId 只允许字母数字下划线连字符
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return new Response(null, { status: 404 });
    }
    const avatarPath = path.join(
      HANA_HOME,
      "agents",
      agentId,
      "avatars",
      "agent.png",
    );
    try {
      if (fs.existsSync(avatarPath)) {
        const img = fs.readFileSync(avatarPath);
        return new Response(img, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    } catch {}
    return new Response(null, { status: 404 });
  });

  // ════════════════════════════════════════
  //  GET /api/notes — 获取小纸条列表
  // ════════════════════════════════════════
  app.get("/api/notes", (c) => {
    const data = loadData();
    const partnerConfig = getPartnerConfig(data);

    // 按助手整理，附带助手名字
    const result = {};
    for (const [partnerId, notes] of Object.entries(data.notes || {})) {
      result[partnerId] = {
        name: partnerConfig[partnerId]?.name || partnerId,
        color: partnerConfig[partnerId]?.color || "#999",
        notes: notes.slice().reverse(), // 最新的在前
      };
    }

    return json({ success: true, groups: result });
  });

  // ════════════════════════════════════════
  //  POST /api/notes/read — 标记小纸条已读
  // ════════════════════════════════════════
  app.post("/api/notes/read", (c) => {
    return withDataLock(async () => {
      const data = loadData();
      data.lastReadNotesTs = Date.now();
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      return json({ success: true });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/uninstall — 彻底卸载（清理所有残留）
  // ════════════════════════════════════════
  app.post("/api/uninstall", async (c) => {
    // 安全保护：只接受来自插件页面的请求 + 显式确认
    const referer = c.req.header("Referer") || c.req.header("referer") || "";
    if (
      !referer.includes("/work-visit/page") &&
      !referer.includes("/xianbuzhu/page")
    ) {
      return json({ success: false, error: "拒绝：非页面请求" }, 403);
    }
    try {
      const input = await readBody(c);
      if (input.confirm !== true) {
        return json({ success: false, error: "请确认后再执行" }, 400);
      }
      // 1. 删除所有助手 identity.md 中的闲不住协议块（含极简协议）
      const agentsDir = path.join(HANA_HOME, "agents");
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const identityPath = path.join(agentsDir, entry.name, "identity.md");
          if (!fs.existsSync(identityPath)) continue;
          let content = fs.readFileSync(identityPath, "utf-8");
          let newContent = content.replace(
            /<!-- work-visit-protocol-v\d+ -->[\s\S]*?<!-- \/work-visit-protocol-v\d+ -->\s*/g,
            "",
          );
          newContent = newContent.replace(
            /<!-- work-visit-minimal -->[\s\S]*?<!-- \/work-visit-minimal -->\s*/g,
            "",
          );
          if (newContent !== content) {
            fs.writeFileSync(identityPath, newContent, "utf-8");
          }
        }
      }

      // 2. 删除数据目录
      const dataDir = path.join(HANA_HOME, "data", "work-visit");
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }

      // 3. 删除 skill 目录
      const skillDir = path.join(HANA_HOME, "skills", "work-visit");
      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }

      // 4. 清理所有助手 config.yaml 中的 work-visit skill 引用
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const configPath = path.join(agentsDir, entry.name, "config.yaml");
          if (!fs.existsSync(configPath)) continue;
          let cfg = fs.readFileSync(configPath, "utf-8");
          cfg = cfg.replace(/^\s+- work-visit\n/gm, "");
          fs.writeFileSync(configPath, cfg, "utf-8");
        }
      }

      return json({
        success: true,
        message: "清理完成，请关闭 Hana 并手动删除插件目录",
      });
    } catch (e) {
      console.error("[闲不住] 卸载清理失败:", e.message);
      return json({ success: false, error: e.message }, 500);
    }
  });

  // ════════════════════════════════════════
  //  GET /api/check-update — 检查 GitHub 更新
  // ════════════════════════════════════════
  app.get("/api/check-update", async (c) => {
    try {
      const manifestPath = path.join(__dirname, "..", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const currentVersion = manifest.version || "0.1.0";

      // 获取最新 tag
      const resp = await fetch(
        "https://api.github.com/repos/moononnn/xianbuzhu/tags?per_page=1",
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "work-visit",
          },
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!resp.ok) {
        return json({
          success: true,
          current: currentVersion,
          latest: null,
          hasUpdate: false,
          message: "GitHub API 暂时不可用（" + resp.status + "）",
        });
      }

      const tags = await resp.json();
      if (!tags || !Array.isArray(tags) || tags.length === 0) {
        return json({
          success: true,
          current: currentVersion,
          latest: currentVersion,
          hasUpdate: false,
          message: "已是最新版本 ✨",
        });
      }

      const latestTag = tags[0].name.replace(/^v/, "");
      const hasUpdate = compareVersions(latestTag, currentVersion) > 0;

      // 获取 release 内容
      let releaseBody = "";
      if (hasUpdate) {
        try {
          const releaseResp = await fetch(
            `https://api.github.com/repos/moononnn/xianbuzhu/releases/tags/${tags[0].name}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "work-visit",
              },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (releaseResp.ok) {
            const release = await releaseResp.json();
            releaseBody = release.body || "";
          }
        } catch {
          /* release body 获取失败不影响主流程 */
        }
      }

      return json({
        success: true,
        current: currentVersion,
        latest: latestTag,
        hasUpdate,
        updateUrl: hasUpdate
          ? `https://github.com/moononnn/xianbuzhu/releases/tag/${tags[0].name}`
          : null,
        downloadUrl: hasUpdate
          ? `https://github.com/moononnn/xianbuzhu/archive/refs/tags/${tags[0].name}.zip`
          : null,
        releaseBody,
        message: hasUpdate
          ? `发现新版本 v${latestTag}！当前 v${currentVersion}`
          : "已是最新版本 ✨",
      });
    } catch (e) {
      console.error("[闲不住] 检查更新失败:", e.message || e);
      return json({
        success: false,
        error: e.message || "网络不可达",
        repoUrl: "https://github.com/moononnn/xianbuzhu",
      });
    }
  });
}

// ─── 版本号比较（semver） ───
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
