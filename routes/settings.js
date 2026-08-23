// routes/settings.js — 设置与杂项域路由
// /api/hearts*、/api/heart-settings、/api/temperament、/api/uninstall、/api/check-update、/api/avatar、/api/notes*

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadData,
  saveData,
  withDataLock,
} from "../lib/data.js";
import {
  getPartnerConfig,
  getVisiblePartnerConfig,
} from "../lib/config.js";
import {
  analyzePartnerTemperament,
  getHeartSummary,
  markHeartsRead,
} from "../lib/hearts.js";
import {
  createTemperamentConfig,
  getHeartRhythmOptions,
  getTemperamentOptions,
  normalizeHeartRhythm,
  normalizeTemperamentConfig,
  TEMPERAMENT_TAGS,
} from "../lib/temperament.js";
import { readBody, json } from "./_helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export function registerSettings(app, ctx) {

  // ════════════════════════════════════════
  //  GET /api/hearts — 获取最近的主动心意
  // ════════════════════════════════════════
  app.get("/api/hearts", (c) => {
    const data = loadData();
    const summary = getHeartSummary(data);
    if (summary.archivedChanged) saveData(data);
    return json({
      success: true,
      hearts: summary.hearts,
      omittedCount: summary.omittedCount,
      // 保留时长内全部展示，不再按数量截断；旧字段保留向后兼容，恒为空
      pastMessage: "",
    });
  });

  // ════════════════════════════════════════
  //  POST /api/hearts/read — 进入信箱时标记已读
  // ════════════════════════════════════════
  app.post("/api/hearts/read", (c) => {
    return withDataLock(async () => {
      const data = loadData();
      markHeartsRead(data);
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      return json({ success: true });
    });
  });

  // ════════════════════════════════════════
  //  GET/POST /api/heart-settings — 主动心意频率
  // ════════════════════════════════════════
  app.get("/api/heart-settings", (c) => {
    const data = loadData();
    return json({
      success: true,
      settings: {
        frequency: data.heartSettings?.frequency || "low",
      },
    });
  });

  app.post("/api/heart-settings", async (c) => {
    const input = await readBody(c);
    return withDataLock(async () => {
      const data = loadData();
      const frequency = input.frequency;
      if (frequency !== undefined && !["low", "medium", "high"].includes(frequency)) {
        return json({ success: false, error: "频率选项无效" }, 400);
      }
      const oldFrequency = data.heartSettings?.frequency || "low";
      data.heartSettings = {
        ...(data.heartSettings || {}),
        frequency: frequency || oldFrequency,
      };
      if (frequency && frequency !== oldFrequency) {
        data.heartPlan = { date: null, frequency, entries: [] };
      }
      if (!saveData(data)) return json({ success: false, error: "数据保存失败，请重试" }, 500);
      return json({ success: true, settings: data.heartSettings });
    });
  });

  // ════════════════════════════════════════
  //  GET/POST /api/temperament — 气质标签（只暴露人话，不暴露参数）
  // ════════════════════════════════════════
  function temperamentView(data) {
    const partnerConfig = getVisiblePartnerConfig(data);
    const partners = Object.entries(partnerConfig).map(([id, cfg]) => {
      const normalized = normalizeTemperamentConfig(cfg);
      return {
        id,
        name: cfg.name || id,
        surfaceTag: normalized.surfaceLayer.tag,
        innerTag: normalized.innerLayer.tag,
        source: normalized.temperamentSource,
        heartRhythm: normalized.heartRhythm,
      };
    });
    return {
      options: getTemperamentOptions(),
      rhythmOptions: getHeartRhythmOptions(),
      partners,
    };
  }

  app.get("/api/temperament", (c) => {
    const data = loadData();
    return json({ success: true, ...temperamentView(data) });
  });

  app.post("/api/temperament", async (c) => {
    const input = await readBody(c);
    const partnerId = input.partnerId;
    if (typeof partnerId !== "string" || !/^[A-Za-z0-9_-]+$/.test(partnerId)) {
      return json({ success: false, error: "助手 ID 无效" }, 400);
    }
    const current = loadData();
    const currentCfg = current.partnerConfig?.[partnerId];
    if (!currentCfg || currentCfg.hidden) {
      return json({ success: false, error: "这位助手当前不在闲不住列表里" }, 404);
    }
    if (input.rhythm !== undefined && normalizeHeartRhythm(input.rhythm) !== input.rhythm) {
      return json({ success: false, error: "心意节奏选项无效" }, 400);
    }

    if (input.mode === "auto") {
      const analyzed = await analyzePartnerTemperament(partnerId);
      const saved = await withDataLock(() => {
        const data = loadData();
        const cfg = data.partnerConfig?.[partnerId];
        if (!cfg || cfg.hidden) return false;
        cfg.surfaceLayer = analyzed.surfaceLayer;
        cfg.innerLayer = analyzed.innerLayer;
        cfg.temperamentSource = analyzed.temperamentSource;
        cfg.temperamentAnalyzedAt = new Date().toISOString();
        if (input.rhythm !== undefined) cfg.heartRhythm = input.rhythm;
        return saveData(data);
      });
      if (!saved) return json({ success: false, error: "保存失败" }, 500);
      return json({ success: true, ...temperamentView(loadData()), analyzed: true });
    }

    const surfaceTag = input.surfaceTag;
    const innerTag = input.innerTag;
    if (!TEMPERAMENT_TAGS.includes(surfaceTag) || !TEMPERAMENT_TAGS.includes(innerTag)) {
      return json({ success: false, error: "气质选项无效" }, 400);
    }
    const saved = await withDataLock(() => {
      const data = loadData();
      const cfg = data.partnerConfig?.[partnerId];
      if (!cfg || cfg.hidden) return false;
      const next = createTemperamentConfig(surfaceTag, innerTag, "user");
      next.heartRhythm = input.rhythm !== undefined
        ? input.rhythm
        : normalizeTemperamentConfig(cfg).heartRhythm;
      Object.assign(cfg, next);
      return saveData(data);
    });
    if (!saved) return json({ success: false, error: "保存失败" }, 500);
    return json({ success: true, ...temperamentView(loadData()) });
  });

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
