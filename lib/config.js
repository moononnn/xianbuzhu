// 闲不住 — 配置层
// 自动扫描 agents 目录获取伙伴列表，不硬编码

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_VARIABLES } from './data.js';
import { isValidAgentId } from './validate.js';

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const AGENTS_DIR = path.join(HANA_HOME, 'agents');

// ─── 默认伙伴颜色映射 ───
const DEFAULT_COLORS = [
  '#4CAF50', '#E91E63', '#9C27B0', '#FF9800', '#2196F3',
  '#00BCD4', '#795548', '#607D8B', '#F44336', '#8BC34A',
];

// ─── 扫描 agents 目录 ───
export function scanPartners() {
  const partners = {};
  let colorIdx = 0;

  try {
    if (!fs.existsSync(AGENTS_DIR)) return partners;
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 与接口校验同一规则：非法目录名（含路径分隔符/特殊键）不收入伙伴列表，
      // 避免“展板显示了但接口拒绝”的规则不一致
      if (!isValidAgentId(entry.name)) continue;
      const configPath = path.join(AGENTS_DIR, entry.name, 'config.yaml');
      if (!fs.existsSync(configPath)) continue;

      // 读取 config.yaml 获取显示名称
      let displayName = entry.name;
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
        if (nameMatch) displayName = nameMatch[1].trim();
      } catch {}

      partners[entry.name] = {
        name: displayName,
        color: DEFAULT_COLORS[colorIdx % DEFAULT_COLORS.length],
        variables: { ...DEFAULT_VARIABLES },
      };
      colorIdx++;
    }
  } catch (e) {
    console.error('[闲不住] 扫描 agents 失败:', e.message);
  }

  return partners;
}

// ─── 获取伙伴列表（优先已保存的配置，否则扫描） ───
export function getPartnerConfig(data) {
  if (data.partnerConfig && Object.keys(data.partnerConfig).length > 0) {
    return data.partnerConfig;
  }
  const scanned = scanPartners();
  if (Object.keys(scanned).length > 0) {
    data.partnerConfig = scanned;
    return scanned;
  }
  // 兜底：使用默认配置
  return {
    hanako: { name: '小花', color: '#4CAF50', variables: { ...DEFAULT_VARIABLES } },
  };
}

// ─── 获取伙伴标签列表 ───
export function getPartnerIds(data) {
  const config = getPartnerConfig(data);
  return Object.keys(config);
}

// ─── 获取显示名称 ───
export function getDisplayName(data, agentId) {
  const config = getPartnerConfig(data);
  return config[agentId]?.name || agentId;
}