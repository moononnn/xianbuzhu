// 闲不住 — 活动扫描层
// 扫描今天所有助手的 session，提取标题和委派记录

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayStr } from './data.js';
import { getPartnerIds } from './config.js';

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const AGENTS_DIR = path.join(HANA_HOME, 'agents');

// ─── 扫描今天的活动 ───
// 返回 { agentId: { title, dispatched, dispatchedBy } }
export function scanTodayActivity(data) {
  const ts = todayStr();
  const partnerIds = getPartnerIds(data);
  const result = {};

  // 预读所有 session-titles.json
  const titleMap = {};
  for (const agentId of partnerIds) {
    const tp = path.join(AGENTS_DIR, agentId, 'sessions', 'session-titles.json');
    try {
      if (fs.existsSync(tp)) {
        Object.assign(titleMap, JSON.parse(fs.readFileSync(tp, 'utf-8')));
      }
    } catch {}
  }

  // 每个助手找今天的最近一条 session
  for (const agentId of partnerIds) {
    result[agentId] = { title: null, dispatched: null, dispatchedBy: null };
    const sessionsDir = path.join(AGENTS_DIR, agentId, 'sessions');
    let sessionFiles = [];

    try {
      const allFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);

      sessionFiles = allFiles
        .filter(f => {
          try {
            return f.startsWith(ts) ||
              fs.statSync(path.join(sessionsDir, f)).mtime >= todayMidnight;
          } catch { return false; }
        })
        .sort((a, b) => {
          try {
            return fs.statSync(path.join(sessionsDir, b)).mtime -
              fs.statSync(path.join(sessionsDir, a)).mtime;
          } catch { return 0; }
        });
    } catch { continue; }

    // 找标题
    for (const file of sessionFiles.slice(0, 3)) {
      try {
        const fullPath = path.join(sessionsDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');

        let label = titleMap[fullPath] || titleMap[file] || '';
        if (!label) {
          const sessMatch = content.match(/sess_[a-z0-9]+_[a-f0-9]+/);
          if (sessMatch && titleMap[sessMatch[0]]) label = titleMap[sessMatch[0]];
        }
        if (label) {
          result[agentId].title = label.length > 25 ? label.slice(0, 25) + '…' : label;
          break;
        }

        // 后备：第一条用户消息
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'message' && d.message?.role === 'user') {
              const parts = d.message?.content || [];
              const text = parts
                .map(p => typeof p === 'string' ? p : (p.text || ''))
                .filter(Boolean).join(' ');
              if (!text) continue;
              const clean = text
                .replace(/\[SessionFile\][\s\S]*?(\[attached_image:|$)/, '')
                .replace(/\[attached_image:[^\]]+\]/, '')
                .trim();
              if (!clean) continue;
              result[agentId].title = clean.length > 25 ? clean.slice(0, 25) + '…' : clean;
              break;
            }
          } catch {}
        }
        if (result[agentId].title) break;
      } catch {}
    }
  }

  // 扫描 subagent 委派记录
  for (const callerId of partnerIds) {
    const sessionsDir = path.join(AGENTS_DIR, callerId, 'sessions');
    let sessionFiles = [];
    try {
      const allFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      sessionFiles = allFiles
        .filter(f => {
          try {
            return f.startsWith(ts) ||
              fs.statSync(path.join(sessionsDir, f)).mtime >= todayMidnight;
          } catch { return false; }
        })
        .sort((a, b) => {
          try {
            return fs.statSync(path.join(sessionsDir, b)).mtime -
              fs.statSync(path.join(sessionsDir, a)).mtime;
          } catch { return 0; }
        });
    } catch { continue; }

    for (const file of sessionFiles.slice(0, 5)) {
      try {
        const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message' || d.message?.role !== 'assistant') continue;
            const contentItems = d.message?.content || [];
            for (const item of contentItems) {
              if (item.type !== 'toolCall' || item.name !== 'subagent') continue;
              const args = item.arguments || {};
              const target = args.agent;
              if (!target || !result[target]) continue;
              if (result[target].dispatched) continue;
              const task = args.task || '';
              let shortTask = task
                .replace(/^[^，。！？\n]{1,10}?[，:：]\s*/, '')
                .replace(/^(这是|这是关于|请你|请帮我|帮我|帮我一下)\s*/, '')
                .trim();
              const m = shortTask.match(/^[^。！？\n]+/);
              if (m) shortTask = m[0];
              shortTask = shortTask.length > 20 ? shortTask.slice(0, 20) + '...' : shortTask;
              result[target].dispatched = shortTask;
              result[target].dispatchedBy = callerId;
            }
          } catch {}
        }
      } catch {}
    }
  }

  return result;
}

// ─── 获取用户显示名称 ───
export function getUserDisplayName() {
  try {
    const usersPath = path.join(HANA_HOME, 'users.json');
    if (fs.existsSync(usersPath)) {
      const raw = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
      const u = (raw.users || []).find(u => u.userId === raw.defaultUserId);
      if (u?.displayName) return u.displayName;
    }
  } catch {}
  return 'user';
}