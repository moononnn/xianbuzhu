// 闲不住 — API 路由
// 所有后端 API 集中在此。数据读写只用 lib/data.js，不重复实现。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, saveData, nextId, todayStr, getToday, calcLightParticles, randomIdle, nowISO, resolveSessionId, randomTip } from '../lib/data.js';
import { getAvailableModels, getLLMConfig, saveLLMConfig, processVisitEvent, callLLM, generateBrainrot, fetchCustomModels } from '../lib/llm.js';
import { getPartnerConfig, getPartnerIds } from '../lib/config.js';
import { scanTodayActivity, getUserDisplayName } from '../lib/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');

// ─── 辅助 ───
async function readBody(c) {
  try { return await c.req.json(); } catch { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ─── 渲染页面 ───
function renderPage(token) {
  let css = '', js = '';
  try {
    css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf-8');
    js = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf-8')
      .replace(/<\/script>/gi, '<\\/script>');
  } catch (e) {
    return '<h1>资源加载失败</h1><p>' + e.message + '</p>';
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🌸 闲不住</title>
<style>${css}</style>
</head>
<body>
<div id="app"><div class="loading-spin">✨</div></div>
<script>window.__TOKEN=${JSON.stringify(token)};</script>
<script>${js}</script>
</body></html>`;
}

// ==========================================
//  路由注册
// ==========================================
export default async function registerRoutes(app, ctx = {}) {
  // ── 页面 ──
  app.get('/page', (c) => {
    const url = new URL(c.req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    return c.html(renderPage(token), 200);
  });

  // ════════════════════════════════════════
  //  GET /api/data — 展板数据
  // ════════════════════════════════════════
  app.get('/api/data', (c) => {
    const data = loadData();
    const today = getToday(data);
    const ts = todayStr();

    const activity = scanTodayActivity(data);
    const partnerConfig = getPartnerConfig(data);
    const userName = getUserDisplayName();

    // ── 扫描今日会话，统计每个助手的 effortLP ──
    const partnerIds = getPartnerIds(data);
    for (const agentId of partnerIds) {
      const sessionsDir = path.join(HANA_HOME, 'agents', agentId, 'sessions');
      let stats = { toolCalls: 0, charsOutput: 0, fileOps: 0, subagentDispatches: 0, milestones: [] };

      try {
        const files = fs.readdirSync(sessionsDir)
          .filter(f => f.endsWith('.jsonl') && f.startsWith(ts))
          .sort()
          .slice(-5); // 只看今天最新的 5 个会话

        for (const f of files) {
          const content = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.type === 'message') {
                if (d.message?.role === 'assistant') {
                  const items = d.message?.content || [];
                  for (const item of items) {
                    if (item.type === 'toolCall') stats.toolCalls++;
                    if (item.type === 'text') stats.charsOutput += (item.text || '').length;
                  }
                }
                if (d.message?.role === 'toolResult' && d.toolCallId) {
                  stats.fileOps++;
                }
              }
            } catch {}
          }
        }
      } catch {}

      const effortLP = calcLightParticles(stats);
      if (!today.partners[agentId]) {
        today.partners[agentId] = { contributed: false, narrative: '', effortLP: 0 };
      }
      today.partners[agentId].effortLP = effortLP;
    }

    // ── 计算总 effortLP ──
    let totalEffort = 0;
    for (const p of Object.values(today.partners)) {
      totalEffort += p.effortLP || 0;
    }
    today.totalEffortLP = totalEffort;
    today.totalLP = today.baseLP + totalEffort;
    saveData(data); // 保存统计结果

    const todayTotal = today.totalLP;
    const todayClaimed = today.claimed || 0;
    const newAvailable = Math.max(0, todayTotal - todayClaimed);

    const partners = [];
    for (const [id, info] of Object.entries(partnerConfig)) {
      const p = today.partners[id];
      const act = activity[id] || {};
      let active = !!p?.contributed;
      let doing = '';

      if (act.dispatched) {
        active = true;
        const byName = partnerConfig[act.dispatchedBy]?.name || act.dispatchedBy;
        doing = `被 ${byName} 派去做 ${act.dispatched}`;
      } else if (act.title) {
        active = true;
        doing = `正在和 ${userName} 讨论 ${act.title}`;
      } else if (p?.narrative) {
        active = true;
        doing = p.narrative;
      }

      if (!doing) {
        active = false;
        doing = randomIdle(data.idlePool || []);
      }

      // 检查是否有真实头像
      const avatarPath = path.join(HANA_HOME, 'agents', id, 'avatars', 'agent.png');
      const hasAvatar = fs.existsSync(avatarPath);

      partners.push({
        id, name: info.name, color: info.color,
        active, doing,
        avatarUrl: hasAvatar ? `/api/avatar/${id}` : '',
      });
    }

    const activeList = partners.filter(p => p.active);
    const idleList = partners.filter(p => !p.active);
    let sectionTitle = '';
    const a = activeList.length, i = idleList.length;

    if (a === 0) {
      const pool = ['大家好像都在摸鱼', '摸鱼时间到 ✨', '全员待机中', '安静得有点可怕', '今天好像都很闲'];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else if (i === 0) {
      const pool = ['全员都在认真干活 💪', '忙碌的一天', '大家都在努力中', '没有一个人在偷懒'];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else if (a === 1) {
      const pool = [
        `${activeList[0].name}在忙，其他人摸鱼中`,
        `只有${activeList[0].name}在干活`,
        `${activeList[0].name}好忙啊`,
      ];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else if (a === 2) {
      const pool = [
        `${activeList[0].name}和${activeList[1].name}在忙`,
        '有人在忙有人在摸鱼',
      ];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else {
      sectionTitle = `大家都在各忙各的${i > 0 ? `，只有${idleList.map(p => p.name).join('和')}在摸鱼` : ''}`;
    }

    saveData(data);
    // 是否有小纸条（控制小纸条按钮是否显示）
    const hasNotes = Object.values(data.notes || {}).some(arr => arr && arr.length > 0);

    // 是否有未读小纸条（自上次阅读后的新纸条）
    const lastReadTs = data.lastReadNotesTs || 0;
    const hasNewNotes = hasNotes && Object.values(data.notes || {}).some(arr =>
      arr && arr.some(n => {
        const createdAt = n.createdAt ? new Date(n.createdAt).getTime() : 0;
        return createdAt > lastReadTs;
      })
    );

    // 首次引导：从未打开过纸条弹窗 + 有新纸条
    const showNoteGuide = hasNewNotes && !data.lastReadNotesTs;

    return json({
      jar: data.jar,
      todayTotal,
      todayClaimed,
      newAvailable,
      tip: randomTip(),
      sectionTitle,
      partners,
      hasNotes,
      hasNewNotes,
      showNoteGuide,
      pendingPartners: [...new Set((data.pendingVisits || []).filter(v => v.status === 'pending').map(v => v.to))],
      shopItems: data.shopItems || [],
      interactItems: data.interactItems || [],
      prankItems: data.prankItems || [],
    });
  });

  // ════════════════════════════════════════
  //  GET /api/sessions — 会话列表
  // ════════════════════════════════════════
  app.get('/api/sessions', (c) => {
    const data = loadData();
    const partnerIds = getPartnerIds(data);
    const partnerConfig = getPartnerConfig(data);

    const groups = {};
    for (const agent of partnerIds) {
      const sessionsDir = path.join(HANA_HOME, 'agents', agent, 'sessions');
      const memDir = path.join(HANA_HOME, 'agents', agent, 'memory', 'summaries');

      // ── 读取该 agent 自己的 session-titles.json ──
      let agentTitles = {};
      const titlesPath = path.join(sessionsDir, 'session-titles.json');
      try {
        if (fs.existsSync(titlesPath)) {
          agentTitles = JSON.parse(fs.readFileSync(titlesPath, 'utf-8'));
        }
      } catch {}

      const list = [];

      // ── 处理以文件路径为键的旧版会话 ──
      let oldFiles = [];
      try {
        oldFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      } catch {}

      for (const f of oldFiles) {
        try {
          const fullPath = path.join(sessionsDir, f);
          const content = fs.readFileSync(fullPath, 'utf-8');

          let label = agentTitles[fullPath] || agentTitles[f] || '';

          // 从文件内容中找 sess_xxx 标题映射
          if (!label) {
            const sessMatches = content.matchAll(/sess_[a-z0-9]+_[a-f0-9]+/g);
            for (const sm of sessMatches) {
              const title = agentTitles[sm[0]];
              if (title) {
                label = title;
                break;
              }
            }
          }

          // 取首条用户消息
          if (!label) {
            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                if (d.type === 'message' && d.message?.role === 'user') {
                  const parts = d.message?.content || [];
                  const text = parts.map(p => typeof p === 'string' ? p : (p.text || '')).filter(Boolean).join(' ');
                  if (text) { label = text.length > 25 ? text.slice(0, 25) + '…' : text; break; }
                }
              } catch {}
            }
          }

          if (!label) {
            const match = f.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
            label = match ? match[1].replace(/T/, ' ') : f.slice(0, 20);
          }

          // 取最新消息时间
          let lastTs = '';
          try {
            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                if (d.type === 'message' && d.timestamp) {
                  if (!lastTs || d.timestamp > lastTs) lastTs = d.timestamp;
                }
              } catch {}
            }
          } catch {}

          list.push({ id: fullPath, label, lastTs: lastTs || f.slice(0, 16) });
        } catch {}
      }

      // ── 处理 sess_ 开头的新版会话（从摘要文件拿时间） ──
      for (const [key, title] of Object.entries(agentTitles)) {
        if (!key.startsWith('sess_')) continue;

        // 从 memory/summaries/ 读取摘要文件获取更新时间
        let lastTs = '';
        try {
          const summaryPath = path.join(memDir, key + '.json');
          if (fs.existsSync(summaryPath)) {
            const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
            lastTs = summary.updated_at || summary.source_time_range?.end || '';
          }
        } catch {}

        // 没有摘要文件或没有时间戳的 sess_ 条目跳过（不知道最后活动时间，排到最末尾）
        if (!lastTs) continue;

        list.push({
          id: key,
          label: title,
          lastTs,
        });
      }

      // 按最后活动时间排序，新→旧
      list.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
      // 取最新的 12 条
      list.splice(12);
      if (list.length > 0) {
        groups[agent] = {
          name: partnerConfig[agent]?.name || agent,
          sessions: list,
        };
      }
    }
    return json({ success: true, groups });
  });

  // ════════════════════════════════════════
  //  POST /api/claim — 领取光粒
  // ════════════════════════════════════════
  app.post('/api/claim', async (c) => {
    const data = loadData();
    const today = getToday(data);

    let totalEffort = 0;
    for (const p of Object.values(today.partners)) totalEffort += p.effortLP || 0;
    today.totalLP = today.baseLP + totalEffort;

    const claimed = today.claimed || 0;
    const toClaim = today.totalLP - claimed;
    if (toClaim <= 0) return json({ success: true, jar: data.jar, claimed: 0, message: '今天没有新光粒可以收 ✨' });

    today.claimed = claimed + toClaim;
    data.jar += toClaim;
    saveData(data);
    return json({ success: true, jar: data.jar, claimed: toClaim });
  });

  // ════════════════════════════════════════
  //  POST /api/visit — 互动 / 礼物 / 恶作剧
  // ════════════════════════════════════════
  app.post('/api/visit', async (c) => {
    const input = await readBody(c);
    const data = loadData();

    const { type, itemId, to, replyTarget } = input;

    if (!type || !itemId || !to) {
      return json({ success: false, error: '缺少必要参数' }, 400);
    }

    let item;
    if (type === 'interact') {
      item = (data.interactItems || []).find(i => i.id === itemId);
    } else if (type === 'prank') {
      item = (data.prankItems || []).find(i => i.id === itemId);
    } else if (type === 'gift') {
      item = (data.shopItems || []).find(i => i.id === itemId);
    }

    if (!item) return json({ success: false, error: '项目不存在' }, 400);

    // ── 恶作剧处理 ──
    if (type === 'prank') {
      if (itemId === 'unplug') {
        // 关机键：中断当前对话，同时走自治链路生成被恶作剧的回应
        try {
          const bus = ctx.bus || ctx._bus;
          if (bus && replyTarget) {
            bus.request?.('session:abort', { sessionPath: replyTarget, reason: '悄咪咪按了关机键 🔌' });
          }
        } catch (e) {
          console.error('[闲不住] abort 失败:', e?.message || e);
        }
        // 不 return，继续保存 visit 走自治链路
      } else if (itemId === 'brainrot') {
        // 脑洞袭击：不打断，直接生成奇怪话注入到对话框
        try {
          const bus = ctx.bus || ctx._bus;
          if (bus && replyTarget) {
            const sessionId = resolveSessionId(replyTarget);
            if (sessionId) {
              const brainrot = await generateBrainrot();
              if (brainrot) {
                await bus.request('session:send', {
                  text: `🧠 ${brainrot}`,
                  sessionId,
                });
              }
            }
          }
        } catch (e) {
          console.error('[闲不住] brainrot 注入失败:', e?.message || e);
        }
        return json({ success: true, prank: 'brainrot' });
      }
    }

    // ── 检查模型是否已配置（所有事件都需要闲不住模型） ──
    const llmOk = !!(data.llmConfig?.providerId && data.llmConfig?.modelId);
    if (!llmOk) {
      return json({ success: false, error: '请先打开闲不住页面底部「模型设置」配置模型后再使用' }, 400);
    }

    // ── 检查该对话框是否已有待处理的 visit ──
    // 如果有，后台自动催一下处理，不阻塞
    if (type === 'interact' || type === 'gift') {
      const existing = (data.pendingVisits || []).find(v => v.to === to && v.replyTarget === replyTarget && v.status === 'pending');
      if (existing) {
        // 后台异步触发旧 visit 的回应生成，不阻塞返回
        processVisitEvent(existing, existing.to).catch(err => {
          console.error('[闲不住] 催收处理失败:', err?.message || err);
        });
        return json({ success: false, error: '有未处理的互动消息，已经催ta收礼啦，下一轮再送吧' }, 400);
      }
    }

    // ── 光粒变动 ──
    if (type === 'gift') {
      if ((data.jar || 0) < item.price) {
        return json({ success: false, error: '光粒不够了 ✨' }, 400);
      }
      data.jar -= item.price;
      data.jar += 3; // 送礼回馈
    } else if (type === 'interact') {
      data.jar += 1; // 互动奖励
    }
    // 恶作剧不涉及光粒

    if (!data.pendingVisits) data.pendingVisits = [];
    const visit = {
      id: nextId(),
      type,
      itemId: item.id,
      itemName: item.name,
      icon: item.icon,
      price: item.price || 0,
      to,
      replyTarget: replyTarget || '',
      from: 'owner',
      createdAt: nowISO(),
      status: 'pending',
    };
    data.pendingVisits.push(visit);

    // ── 保存 ──
    saveData(data);

    // ── 闲不住自治：调模型处理（回应生成 + 小纸条） ──
    // 关机键同步等待 autoReply 生成，确保下次回复时能读到吐槽
    if (type === 'prank' && itemId === 'unplug') {
      try {
        await processVisitEvent(visit, to);
      } catch (e) {
        console.error('[闲不住] 关机键处理失败:', e?.message || e);
      }
    } else {
      // 其他事件不阻塞 API 返回
      processVisitEvent(visit, to).catch(err => {
        console.error('[闲不住] 异步处理事件失败:', err?.message || err);
      });
    }

    return json({
      success: true,
      visitId: visit.id,
      jar: data.jar,
      item: { id: item.id, icon: item.icon, name: item.name, type },
    });
  });

  // ════════════════════════════════════════
  //  POST /api/mark-read — 标记已读
  // ════════════════════════════════════════
  app.post('/api/mark-read', async (c) => {
    const input = await readBody(c);
    const data = loadData();

    const visit = (data.pendingVisits || []).find(v => v.id === input.id);
    if (visit && visit.status === 'pending') {
      visit.status = 'received';
      visit.receivedAt = nowISO();
      saveData(data);
      return json({ success: true });
    }
    return json({ success: false, error: '未找到或已处理' }, 400);
  });

  // ════════════════════════════════════════
  //  POST /api/update-narrative — 更新状态
  // ════════════════════════════════════════
  app.post('/api/update-narrative', async (c) => {
    const input = await readBody(c);
    const data = loadData();
    const today = getToday(data);
    const pid = input.partner || 'hanako';

    if (!today.partners[pid]) {
      today.partners[pid] = { contributed: false, narrative: '', effortLP: 0 };
    }
    today.partners[pid].narrative = input.narrative || '';
    today.partners[pid].contributed = true;
    saveData(data);
    return json({ success: true, partner: pid, narrative: today.partners[pid].narrative });
  });

  // ════════════════════════════════════════
  //  GET /api/llm-providers — 获取可用供应商和模型列表
  // ════════════════════════════════════════
  app.get('/api/llm-providers', (c) => {
    const providers = getAvailableModels();
    const config = getLLMConfig();
    // 把自定义配置也带回去，前端可以回显
    const data = loadData();
    const customRaw = data.llmCustom || {};
    const custom = customRaw.apiKey ? {
      baseUrl: customRaw.baseUrl,
      api: customRaw.api,
      modelId: customRaw.modelId,
      label: customRaw.label,
      hasApiKey: true,
      updatedAt: customRaw.updatedAt,
    } : customRaw;
    return json({ success: true, providers, selected: config, custom });
  });

  // ════════════════════════════════════════
  //  POST /api/llm-custom-fetch — 测试自定义连接并拉取模型
  // ════════════════════════════════════════
  app.post('/api/llm-custom-fetch', async (c) => {
    try {
      const input = await readBody(c);
      const models = await fetchCustomModels(input.baseUrl, input.apiKey, input.api || 'openai-completions');
      return json({ success: true, models });
    } catch (e) {
      return json({ success: false, error: e?.message || '连接失败' }, 500);
    }
  });

  // ════════════════════════════════════════
  //  POST /api/llm-supplement-key — 补填供应商 API Key
  // ════════════════════════════════════════
  app.post('/api/llm-supplement-key', async (c) => {
    try {
      const input = await readBody(c);
      if (!input.providerId || !input.apiKey) {
        return json({ success: false, error: '请填写 API Key' }, 400);
      }

      const data = loadData();
      if (!data.supplementKeys) data.supplementKeys = {};

      // 从 models.json 读取该供应商的 baseUrl 和 api
      const catalog = JSON.parse(fs.readFileSync(path.join(HANA_HOME, 'models.json'), 'utf-8'));
      const provider = catalog.providers?.[input.providerId];
      if (!provider) {
        return json({ success: false, error: '供应商信息不存在' }, 400);
      }

      data.supplementKeys[input.providerId] = {
        apiKey: input.apiKey,
        baseUrl: provider.baseUrl,
        api: provider.api,
        updatedAt: nowISO(),
      };

      // 同时也设为当前使用的模型
      if (input.modelId) {
        data.llmConfig = {
          providerId: input.providerId,
          modelId: input.modelId,
          updatedAt: nowISO(),
        };
      }

      saveData(data);
      return json({ success: true });
    } catch (e) {
      return json({ success: false, error: e?.message || '保存失败' }, 500);
    }
  });

  // ════════════════════════════════════════
  //  POST /api/llm-custom-save — 保存自定义供应商配置
  // ════════════════════════════════════════
  app.post('/api/llm-custom-save', async (c) => {
    try {
      const input = await readBody(c);
      if (!input.baseUrl || !input.apiKey || !input.modelId) {
        return json({ success: false, error: '请填写完整信息' }, 400);
      }

      const data = loadData();
      data.llmCustom = {
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        api: input.api || 'openai-completions',
        modelId: input.modelId,
        label: input.label || '自定义',
        updatedAt: nowISO(),
      };
      // 同时也更新 llmConfig，指向自定义
      data.llmConfig = {
        providerId: '__custom__',
        modelId: input.modelId,
        updatedAt: nowISO(),
      };
      saveData(data);
      return json({ success: true });
    } catch (e) {
      return json({ success: false, error: e?.message || '保存失败' }, 500);
    }
  });

  // ════════════════════════════════════════
  //  GET /api/llm-settings — 获取当前 LLM 配置
  // ════════════════════════════════════════
  app.get('/api/llm-settings', (c) => {
    const config = getLLMConfig();
    return json({ success: true, config });
  });

  // ════════════════════════════════════════
  //  GET /api/avatar/:agentId — 获取助手头像
  // ════════════════════════════════════════
  app.get('/api/avatar/:agentId', (c) => {
    const agentId = c.req.param('agentId');
    const avatarPath = path.join(HANA_HOME, 'agents', agentId, 'avatars', 'agent.png');
    try {
      if (fs.existsSync(avatarPath)) {
        const img = fs.readFileSync(avatarPath);
        return new Response(img, {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
        });
      }
    } catch {}
    return new Response(null, { status: 404 });
  });

  // ════════════════════════════════════════
  //  GET /api/notes — 获取小纸条列表
  // ════════════════════════════════════════
  app.get('/api/notes', (c) => {
    const data = loadData();
    const partnerConfig = getPartnerConfig(data);

    // 按助手整理，附带助手名字
    const result = {};
    for (const [partnerId, notes] of Object.entries(data.notes || {})) {
      result[partnerId] = {
        name: partnerConfig[partnerId]?.name || partnerId,
        color: partnerConfig[partnerId]?.color || '#999',
        notes: notes.slice().reverse(), // 最新的在前
      };
    }

    return json({ success: true, groups: result });
  });

  // ════════════════════════════════════════
  //  POST /api/notes/read — 标记小纸条已读
  // ════════════════════════════════════════
  app.post('/api/notes/read', (c) => {
    const data = loadData();
    data.lastReadNotesTs = Date.now();
    saveData(data);
    return json({ success: true });
  });

  // ════════════════════════════════════════
  //  POST /api/llm-settings — 保存 LLM 配置
  // ════════════════════════════════════════
  app.post('/api/llm-settings', async (c) => {
    const input = await readBody(c);
    if (!input.providerId || !input.modelId) {
      return json({ success: false, error: '请选择供应商和模型' }, 400);
    }
    saveLLMConfig({ providerId: input.providerId, modelId: input.modelId });
    return json({ success: true });
  });

  // ════════════════════════════════════════
  //  POST /api/llm-test — 测试模型连接
  // ════════════════════════════════════════
  app.post('/api/llm-test', async (c) => {
    try {
      const input = await readBody(c);
      const pid = input.providerId || '';
      const mid = input.modelId || '';
      if (!pid || !mid) {
        return json({ success: false, error: '请先选择供应商和模型' }, 400);
      }
      const result = await callLLM('请用一句话回应：你好，这是一条闲不住连接测试消息。只输出回应内容。', {
        providerId: pid,
        modelId: mid,
        temperature: 0.5,
        maxTokens: 100,
        timeout: 15000,
      });
      return json({ success: true, reply: result.trim() });
    } catch (e) {
      return json({ success: false, error: e?.message || '连接失败' }, 500);
    }
  });

  // ════════════════════════════════════════
  //  POST /api/uninstall — 彻底卸载（清理所有残留）
  // ════════════════════════════════════════
  app.post('/api/uninstall', async (c) => {
    try {
      // 1. 删除所有助手 identity.md 中的闲不住协议块
      const agentsDir = path.join(HANA_HOME, 'agents');
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const identityPath = path.join(agentsDir, entry.name, 'identity.md');
          if (!fs.existsSync(identityPath)) continue;
          let content = fs.readFileSync(identityPath, 'utf-8');
          const newContent = content.replace(
            /<!-- work-visit-protocol-v\d+ -->[\s\S]*?<!-- \/work-visit-protocol-v\d+ -->\s*/g,
            ''
          );
          if (newContent !== content) {
            fs.writeFileSync(identityPath, newContent, 'utf-8');
          }
        }
      }

      // 2. 删除数据目录
      const dataDir = path.join(HANA_HOME, 'data', 'work-visit');
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }

      // 3. 删除 skill 目录
      const skillDir = path.join(HANA_HOME, 'skills', 'work-visit');
      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }

      // 4. 清理所有助手 config.yaml 中的 work-visit skill 引用
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const configPath = path.join(agentsDir, entry.name, 'config.yaml');
          if (!fs.existsSync(configPath)) continue;
          let cfg = fs.readFileSync(configPath, 'utf-8');
          cfg = cfg.replace(/^\s+- work-visit\n/gm, '');
          fs.writeFileSync(configPath, cfg, 'utf-8');
        }
      }

      return json({ success: true, message: '清理完成，请关闭 Hana 并手动删除插件目录' });
    } catch (e) {
      console.error('[闲不住] 卸载清理失败:', e.message);
      return json({ success: false, error: e.message }, 500);
    }
  });

}