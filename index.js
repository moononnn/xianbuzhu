// 闲不住 — 插件入口
// 启动时扫描 agents + 注册工具

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData, saveData, describeMood } from "./lib/data.js";
import { getPartnerIds, scanPartners } from "./lib/config.js";
import { startHeartbeat } from "./lib/heartbeat.js";
import { stopFusionCoordinator } from "./lib/fusion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

// 闲不住 — 默认导出 class
// Hana runtime 要求 export default class，实例化后调用 onload

class WorkVisitPlugin {
  async onload() {
    // ⚠ Hana runtime 调 c.onload() 不传参，ctx 从 this.ctx 取
    console.log("[闲不住] 插件加载完成");

    // 每次启动重新扫描伙伴列表
    try {
      const data = loadData();
      const scanned = scanPartners();
      if (Object.keys(scanned).length > 0) {
        const oldConfig = data.partnerConfig || {};
        for (const [id, info] of Object.entries(scanned)) {
          if (oldConfig[id]?.color) info.color = oldConfig[id].color;
          if (oldConfig[id]?.variables)
            info.variables = oldConfig[id].variables;
          if (oldConfig[id]?.decorations)
            info.decorations = oldConfig[id].decorations;
          if (oldConfig[id]?.hidden) info.hidden = oldConfig[id].hidden;
          if (oldConfig[id]?.surfaceLayer)
            info.surfaceLayer = oldConfig[id].surfaceLayer;
          if (oldConfig[id]?.innerLayer)
            info.innerLayer = oldConfig[id].innerLayer;
          if (oldConfig[id]?.temperamentSource)
            info.temperamentSource = oldConfig[id].temperamentSource;
          if (oldConfig[id]?.temperamentAnalyzedAt)
            info.temperamentAnalyzedAt = oldConfig[id].temperamentAnalyzedAt;
          if (oldConfig[id]?.heartRhythm)
            info.heartRhythm = oldConfig[id].heartRhythm;
          if (oldConfig[id]?.statusAutonomy)
            info.statusAutonomy = oldConfig[id].statusAutonomy;
          if (Array.isArray(oldConfig[id]?.unlockedStatuses))
            info.unlockedStatuses = oldConfig[id].unlockedStatuses;
          if (Array.isArray(oldConfig[id]?.customStatuses))
            info.customStatuses = oldConfig[id].customStatuses;
        }
        const configChanged = JSON.stringify(oldConfig) !== JSON.stringify(scanned);
        if (configChanged) {
          data.partnerConfig = scanned;
          saveData(data);
        }
        console.log(
          "[闲不住] 已扫描 " + Object.keys(scanned).length + " 个伙伴"
          + (configChanged ? "（配置已更新）" : "（配置未变化）"),
        );
      }
    } catch (e) {
      console.error("[闲不住] 初始化伙伴配置失败:", e.message);
    }

    // ── 启动时清理所有残留（兼容旧版本） ──
    try {
      const agentsDir = path.join(HANA_HOME, "agents");
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (!fs.existsSync(path.join(agentsDir, entry.name, "config.yaml")))
            continue;

          // 清理 config.yaml 中的 work-visit skill 引用
          const configPath = path.join(agentsDir, entry.name, "config.yaml");
          try {
            let cfg = fs.readFileSync(configPath, "utf-8");
            const newCfg = cfg.replace(/^\s+- work-visit\n/gm, "");
            if (newCfg !== cfg) {
              fs.writeFileSync(configPath, newCfg, "utf-8");
              console.log(
                `[闲不住] 已清理 ${entry.name} config.yaml 中的 work-visit 引用`,
              );
            }
          } catch (e) {
            console.error(
              `[闲不住] 清理 ${entry.name} config.yaml 失败:`,
              e.message,
            );
          }

          // 清理 identity.md 中的旧协议块（非侵入式：不再注入任何协议到助手性格文件）
          const identityPath = path.join(agentsDir, entry.name, "identity.md");
          try {
            if (fs.existsSync(identityPath)) {
              let content = fs.readFileSync(identityPath, "utf-8");
              // 删除所有旧的闲不住协议块（v1/v2/v3）
              let newContent = content.replace(
                /<!-- work-visit-protocol-v\d+ -->[\s\S]*?<!-- \/work-visit-protocol-v\d+ -->\s*/g,
                "",
              );
              // 删除极简协议块（v2.3 之前的注入残留，现在不再需要）
              newContent = newContent.replace(
                /<!-- work-visit-minimal -->[\s\S]*?<!-- \/work-visit-minimal -->\s*/g,
                "",
              );
              if (newContent !== content) {
                fs.writeFileSync(identityPath, newContent, "utf-8");
                console.log(
                  `[闲不住] 已清理 ${entry.name} identity.md 中的闲不住协议残留`,
                );
              }
            }
          } catch (e) {
            console.error(
              `[闲不住] 清理 ${entry.name} identity.md 失败:`,
              e.message,
            );
          }
        }
      }

