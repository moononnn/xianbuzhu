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
      }
      data.partnerConfig = scanned;
      saveData(data);
      console.log('[闲不住] 已扫描 ' + Object.keys(scanned).length + ' 个伙伴');
    }
  } catch (e) {
    console.error('[闲不住] 初始化伙伴配置失败:', e.message);
  }

  // ── 注入闲不住协议到每个助手的 identity.md（幂等） ──
  const IDENTITY_PROTOCOL_MARKER = '<!-- work-visit-protocol-v3 -->';
  const IDENTITY_PROTOCOL_BLOCK = `${IDENTITY_PROTOCOL_MARKER}

## 闲不住强制协议

每次你准备回复一条消息之前，**必须**调用 work-visit_check-visits 工具（不带参数），查看是否有待回应的互动/礼物/恶作剧。

返回的 visits 中可能包含 **autoReply** 字段（闲不住已预先生成的回应文本），在回复中自然地融入即可。如果没有 autoReply 字段，说明闲不住还在处理中，正常回应即可。

如果返回空，照常回复即可。

全部处理完毕后，用 markReadAll=true 标记已读后再继续作答。

这条规则由"闲不住"插件管理，卸载插件时会自动清理。请勿手动删除此区块。

<!-- /work-visit-protocol-v3 -->
`;

  function injectProtocolToAgent(agentDir) {
    const identityPath = path.join(agentDir, 'identity.md');
    try {
      // 跳过没有 identity.md 的 agent（避免误创建）
      if (!fs.existsSync(identityPath)) return false;
      let content = fs.readFileSync(identityPath, 'utf-8');

      // 先删除所有旧的闲不住协议块（v1/v2/v3），避免多版本共存污染系统提示
      content = content.replace(
        /<!-- work-visit-protocol-v\d+ -->[\s\S]*?<!-- \/work-visit-protocol-v\d+ -->\s*/g,
        ''
      );

      // 如果清理后已经包含当前版本标记（实际上不会，因为刚被删了），跳过
      if (content.includes(IDENTITY_PROTOCOL_MARKER)) return false;

      // 协议放在 identity.md 最前面，确保在系统提示中尽早出现
      const newContent = IDENTITY_PROTOCOL_BLOCK + '\n' + content;
      const tmp = identityPath + '.tmp';
      fs.writeFileSync(tmp, newContent, 'utf-8');
      fs.renameSync(tmp, identityPath);
      return true;
    } catch (e) {
      console.error(`[闲不住] 注入 ${path.basename(agentDir)} 协议失败:`, e.message);
      return false;
    }
  }

  function injectProtocolToAllAgents() {
    try {
      const agentsDir = path.join(HANA_HOME, 'agents');
      if (!fs.existsSync(agentsDir)) return;
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      let total = 0, patched = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!fs.existsSync(path.join(agentsDir, entry.name, 'config.yaml'))) continue;
        total++;
        if (injectProtocolToAgent(path.join(agentsDir, entry.name))) patched++;
      }
      if (patched > 0) {
        console.log(`[闲不住] 已为 ${patched}/${total} 个助手注入闲不住协议到 identity.md`);
      } else if (total > 0) {
        console.log(`[闲不住] ${total} 个助手的 identity.md 已含闲不住协议`);
      }
    } catch (e) {
      console.error('[闲不住] 批量注入协议失败:', e.message);
    }
  }

  injectProtocolToAllAgents();

  // ── 安装闲不住 skill 并启用给所有助手 ──
  try {
    const skillDir = path.join(HANA_HOME, 'skills', 'work-visit');
    const skillFile = path.join(skillDir, 'SKILL.md');

    // 如果全局 skill 不存在，从插件内置的 skills/ 自动复制
    if (!fs.existsSync(skillFile)) {
      const builtinSkill = path.join(__dirname, 'skills', 'work-visit', 'SKILL.md');
      if (fs.existsSync(builtinSkill)) {
        if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
        fs.copyFileSync(builtinSkill, skillFile);
        console.log('[闲不住] 已自动安装 skill 到 ' + skillDir);
      }
    }

    if (fs.existsSync(skillFile)) {
      // 给所有助手启用 work-visit skill
      const agentsDir = path.join(HANA_HOME, 'agents');
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        let enabled = 0;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const configPath = path.join(agentsDir, entry.name, 'config.yaml');
          if (!fs.existsSync(configPath)) continue;
          try {
            let cfg = fs.readFileSync(configPath, 'utf-8');
            if (cfg.includes('work-visit')) continue;
            // 在 skills.enabled 列表中添加
            cfg = cfg.replace(
              /(skills:\s*\n\s+enabled:\s*\n)/,
              '$1    - work-visit\n'
            );
            fs.writeFileSync(configPath, cfg, 'utf-8');
            enabled++;
          } catch (e) {
            console.error(`[闲不住] ${entry.name} skill 启用失败:`, e.message);
          }
        }
        if (enabled > 0) console.log(`[闲不住] 已为 ${enabled} 个助手启用 work-visit skill`);
      }
    }
  } catch (e) {
    console.error('[闲不住] skill 安装失败:', e.message);
  }
  }
}

export default WorkVisitPlugin;
