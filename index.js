// 闲不住 — 插件入口
// 启动时扫描 agents + 注册工具

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, saveData } from './lib/data.js';
import { scanPartners } from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');

// 闲不住 — 默认导出 class
// Hana runtime 要求 export default class，实例化后调用 onload

class WorkVisitPlugin {
  async onload() {
    // ⚠ Hana runtime 调 c.onload() 不传参，ctx 从 this.ctx 取
    console.log('[闲不住] 插件加载完成');

  // 每次启动重新扫描伙伴列表
  try {
    const data = loadData();
    const scanned = scanPartners();
    if (Object.keys(scanned).length > 0) {
      const oldConfig = data.partnerConfig || {};
      for (const [id, info] of Object.entries(scanned)) {
        if (oldConfig[id]?.color) info.color = oldConfig[id].color;
        if (oldConfig[id]?.variables) info.variables = oldConfig[id].variables;
        if (oldConfig[id]?.decorations) info.decorations = oldConfig[id].decorations;
      }
      data.partnerConfig = scanned;
      saveData(data);
      console.log('[闲不住] 已扫描 ' + Object.keys(scanned).length + ' 个伙伴');
    }
  } catch (e) {
    console.error('[闲不住] 初始化伙伴配置失败:', e.message);
  }

  // ── 启动时清理所有残留（兼容旧版本） ──
  try {
    const agentsDir = path.join(HANA_HOME, 'agents');
    if (fs.existsSync(agentsDir)) {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!fs.existsSync(path.join(agentsDir, entry.name, 'config.yaml'))) continue;

        // 清理 config.yaml 中的 work-visit skill 引用
        const configPath = path.join(agentsDir, entry.name, 'config.yaml');
        try {
          let cfg = fs.readFileSync(configPath, 'utf-8');
          const newCfg = cfg.replace(/^\s+- work-visit\n/gm, '');
          if (newCfg !== cfg) {
            fs.writeFileSync(configPath, newCfg, 'utf-8');
            console.log(`[闲不住] 已清理 ${entry.name} config.yaml 中的 work-visit 引用`);
          }
        } catch (e) {
          console.error(`[闲不住] 清理 ${entry.name} config.yaml 失败:`, e.message);
        }

        // 清理 identity.md 中的旧协议块，替换为极简协议（仅保留关机键所需）
        const identityPath = path.join(agentsDir, entry.name, 'identity.md');
        try {
          if (fs.existsSync(identityPath)) {
            let content = fs.readFileSync(identityPath, 'utf-8');
            // 删除所有旧的闲不住协议块（v1/v2/v3）
            let newContent = content.replace(
              /<!-- work-visit-protocol-v\d+ -->[\s\S]*?<!-- \/work-visit-protocol-v\d+ -->\s*/g,
              ''
            );
            // 删除可能残留的极简协议（防重复）
            newContent = newContent.replace(
              /<!-- work-visit-minimal -->[\s\S]*?<!-- \/work-visit-minimal -->\s*/g,
              ''
            );
            // 注入极简协议：仅针对「重启！」场景，不侵入正常对话
            const MINIMAL_PROTOCOL = '<!-- work-visit-minimal -->\n如果用户发了「重启！」：先调 work-visit_check-visits 工具查看有无演出剧本，按剧本内容回复。\n<!-- /work-visit-minimal -->\n\n';
            newContent = MINIMAL_PROTOCOL + newContent;
            fs.writeFileSync(identityPath, newContent, 'utf-8');
            console.log(`[闲不住] 已替换 ${entry.name} identity.md 协议为极简版（仅重启指令）`);
          }
        } catch (e) {
          console.error(`[闲不住] 更新 ${entry.name} identity.md 失败:`, e.message);
        }
      }
    }

    // 删除全局 skill 目录（如果存在）
    const globalSkillDir = path.join(HANA_HOME, 'skills', 'work-visit');
    if (fs.existsSync(globalSkillDir)) {
      fs.rmSync(globalSkillDir, { recursive: true, force: true });
      console.log('[闲不住] 已删除全局 skill 目录: ' + globalSkillDir);
    }

    console.log('[闲不住] 残留清理完成');
  } catch (e) {
    console.error('[闲不住] 残留清理失败:', e.message);
  }

  console.log('[闲不住] 推送模式已启用，所有互动/礼物/恶作剧走系统推送');
  }
}

export default WorkVisitPlugin;