      // 删除全局 skill 目录（如果存在）
      const globalSkillDir = path.join(HANA_HOME, "skills", "work-visit");
      if (fs.existsSync(globalSkillDir)) {
        fs.rmSync(globalSkillDir, { recursive: true, force: true });
        console.log("[闲不住] 已删除全局 skill 目录: " + globalSkillDir);
      }

      console.log("[闲不住] 残留清理完成");
    } catch (e) {
      console.error("[闲不住] 残留清理失败:", e.message);
    }

    console.log("[闲不住] 推送模式已启用，所有互动/礼物/恶作剧走系统推送");

    // ── 漂流瓶独立插件联动桥（只读、版本化；未安装漂流瓶则无人调用，无副作用） ──
    this.registerBridgeHandlers();

    // ── 主动心意心跳：低频、可停止，错过不补 ──
    this._heartbeatStop?.();
    this._heartbeatStop = startHeartbeat(this.ctx || {});
    console.log("[闲不住] 主动心意心跳已启动");
  }

  // 给「漂流瓶」独立插件提供两个只读桥：
  //   work-visit:status:v1    → 各助手模糊状态（心情/缘由，软影响用，不给数值）
  //   work-visit:sea-export:v1 → 旧海瓶子列表（一次性迁移用，只读不删）
  registerBridgeHandlers() {
    const ctx = this.ctx;
    if (!ctx?.bus?.handle) {
      console.log("[闲不住] bus.handle 不可用，跳过漂流瓶桥注册");
      return;
    }
    try {
      this._bridgeUnregisters = this._bridgeUnregisters || [];
      this._bridgeUnregisters.push(
        ctx.bus.handle("work-visit:status:v1", () => {
          try {
            const data = loadData();
            const partners = {};
            const visibleIds = new Set(getPartnerIds(data));
            for (const [id, cfg] of Object.entries(data.partnerConfig || {})) {
              if (!visibleIds.has(id)) continue;
              const vars = cfg?.variables || {};
              partners[id] = {
                moodText: describeMood(vars.mood),
                moodReason: vars.moodReason || "",
              };
            }
            return { ok: true, data: { partners } };
          } catch (e) {
            console.error("[闲不住] status 桥失败:", e?.message || e);
            return { ok: false, error: "闲不住状态读取失败" };
          }
        }),
      );
      this._bridgeUnregisters.push(
        ctx.bus.handle("work-visit:sea-export:v1", () => {
          try {
            const data = loadData();
            return { ok: true, data: { bottles: data.bottles || [] } };
          } catch (e) {
            console.error("[闲不住] sea-export 桥失败:", e?.message || e);
            return { ok: false, error: "旧海数据读取失败" };
          }
        }),
      );
      console.log("[闲不住] 漂流瓶联动桥已注册（status + sea-export）");
    } catch (e) {
      console.error("[闲不住] 注册漂流瓶桥失败:", e?.message || e);
    }
  }

  async onunload() {
    this._heartbeatStop?.();
    this._heartbeatStop = null;
    await stopFusionCoordinator({ restore: true, force: true });
    for (const un of this._bridgeUnregisters || []) {
      try {
        if (typeof un === "function") un();
      } catch (e) {
        console.error("[闲不住] 注销桥失败:", e?.message || e);
      }
    }
    this._bridgeUnregisters = [];
  }
}

export default WorkVisitPlugin;
