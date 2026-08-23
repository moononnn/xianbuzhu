// 闲不住 — 配置层
// 自动扫描 agents 目录获取伙伴列表，不硬编码

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_VARIABLES } from './data.js';

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

// ─── 获取当前闲不住列表：隐藏助手不参与工作与心意链路 ───
export function getVisiblePartnerConfig(data) {
  const config = getPartnerConfig(data);
  return Object.fromEntries(
    Object.entries(config).filter(([, cfg]) => !cfg?.hidden),
  );
}

export function getPartnerIds(data) {
  return Object.keys(getVisiblePartnerConfig(data));
}

export function isVisiblePartner(data, partnerId) {
  return Boolean(getVisiblePartnerConfig(data)[partnerId]);
}

// ─── 刷新伙伴列表：以扫描结果为准，找回所有伙伴（清除 hidden），
//     保留旧配置的颜色/变量/装饰 ───
export function mergeRefreshedPartners(oldConfig, scanned) {
  const out = { ...(oldConfig || {}) };
  for (const [id, info] of Object.entries(scanned)) {
    const oldCfg = out[id] || {};
    const merged = {
      name: info.name,
      color: oldCfg.color || info.color,
      variables: oldCfg.variables || info.variables,
    };
    if (oldCfg.decorations) merged.decorations = oldCfg.decorations;
    if (oldCfg.surfaceLayer) merged.surfaceLayer = oldCfg.surfaceLayer;
    if (oldCfg.innerLayer) merged.innerLayer = oldCfg.innerLayer;
    if (oldCfg.temperamentSource) merged.temperamentSource = oldCfg.temperamentSource;
    if (oldCfg.temperamentAnalyzedAt) merged.temperamentAnalyzedAt = oldCfg.temperamentAnalyzedAt;
    if (oldCfg.heartRhythm) merged.heartRhythm = oldCfg.heartRhythm;
    out[id] = merged; // 不保留 hidden：所有伙伴重新出现
  }
  return out;
}

// ─── 获取显示名称 ───
export function getDisplayName(data, agentId) {
  const config = getPartnerConfig(data);
  return config[agentId]?.name || agentId;
}