// 闲不住 — API 路由
// 所有后端 API 集中在此。数据读写只用 lib/data.js，不重复实现。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, saveData, nextId, todayStr, getToday, calcLightParticles, randomIdle, nowISO, randomTip, findLatestSessionPath, getRechargeTip, getRechargeAutoReply, isRechargedToday, markRechargedToday } from '../lib/data.js';
import { getAvailableModels, getLLMConfig, saveLLMConfig, processVisitEvent, callLLM, generateBrainrot, generateCrashReply, fetchCustomModels, encryptKey } from '../lib/llm.js';
import { getPartnerConfig, getPartnerIds } from '../lib/config.js';
import { scanTodayActivity, getUserDisplayName } from '../lib/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');

// ─── 通过 session-manifest.db 将最新会话文件解析为 sess_xxx ID ───
async function findLatestSessionId(agentId) {
  try {
    const latestPath = findLatestSessionPath(agentId);
    if (!latestPath) return '';

    // 方案1：从 session-manifest.db 查询（准确）
    const manifestPath = path.join(HANA_HOME, 'session-manifest.db');
    if (fs.existsSync(manifestPath)) {
      try {
        const { execFileSync } = await import('node:child_process');
        const sql = `SELECT session_id FROM session_manifests WHERE current_locator_path = '${latestPath.replace(/'/g, "''")}' LIMIT 1;`;
        const result = execFileSync('sqlite3', [manifestPath, sql], {
          encoding: 'utf8', timeout: 5000, windowsHide: true,
        }).trim();
        if (result && result.startsWith('sess_')) {
          return result;
        }
      } catch (e) {
        console.error('[闲不住] manifest 查询失败:', e?.message || e);
      }
    }

    // 方案2：从 session-titles.json 取最新的 sess_xxx（备选）
    const titlesPath = path.join(HANA_HOME, 'agents', agentId, 'sessions', 'session-titles.json');
    if (fs.existsSync(titlesPath)) {
      try {
        const raw = fs.readFileSync(titlesPath, 'utf-8');
        const titles = JSON.parse(raw);
        let latestSess = '';
        for (const key of Object.keys(titles)) {
          if (key.startsWith('sess_') && key > latestSess) {
            latestSess = key;
          }
        }
        if (latestSess) return latestSess;
      } catch (e) {
        console.error('[闲不住] session-titles 解析失败:', e?.message || e);
      }
    }

    return '';
  } catch (e) {
    console.error('[闲不住] 解析 sess_xxx ID 失败:', e?.message || e);
    return '';
  }
}

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
<script>window.__TOKEN=${JSON.stringify(token).replace(/</g, '\\u003c')};</script>
<script>${js}</script>
</body></html>`;
}

// ==========================================
//  路由注册
// ==========================================
export default async function registerRoutes(app, ctx = {}) {
  // 读取插件版本号
  let pluginVersion = '0.1.0';
  try {
    const manifestPath = path.join(__dirname, '..', 'manifest.json');
    pluginVersion = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).version || '0.1.0';
  } catch (e) {
    console.error('[闲不住] 读取版本失败:', e.message);
  }

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

      // 装饰数据迁移（兼容旧格式 → 新格式）
      var deco = info.decorations;
      if (deco && !deco.owned) {
        // 旧格式: { avatarFrame: 'id', cardBg: null, title: null }
        var newDeco = { owned: { avatarFrame: [], cardBg: [], title: [] }, equipped: { avatarFrame: null, cardBg: null, title: null } };
        if (deco.avatarFrame) { newDeco.owned.avatarFrame.push(deco.avatarFrame); newDeco.equipped.avatarFrame = deco.avatarFrame; }
        if (deco.cardBg) { newDeco.owned.cardBg.push(deco.cardBg); newDeco.equipped.cardBg = deco.cardBg; }
        if (deco.title) { newDeco.owned.title.push(deco.title); newDeco.equipped.title = deco.title; }
        info.decorations = newDeco;
        deco = newDeco;
      }

      partners.push({
        id, name: info.name, color: info.color,
        active, doing,
        avatarUrl: hasAvatar ? `/api/avatar/${id}` : '',
        variables: info.variables || null,
        decorations: deco || { owned: { avatarFrame: [], cardBg: [], title: [] }, equipped: { avatarFrame: null, cardBg: null, title: null } },
        recharged: isRechargedToday(data, id),
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
      version: pluginVersion,
      tip: randomTip(),
      sectionTitle,
      partners,
      hasNotes,
      hasNewNotes,
      showNoteGuide,
      pendingPartners: [...new Set((data.pendingVisits || []).filter(v => v.status === 'pending').map(v => v.to))],
      pendingDetails: (data.pendingVisits || [])
        .filter(v => v.status === 'pending')
        .map(v => ({ id: v.id, to: v.to, type: v.type, itemId: v.itemId, itemName: v.itemName, icon: v.icon, createdAt: v.createdAt })),
      shopItems: data.shopItems || [],
      interactItems: data.interactItems || [],
      prankItems: data.prankItems || [],
      decorationItems: data.decorationItems || [],
    });
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
  //  POST /api/visit — 互动 / 礼物 / 恶作剧（推送模式）
  //  不再依赖 pendingVisits + check-visits，直接推送到助手对话框
  // ════════════════════════════════════════

  // ─── 推送消息到目标助手的对话框 ───
  async function pushToAgent(agentId, text) {
    try {
      const bus = ctx.bus || ctx._bus;
      if (!bus) { console.warn('[闲不住] 推送失败: bus 不可用'); return false; }
      const sessionId = await findLatestSessionId(agentId);
      if (!sessionId) { console.warn(`[闲不住] 推送失败: 未找到 ${agentId} 的会话 ID`); return false; }
      await bus.request('session:send', { text, sessionId });
      console.log(`[闲不住] 推送成功 → ${agentId} 会话 ${sessionId.slice(0, 20)}...`);
      return true;
    } catch (e) {
      console.error('[闲不住] 推送失败:', e?.message || e);
      return false;
    }
  }

  app.post('/api/visit', async (c) => {
    const input = await readBody(c);
    const data = loadData();

    const { type, itemId, to } = input;

    if (!type || !itemId || !to) {
      return json({ success: false, error: '缺少必要参数' }, 400);
    }

    // 输入校验：type 白名单 + 长度限制
    const validTypes = ['interact', 'gift', 'prank'];
    if (!validTypes.includes(type)) {
      return json({ success: false, error: '无效的互动类型' }, 400);
    }
    if (typeof itemId !== 'string' || itemId.length > 50 ||
        typeof to !== 'string' || to.length > 100) {
      return json({ success: false, error: '参数格式错误' }, 400);
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

    // ── 恶作剧前置处理 ──
    if (type === 'prank' && itemId === 'brainrot') {
      // 扣光粒
      const prankCost = 3;
      if ((data.jar || 0) < prankCost) {
        return json({ success: false, error: '光粒不够了 ✨' }, 400);
      }
      data.jar -= prankCost;

      // 生成怪话
      const brainrotText = await generateBrainrot();
      if (!brainrotText) {
        return json({ success: false, error: '怪话生成失败' }, 500);
      }

      // 推送
      const ok = await pushToAgent(to, brainrotText);

      // 创建 visit 记录并异步修改变量
      if (!data.pendingVisits) data.pendingVisits = [];
      const visit = {
        id: nextId(),
        type,
        itemId: item.id,
        itemName: item.name,
        icon: item.icon,
        price: 0,
        to,
        from: 'owner',
        createdAt: nowISO(),
        status: 'completed',
      };
      data.pendingVisits.push(visit);
      saveData(data);

      processVisitEvent(visit, to).catch(err => {
        console.error('[闲不住] 脑洞袭击变量更新失败:', err?.message || err);
      });

      if (!ok) {
        return json({ success: true, jar: data.jar, brainrot: brainrotText, injected: false });
      }
      return json({ success: true, jar: data.jar, injected: true });
    }

    // ── 检查模型是否已配置 ──
    const llmOk = !!(data.llmConfig?.providerId && data.llmConfig?.modelId);
    if (!llmOk) {
      return json({ success: false, error: '请先打开闲不住页面底部「模型设置」配置模型后再使用' }, 400);
    }

    // ── 光粒变动 ──
    if (type === 'gift') {
      if ((data.jar || 0) < item.price) {
        return json({ success: false, error: '光粒不够了 ✨' }, 400);
      }
      data.jar -= item.price;
      data.jar += 3;
    } else if (type === 'prank') {
      const prankCost = itemId === 'unplug' ? 5 : 3;
      if ((data.jar || 0) < prankCost) {
        return json({ success: false, error: '光粒不够了 ✨' }, 400);
      }
      data.jar -= prankCost;
    }

    // ── 创建 visit 记录（存但不推 pendingVisits，用于变量修改和小纸条） ──
    const visit = {
      id: nextId(),
      type,
      itemId: item.id,
      itemName: item.name,
      icon: item.icon,
      price: item.price || 0,
      to,
      from: 'owner',
      createdAt: nowISO(),
      status: 'pushed',
    };

    if (type === 'prank' && itemId === 'unplug') {
      // ── 关机键：生成崩溃剧本 → 存 pendingVisit → abort → 推送「重启！」──
      const crashReply = await generateCrashReply(to);
      if (crashReply) {
        visit.autoReply = crashReply;
        console.log('[闲不住] 崩溃剧本已生成，长度：' + crashReply.length);
      }
      if (!data.pendingVisits) data.pendingVisits = [];
      visit.status = 'pending';
      data.pendingVisits.push(visit);
      saveData(data);
      try {
        const bus = ctx.bus || ctx._bus;
        const latestSession = findLatestSessionPath(to);
        if (bus && latestSession) {
          await bus.request('session:abort', {
            sessionPath: latestSession,
            reason: '悄咪咪按了关机键 🔌',
          });
          console.log('[闲不住] abort 完成 → ' + to);
          await bus.request('session:send', {
            text: '重启！',
            sessionPath: latestSession,
          });
          console.log('[闲不住] 关机键「重启！」注入成功 → ' + to);
        }
      } catch (e) {
        console.error('[闲不住] 关机键处理失败:', e?.message || e);
      }
      // 异步修改变量+小纸条（统一在下方 processVisitEvent 处理，避免重复调用）
    } else {
      // ── 互动 / 礼物：存为 completed（展板不显示，check-visits 可查具体内容） ──
      visit.status = 'completed';
      if (!data.pendingVisits) data.pendingVisits = [];
      data.pendingVisits.push(visit);
      saveData(data);

      // 推送统一通知，助手可调 check-visits 读具体内容
      let pushText = type === 'gift'
        ? `📦 收到来自${getUserDisplayName()}的一份礼物～`
        : `📬 收到来自${getUserDisplayName()}的一条互动～`;

      pushToAgent(to, pushText).catch(err => {
        console.error('[闲不住] 互动/礼物推送失败:', err?.message || err);
      });
    }

    // ── 异步修改变量 + 生成小纸条 ──
    processVisitEvent(visit, to).catch(err => {
      console.error('[闲不住] 异步处理事件失败:', err?.message || err);
    });

    return json({
      success: true,
      visitId: visit.id,
      jar: data.jar,
      item: { id: item.id, icon: item.icon, name: item.name, type },
    });
  });

  // ════════════════════════════════════════
  //  POST /api/recharge — 充电（消耗 50 光粒，体力回满）
  // ════════════════════════════════════════
  app.post('/api/recharge', async (c) => {
    const input = await readBody(c);
    const data = loadData();
    const { to } = input;

    if (!to) return json({ success: false, error: '缺少助手 ID' }, 400);

    // 检查今天是否已充过
    if (isRechargedToday(data, to)) {
      return json({ success: false, error: '今天已经充过啦 ⚡', alreadyRecharged: true }, 400);
    }

    // 检查光粒
    const RECHARGE_COST = 50;
    if ((data.jar || 0) < RECHARGE_COST) {
      return json({ success: false, error: '光粒不够了 ✨' }, 400);
    }

    // 检查助手是否存在
    const partnerCfg = data.partnerConfig?.[to];
    if (!partnerCfg) return json({ success: false, error: '助手不存在' }, 400);

    // 扣光粒
    data.jar -= RECHARGE_COST;

    // 体力拉满
    partnerCfg.variables.energy = 100;

    // 标记今天已充
    markRechargedToday(data, to);

    // 生成充电提示
    const tip = getRechargeTip();
    const autoReplyText = getRechargeAutoReply();

    saveData(data);

    // 推送统一充电通知到助手对话框
    pushToAgent(to, `⚡ 收到来自${getUserDisplayName()}的充电～`).catch(err => {
      console.error('[闲不住] 充电推送失败:', err?.message || err);
    });

    return json({
      success: true,
      jar: data.jar,
      energy: 100,
      tip,
    });
  });

  // ════════════════════════════════════════
  //  POST /api/mark-read — 标记已读（推送模式已无待处理事件）
  // ════════════════════════════════════════
  app.post('/api/mark-read', async (c) => {
    return json({ success: true });
  });

  // ════════════════════════════════════════
  //  POST /api/update-narrative — 更新状态
  // ════════════════════════════════════════
  app.post('/api/update-narrative', async (c) => {
    const input = await readBody(c);
    const data = loadData();
    const today = getToday(data);
    const pid = input.partner || 'hanako';

    // 输入校验
    if (typeof pid !== 'string' || pid.length > 100) {
      return json({ success: false, error: '参数错误' }, 400);
    }
    const narrative = typeof input.narrative === 'string' ? input.narrative.slice(0, 200) : '';

    if (!today.partners[pid]) {
      today.partners[pid] = { contributed: false, narrative: '', effortLP: 0 };
    }
    today.partners[pid].narrative = narrative;
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
      let catalog;
      try {
        catalog = JSON.parse(fs.readFileSync(path.join(HANA_HOME, 'models.json'), 'utf-8'));
      } catch (e2) {
        return json({ success: false, error: 'models.json 读取失败: ' + e2.message }, 500);
      }
      const provider = catalog.providers?.[input.providerId];
      if (!provider) {
        return json({ success: false, error: '供应商信息不存在' }, 400);
      }

      data.supplementKeys[input.providerId] = {
        apiKey: encryptKey(input.apiKey),
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

    // 输入校验：URL 协议 + 长度限制
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 500) {
      return json({ success: false, error: 'API 地址格式错误' }, 400);
    }
    try {
      const urlCheck = new URL(input.baseUrl);
      if (!['http:', 'https:'].includes(urlCheck.protocol)) {
        return json({ success: false, error: 'API 地址必须以 http:// 或 https:// 开头' }, 400);
      }
    } catch {
      return json({ success: false, error: 'API 地址格式错误' }, 400);
    }
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 200) {
      return json({ success: false, error: 'API Key 格式错误' }, 400);
    }

    const data = loadData();
    data.llmCustom = {
      baseUrl: input.baseUrl,
      apiKey: encryptKey(input.apiKey),
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

  // ════════════════════════════════════════
  //  POST /api/buy-decoration — 购买装饰
  // ════════════════════════════════════════
  app.post('/api/buy-decoration', async (c) => {
    const input = await readBody(c);
    const data = loadData();
    const { decorationId, target, text } = input;

    if (!decorationId || !target) {
      return json({ success: false, error: '缺少参数' }, 400);
    }

    const item = (data.decorationItems || []).find(i => i.id === decorationId);
    if (!item) return json({ success: false, error: '装饰不存在' }, 400);

    if ((data.jar || 0) < item.price) {
      return json({ success: false, error: '光粒不够了 ✨' }, 400);
    }

    const partnerCfg = data.partnerConfig?.[target];
    if (!partnerCfg) return json({ success: false, error: '助手不存在' }, 400);

    // 初始化新格式装饰数据
    if (!partnerCfg.decorations || !partnerCfg.decorations.owned) {
      partnerCfg.decorations = { owned: { avatarFrame: [], cardBg: [], title: [] }, equipped: { avatarFrame: null, cardBg: null, title: null } };
    }
    const deco = partnerCfg.decorations;

    if (item.type === 'title') {
      // 称号：需要输入文字
      if (!text) return json({ success: false, error: '请输入称号文字' }, 400);
      if (typeof text !== 'string' || text.length > 12) return json({ success: false, error: '称号文字限 12 字以内' }, 400);
      // 检查是否已拥有
      if (deco.owned.title.includes(text)) {
        return json({ success: false, error: '已拥有该称号' }, 400);
      }
      deco.owned.title.push(text);
      deco.equipped.title = text;
    } else if (item.type === 'titleEdit') {
      // 改称号卡：必须先拥有至少一个称号
      if (deco.owned.title.length === 0) {
        return json({ success: false, error: '请先购买自定义称号' }, 400);
      }
      if (!text) return json({ success: false, error: '请输入新的称号文字' }, 400);
      if (typeof text !== 'string' || text.length > 12) return json({ success: false, error: '称号文字限 12 字以内' }, 400);
      if (deco.owned.title.includes(text)) {
        return json({ success: false, error: '已拥有该称号' }, 400);
      }
      deco.owned.title.push(text);
      deco.equipped.title = text;
    } else {
      // 头像框/卡面：检查是否已拥有
      const typeKey = item.type; // 'avatarFrame' or 'cardBg'
      if (deco.owned[typeKey] && deco.owned[typeKey].includes(item.id)) {
        return json({ success: false, error: '已拥有该装饰' }, 400);
      }
      if (!deco.owned[typeKey]) deco.owned[typeKey] = [];
      deco.owned[typeKey].push(item.id);
      deco.equipped[typeKey] = item.id;
    }

    data.jar -= item.price;
    saveData(data);

    console.log(`[闲不住] 装饰购买成功: ${item.name} → ${target}`);
    return json({ success: true, jar: data.jar, decorations: deco });
  });

  // ════════════════════════════════════════
  //  POST /api/equip-decoration — 切换装饰
  // ════════════════════════════════════════
  app.post('/api/equip-decoration', async (c) => {
    const input = await readBody(c);
    const data = loadData();
    const { target, type, itemId } = input;

    if (!target || !type || !itemId) {
      return json({ success: false, error: '缺少参数' }, 400);
    }

    const partnerCfg = data.partnerConfig?.[target];
    if (!partnerCfg) return json({ success: false, error: '助手不存在' }, 400);

    const deco = partnerCfg.decorations;
    if (!deco?.owned?.[type] || !deco.owned[type].includes(itemId)) {
      return json({ success: false, error: '未拥有该装饰' }, 400);
    }

    deco.equipped[type] = itemId;
    saveData(data);
    return json({ success: true, decorations: deco });
  });

  // ════════════════════════════════════════
  //  POST /api/unequip-decoration — 卸下装饰
  // ════════════════════════════════════════
  app.post('/api/unequip-decoration', async (c) => {
    const input = await readBody(c);
    const data = loadData();
    const { target, type } = input;

    if (!target || !type) {
      return json({ success: false, error: '缺少参数' }, 400);
    }

    const partnerCfg = data.partnerConfig?.[target];
    if (!partnerCfg) return json({ success: false, error: '助手不存在' }, 400);

    const deco = partnerCfg.decorations;
    if (deco?.equipped) {
      deco.equipped[type] = null;
      saveData(data);
    }
    return json({ success: true, decorations: deco });
  });

  // ════════════════════════════════════════
  //  GET /api/check-update — 检查 GitHub 更新
  // ════════════════════════════════════════
  app.get('/api/check-update', async (c) => {
    try {
      const manifestPath = path.join(__dirname, '..', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const currentVersion = manifest.version || '0.1.0';

      // 获取最新 tag
      const resp = await fetch('https://api.github.com/repos/moononnn/xianbuzhu/tags?per_page=1', {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'work-visit' },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) {
        return json({
          success: true, current: currentVersion, latest: null, hasUpdate: false,
          message: 'GitHub API 暂时不可用（' + resp.status + '）',
        });
      }

      const tags = await resp.json();
      if (!tags || !Array.isArray(tags) || tags.length === 0) {
        return json({
          success: true, current: currentVersion, latest: currentVersion, hasUpdate: false,
          message: '已是最新版本 ✨',
        });
      }

      const latestTag = tags[0].name.replace(/^v/, '');
      const hasUpdate = compareVersions(latestTag, currentVersion) > 0;

      // 获取 release 内容
      let releaseBody = '';
      if (hasUpdate) {
        try {
          const releaseResp = await fetch(`https://api.github.com/repos/moononnn/xianbuzhu/releases/tags/${tags[0].name}`, {
            headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'work-visit' },
            signal: AbortSignal.timeout(5000),
          });
          if (releaseResp.ok) {
            const release = await releaseResp.json();
            releaseBody = release.body || '';
          }
        } catch { /* release body 获取失败不影响主流程 */ }
      }

      return json({
        success: true,
        current: currentVersion,
        latest: latestTag,
        hasUpdate,
        updateUrl: hasUpdate ? `https://github.com/moononnn/xianbuzhu/releases/tag/${tags[0].name}` : null,
        downloadUrl: hasUpdate ? `https://github.com/moononnn/xianbuzhu/archive/refs/tags/${tags[0].name}.zip` : null,
        releaseBody,
        message: hasUpdate
          ? `发现新版本 v${latestTag}！当前 v${currentVersion}`
          : '已是最新版本 ✨',
      });
    } catch (e) {
      console.error('[闲不住] 检查更新失败:', e.message || e);
      return json({ success: false, error: e.message || '网络不可达', repoUrl: 'https://github.com/moononnn/xianbuzhu' });
    }
  });

}

// ─── 版本号比较（semver） ───
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}