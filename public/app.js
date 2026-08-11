// 闲不住 — 前端（同页档案：左侧助手索引 + 右侧当前档案）
// 关系驱动型交互：先选助手 → 再点功能，0 二次选择
(function() {
  'use strict';

  // ─── HTML 转义（防 XSS） ───
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── 头像框样式类映射（装饰 ID → CSS 类） ───
  function frameClassFor(equipped) {
    var map = {
      avatar_flower: ' frame-flower',
      avatar_star: ' frame-star',
      avatar_moon: ' frame-moon',
      avatar_heart: ' frame-heart',
      avatar_cloud: ' frame-cloud',
      avatar_note: ' frame-note',
      avatar_bow: ' frame-bow',
      avatar_pinwheel: ' frame-pinwheel',
    };
    return map[(equipped || {}).avatarFrame] || '';
  }

  // ─── 独立动态贴纸层：四角自转贴纸 + 呼吸光晕 ───
  function frameArtHtml(frameClass) {
    return frameClass ? '<span class="avatar-frame-art" aria-hidden="true"><i class="af af-1"></i><i class="af af-2"></i><i class="af af-3"></i><i class="af af-4"></i><i class="af af-glow"></i></span>' : '';
  }

  // ─── 工具 ───
  var $ = function(sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function(sel, ctx) { return [].slice.call((ctx || document).querySelectorAll(sel)); };

  function getBaseUrl() {
    var p = window.location.pathname;
    return p.replace(/\/page\/?$/, '').replace(/\/+$/, '') || '';
  }
  var BASE = getBaseUrl();

  function authQuery() {
    var token = (typeof window.__TOKEN !== 'undefined') ? window.__TOKEN : '';
    return token ? '?token=' + encodeURIComponent(token) : '';
  }
  var AUTH = authQuery();

  async function api(path, opts) {
    opts = opts || {};
    var url = BASE + path + AUTH;
    var resp = await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    }));
    return resp.json();
  }

  // ─── 状态 ───
  var state = {
    jar: 0, newAvailable: 0, sectionTitle: '',
    partners: [], shopItems: [], interactItems: [], prankItems: [],
    currentTab: 'interact',
    // v0.4 新增
    selectedPartnerId: null,    // 当前选中的伙伴
    partnerOrder: [],           // 用户拖动排序后的顺序
    currentAgentId: null,       // Hana 主对话正在聊的 agent（自动同步）
    expandedPanel: null,        // 'interact' / 'gift' / null
    _initializedOnce: false,    // 首次加载默认展开互动的标志
    fenglingRunning: false,     // 风铃悬浮球是否在跑
  };
  var currentAction = null;

  // ─── Toast ───
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 2500);
  }

  // ─── 持久 Toast（手动控制显隐和内容）───
  var _persistentToast = null;
  function showPersistentToast(msg, type) {
    clearPersistentToast();
    var el = document.createElement('div');
    el.className = 'toast toast-persist' + (type ? ' ' + type : '');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = msg;
    document.body.appendChild(el);
    _persistentToast = el;
    return el;
  }
  function updatePersistentToast(msg, type) {
    if (_persistentToast) {
      _persistentToast.textContent = msg;
      _persistentToast.className = 'toast toast-persist' + (type ? ' ' + type : '');
    }
  }
  function clearPersistentToast() {
    if (_persistentToast) {
      _persistentToast.remove();
      _persistentToast = null;
    }
  }

  // ─── 渲染 ───
  function render() {
    var app = $('#app');
    if (!app) return;

    var hasNew = state.newAvailable > 0;
    var claimLabel = hasNew ? '领取 +' + state.newAvailable : '已领取';
    var claimClass = hasNew ? 'topbar-btn' : 'topbar-btn done';
    var isLLMConfigured = !!(state.llmConfig && state.llmConfig.providerId);
    var orderedPartners = orderPartners(state.partners, state.partnerOrder);
    var canSortPartners = orderedPartners.length > 1;

    var html = '';

    // ============ 同页档案：顶栏 + 助手索引 + 当前档案 ============
    html += '<div class="layout-v2">';

    // ── 顶栏（横跨整张纸页）──
    html += '<div class="topbar">';
    html += '<div class="topbar-left"><span class="topbar-num">' + state.jar + '</span><span class="topbar-unit">光粒</span></div>';
    html += '<div class="topbar-right">';
    if (state.hasNotes) {
      html += '<button class="topbar-note-btn' + (state.hasNewNotes ? ' pulse' : '') + '" onclick="window._tbShowNotes()" title="小纸条" aria-label="打开小纸条">小纸条</button>';
    }
    html += '<button class="topbar-note-btn" onclick="window._tbOpenEditPartners()" title="编辑伙伴列表" aria-label="编辑伙伴列表">编辑</button>';
    html += '<button class="topbar-note-btn ' + (isLLMConfigured ? '' : 'topbar-warn') + '" onclick="window._tbToggleLLM()" title="模型设置" aria-label="打开模型设置">设置</button>';
    html += '<button class="fengling-toggle-wrap' + (state.fenglingRunning ? ' on' : '') + '" id="fengling-toggle" onclick="window._tbToggleFengling()" title="风铃悬浮球：桌面小风铃，送礼/互动/恶作剧不用开页面" aria-label="风铃悬浮球开关" aria-pressed="' + (state.fenglingRunning ? 'true' : 'false') + '">';
    html += '<span class="fengling-toggle-label">风铃（悬浮球）</span>';
    html += '<span class="fengling-toggle-switch' + (state.fenglingRunning ? ' on' : '') + '"><span class="fengling-toggle-thumb"></span></span>';
    html += '</button>';
    html += '<button class="' + claimClass + '" ' + (!hasNew ? 'disabled' : '') + ' onclick="window._tbClaim()">' + claimLabel + '</button>';
    html += '</div></div>';

    // ── 新纸条只做一行通知，不再切出一张大卡 ──
    if (state.showNoteGuide) {
      html += '<div class="note-guide" id="note-guide" role="status">';
      html += '<div class="note-guide-body">';
      html += '<span class="note-guide-title">收到新的小纸条</span>';
      html += '<span class="note-guide-desc">助手悄悄给你留了话。</span>';
      html += '</div>';
      html += '<div class="note-guide-actions">';
      html += '<button class="note-guide-btn" onclick="window._tbShowNotes();window._tbDismissNoteGuide()">查看</button>';
      html += '<button class="note-guide-dismiss" onclick="window._tbDismissNoteGuide()">稍后</button>';
      html += '</div></div>';
    }

    // ── 左侧助手索引（多于一个助手时可拖动排序）──
    html += '<div class="partner-wall">';
    html += '<div class="partner-wall-title">';
    html += '<div class="partner-title-row"><span>助手</span>' + (canSortPartners ? '<span class="partner-sort-note">拖动排序</span>' : '') + '</div>';
    html += '<span class="partner-wall-hint">' + (state.tip || state.sectionTitle || '每天来看看，说不定会有新的发现') + '</span>';
    html += '</div>';
    html += '<div class="partner-list" id="partner-list" role="listbox" aria-label="助手列表">';
    if (orderedPartners.length === 0) {
      html += '<div class="partner-list-empty">还没有可用助手<br><span>配置助手后会显示在这里</span></div>';
    }

    for (var i = 0; i < orderedPartners.length; i++) {
      var p = orderedPartners[i];
      var initial = p.name.charAt(0);
      var deco = p.decorations || {};
      var equipped = deco.equipped || {};
      var frameClass = frameClassFor(equipped);
      var isSelected = state.selectedPartnerId === p.id;
      var selectedClass = isSelected ? ' selected' : '';
      var pidSafe = (p.id || '').replace(/'/g, "\\'");

      var dragAttrs = canSortPartners
        ? ' draggable="true" ondragstart="window._tbDragStart(event)" ondragover="window._tbDragOver(event)" ondragenter="window._tbDragEnter(event)" ondragleave="window._tbDragLeave(event)" ondrop="window._tbDrop(event)" ondragend="window._tbDragEnd(event)"'
        : ' draggable="false"';
      html += '<div class="partner-card' + selectedClass + '" role="option" tabindex="0" aria-selected="' + (isSelected ? 'true' : 'false') + '" aria-label="' + escapeHtml(p.name) + '，' + (p.active ? '在线' : '摸鱼') + '" data-partner-id="' + escapeHtml(p.id) + '" onclick="window._tbSelectPartner(\'' + pidSafe + '\')" onkeydown="window._tbPartnerKey(event,\'' + pidSafe + '\')"' + dragAttrs + '>';
      if (p.avatarUrl) {
        html += '<div class="pc-avatar' + frameClass + '" data-initial="' + escapeHtml(initial) + '"><img src="' + BASE + p.avatarUrl + AUTH + '" alt="" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'avatar-missing\');this.parentElement.insertBefore(document.createTextNode(this.parentElement.dataset.initial),this.parentElement.firstChild)">' + frameArtHtml(frameClass) + '</div>';
      } else {
        html += '<div class="pc-avatar' + frameClass + '" style="background:' + p.color + '">' + initial + frameArtHtml(frameClass) + '</div>';
      }
      html += '<div class="pc-info">';
      html += '<div class="pc-name">';
      html += escapeHtml(p.name);
      if (equipped.title) {
        html += '<span class="title-badge">' + escapeHtml(equipped.title) + '</span>';
      }
      html += '</div>';
      html += '<div class="pc-meta">' + escapeHtml(p.doing || '—') + '</div>';
      html += '</div>';
      html += '<span class="pc-status' + (p.active ? ' on' : '') + '" title="' + (p.active ? '在线' : '摸鱼') + '" aria-label="' + (p.active ? '在线' : '摸鱼') + '"></span>';
      html += '</div>';
    }
    html += '</div></div>';

    // ── 右侧操作面板（根据 selectedPartnerId 显示内容）──
    var selectedPartner = null;
    if (state.selectedPartnerId) {
      for (var si = 0; si < state.partners.length; si++) {
        if (state.partners[si].id === state.selectedPartnerId) { selectedPartner = state.partners[si]; break; }
      }
    }

    if (selectedPartner) {
      html += renderPartnerPanel(selectedPartner);
    } else {
      var hasPartners = state.partners.length > 0;
      html += '<div class="partner-panel-empty">';
      html += '<div>';
      html += '<div class="partner-panel-empty-icon">🍃</div>';
      html += '<div style="font-size:var(--text-sm);color:var(--color-ink);margin-bottom:var(--space-xs)">' + (hasPartners ? '选一个助手开始互动吧' : '还没有可用助手') + '</div>';
      html += '<div style="font-size:var(--text-xs);color:var(--color-muted)">' + (hasPartners ? '点左侧任意助手卡片 · 右侧会出现互动入口' : '配置助手后，再回来看看这张档案页') + '</div>';
      if (hasPartners && state.currentAgentId) {
        html += '<div style="font-size:var(--text-xs);color:var(--color-ink-2);margin-top:var(--space-sm)">检测到你正在跟 <b>' + escapeHtml(state.currentAgentId) + '</b> 说话</div>';
      }
      html += '</div></div>';
    }

    html += '</div>'; // .layout-v2 end

    // ============ 弹窗区（独立于 layout-v2） ============
    // 主弹窗（互动/送礼/恶作剧）
    html += '<div class="modal-overlay" id="modal-overlay">';
    html += '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">';
    html += '<h3 id="modal-title"></h3>';
    html += '<div class="modal-section" id="modal-target-section"><label>送给谁？</label><select class="modal-select" id="modal-target"></select></div>';
    html += '<div class="modal-section" id="modal-title-section" style="display:none"><label>称号文字</label><input class="llm-input" id="modal-title-input" placeholder="如：最佳搭档" maxlength="12"></div>';
    html += '<div class="modal-actions">';
    html += '<button class="modal-btn cancel" onclick="window._tbClose()">取消</button>';
    html += '<button class="modal-btn confirm" id="modal-confirm" onclick="window._tbConfirm()">确认</button>';
    html += '</div></div></div>';

    // 模型设置弹窗
    html += '<div class="modal-overlay" id="llm-modal">';
    html += '<div class="modal llm-modal" role="dialog" aria-modal="true" aria-labelledby="llm-modal-title">';
    html += '<h3 id="llm-modal-title">模型设置 <button class="modal-close" onclick="window._tbCloseLLM()" aria-label="关闭模型设置">×</button></h3>';
    html += '<div class="llm-loading" id="llm-loading">加载中...</div>';
    html += '<div class="llm-form" id="llm-form" style="display:none">';
    html += '<div class="llm-row"><label>供应商</label><select id="llm-provider" onchange="window._tbLLMProviderChange()"><option value="">请选择</option></select></div>';
    html += '<div class="llm-row"><label>模型</label><select id="llm-model" onchange="window._tbLLMModelChange()"><option value="">先选供应商</option></select></div>';
    html += '<div class="llm-help" id="llm-key-hint" style="display:none">⚠️ 这个模型在 Hana 里没配 API Key，去 Hana 的模型设置里补上，或者选「自定义 API」自己填。</div>';
    html += '<div class="llm-custom" id="llm-custom" style="display:none">';
    html += '<div class="llm-row"><label>API 地址</label><input id="llm-custom-url" class="llm-input" placeholder="https://api.example.com/v1"></div>';
    html += '<div class="llm-row"><label>API Key</label><input id="llm-custom-key" class="llm-input" type="password" placeholder="sk-..."></div>';
    html += '<div class="llm-row"><label>协议</label><select id="llm-custom-api" class="llm-select"><option value="openai-completions">OpenAI 兼容</option><option value="anthropic-messages">Anthropic</option></select></div>';
    html += '<div class="llm-action-row"><button class="llm-test-btn" onclick="window._tbCustomFetch()">获取模型列表</button></div>';
    html += '<div class="llm-row"><label>模型</label><select id="llm-custom-model"><option value="">先获取模型列表</option></select></div>';
    html += '<div class="llm-action-row"><button class="llm-save" onclick="window._tbCustomSave()">保存自定义</button>';
    html += '<span class="llm-status" id="llm-custom-status"></span></div>';
    html += '<div class="llm-test-result" id="llm-custom-result"></div></div>';
    html += '<div class="llm-help">API Key 仅保存在本地并做混淆处理，请勿上传数据文件。</div>';
    html += '<div class="llm-action-row"><button class="llm-save" onclick="window._tbLLMSave()">保存设置</button>';
    html += '<span class="llm-status" id="llm-status"></span></div>';
    html += '<div class="llm-test-result" id="llm-test-result"></div>';
    html += '<div class="llm-action-row">';
    html += '<span class="llm-version">当前版本 v' + (state.version || '0.1.0') + '</span>';
    html += '<button class="llm-test-btn" onclick="window._tbLLMTest()">测试连接</button>';
    html += '<button class="llm-test-btn" onclick="window._tbCheckUpdate()">检查更新</button>';
    html += '<a class="llm-test-btn" href="https://github.com/moononnn/xianbuzhu/issues" target="_blank" style="display:inline-flex;align-items:center;text-decoration:none;justify-content:center">反馈</a>';
    html += '</div>';
    html += '<div class="update-result" id="update-result"></div>';
    html += '<div class="uninstall-section"><details>';
    html += '<summary>彻底卸载闲不住</summary>';
    html += '<p>点击后会清理助手协议残留、数据文件和 skill 配置。</p>';
    html += '<p>清理完成后，请关闭 Hana 并手动删除插件目录。</p>';
    html += '<button class="llm-save" onclick="window._tbUninstall()">清理残留数据</button>';
    html += '</details></div>';
    html += '</div></div></div>';

    app.innerHTML = html;

    // 渲染后检查 selectedPartner 是否还存在
    if (state.selectedPartnerId) {
      var stillExists = false;
      for (var ci = 0; ci < state.partners.length; ci++) {
        if (state.partners[ci].id === state.selectedPartnerId) { stillExists = true; break; }
      }
      if (!stillExists) state.selectedPartnerId = null;
    }
  }

  // ─── 按自定义排序返回伙伴列表 ───
  function orderPartners(list, order) {
    if (!Array.isArray(order) || order.length === 0) return list;
    var byId = {};
    for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    var ordered = [];
    for (var j = 0; j < order.length; j++) {
      if (byId[order[j]]) {
        ordered.push(byId[order[j]]);
        delete byId[order[j]];
      }
    }
    for (var k = 0; k < list.length; k++) {
      if (byId[list[k].id]) ordered.push(list[k]);
    }
    return ordered;
  }

  // ─── 渲染右栏操作面板 ───
  function renderPartnerPanel(p) {
    var html = '';
    html += '<div class="partner-panel">';

    // 头部
    var initial = p.name.charAt(0);
    var pidSafe = (p.id || '').replace(/'/g, "\\'");
    var pDeco = p.decorations || {};
    var pEquipped = pDeco.equipped || {};
    var pFrameClass = frameClassFor(pEquipped);
    html += '<div class="pp-header">';
    html += '<div class="pp-header-left">';
    if (p.avatarUrl) {
      html += '<div class="pp-header-avatar' + pFrameClass + '" data-initial="' + escapeHtml(initial) + '"><img src="' + BASE + p.avatarUrl + AUTH + '" alt="" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'avatar-missing\');this.parentElement.insertBefore(document.createTextNode(this.parentElement.dataset.initial),this.parentElement.firstChild)">' + frameArtHtml(pFrameClass) + '</div>';
    } else {
      html += '<div class="pp-header-avatar' + pFrameClass + '" style="background:' + p.color + '">' + initial + frameArtHtml(pFrameClass) + '</div>';
    }
    html += '<div class="pp-header-info">';
    html += '<div class="pp-header-name">' + escapeHtml(p.name);
    if (p.active) html += '<span class="pc-status on" style="margin-left:4px" aria-label="在线"></span>';
    html += '</div>';
    html += '<div class="pp-header-status">' + escapeHtml(p.doing || '—') + '</div>';
    html += '</div></div>';

    // 头部右侧低频操作：文字化并降低视觉权重
    html += '<div class="pp-header-actions">';
    if (p.recharged) {
      html += '<span class="pp-header-btn disabled" title="今天已充满">已充电</span>';
    } else if (state.jar < 50) {
      html += '<span class="pp-header-btn disabled" title="光粒不足">充电</span>';
    } else {
      html += '<button class="pp-header-btn" title="消耗 50 光粒充电" onclick="window._tbRecharge(\'' + pidSafe + '\')">充电</button>';
    }
    html += '<button class="pp-header-btn" title="打开装饰" onclick="window._tbOpenDeco()">装饰</button>';
    html += '</div></div>';

    // 数值：好感度 + 能量 + 心情
    if (p.variables) {
      var v = p.variables;
      var aff = v.affection != null ? v.affection : 0;
      var heart = aff >= 81 ? '💗💗💗💗💗' : aff >= 51 ? '💗💗💗💗' : aff >= 21 ? '💗💗💗' : aff >= 0 ? '💗💗' : '💔';
      var affLabel = aff >= 81 ? '亲密无间' : aff >= 51 ? '关系亲近' : aff >= 21 ? '逐渐熟悉' : aff >= 0 ? '初识阶段' : '有点疏远';
      var energy = v.energy != null ? v.energy : 0;
      var moodEmoji = v.mood >= 80 ? '🌿' : v.mood >= 65 ? '🍃' : v.mood >= 40 ? '☁️' : v.mood >= 25 ? '🌧' : '⛈';
      var moodLabel = v.mood >= 80 ? '很好' : v.mood >= 65 ? '不错' : v.mood >= 40 ? '平稳' : v.mood >= 25 ? '不太好' : '很差';

      html += '<div class="pp-stats">';
      html += '<div class="pp-stat" title="' + affLabel + '"><div class="pp-stat-label">好感度</div><div class="pp-stat-value"><span class="heart">' + heart + '</span></div></div>';
      html += '<div class="pp-stat"><div class="pp-stat-label">能量</div><div class="pp-stat-value">' + energy + '</div></div>';
      html += '<div class="pp-stat" title="' + moodLabel + '"><div class="pp-stat-label">心情</div><div class="pp-stat-value">' + moodEmoji + '</div></div>';
      html += '</div>';
    }

    // 主操作：互动 / 送礼双入口，共用同一个展开区
    var interactExpanded = state.expandedPanel === 'interact';
    var giftExpanded = state.expandedPanel === 'gift';
    html += '<div class="pp-actions">';
    html += '<button class="pp-action primary' + (interactExpanded ? ' expanded' : '') + '" aria-label="互动" onclick="window._tbTogglePanel(\'interact\')">';
    html += '<span>互动</span><span class="pp-action-sub">' + (interactExpanded ? '当前' : '日常与恶作剧') + '</span>';
    html += '</button>';
    html += '<button class="pp-action secondary' + (giftExpanded ? ' expanded' : '') + '" aria-label="送礼" onclick="window._tbTogglePanel(\'gift\')">';
    html += '<span>送礼</span><span class="pp-action-sub">' + (giftExpanded ? '当前' : '使用光粒兑换') + '</span>';
    html += '</button>';
    html += '</div>';

    // v0.4.1 展开区（内联，不弹窗）
    if (interactExpanded) {
      html += renderInlineInteractList();
    } else if (giftExpanded) {
      html += renderInlineGiftList();
    }

    // 最近动态
    if (state.pendingDetails && state.pendingDetails.length > 0) {
      var pdHtml = '';
      for (var pi = 0; pi < state.pendingDetails.length && pi < 4; pi++) {
        var pd = state.pendingDetails[pi];
        pdHtml += '<div class="pp-recent-item"><span class="pp-recent-time">' + escapeHtml(timeAgo(pd.ts || pd.createdAt)) + '</span><span class="pp-recent-text">' + escapeHtml(pd.text || pd.content || '') + '</span></div>';
      }
      if (pdHtml) {
        html += '<div class="pp-recent">';
        html += '<div class="pp-recent-title">最近动态</div>';
        html += pdHtml;
        html += '</div>';
      }
    }

    html += '</div>';
    return html;
  }

  // ─── 内联展开：互动项列表（点即发）──
  function renderInlineInteractList() {
    var html = '<div class="pp-inline-panel">';
    html += '<div class="pp-inline-title">选一个互动 · 送给 ' + escapeHtml((findPartner(state.selectedPartnerId) || {}).name || '助手') + '</div>';
    html += '<div class="pp-inline-grid">';
    for (var i = 0; i < state.interactItems.length; i++) {
      var it = state.interactItems[i];
      html += '<button class="pp-inline-item" onclick="window._tbInlineAction(\'interact\',\'' + escapeHtml(it.id) + '\',\'' + escapeHtml(it.name).replace(/'/g, "\\'") + '\',\'' + escapeHtml(it.icon) + '\')">' + it.icon + ' ' + escapeHtml(it.name) + '</button>';
    }
    html += '</div>';
    if (state.prankItems && state.prankItems.length > 0) {
      html += '<div class="pp-inline-subtitle">恶作剧</div>';
      html += '<div class="pp-inline-grid">';
      for (var k = 0; k < state.prankItems.length; k++) {
        var pk = state.prankItems[k];
        html += '<button class="pp-inline-item prank" onclick="window._tbInlineAction(\'prank\',\'' + escapeHtml(pk.id) + '\',\'' + escapeHtml(pk.name).replace(/'/g, "\\'") + '\',\'' + escapeHtml(pk.icon) + '\')">' + pk.icon + ' ' + escapeHtml(pk.name) + '</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── 内联展开：礼物列表（点即送）──
  function renderInlineGiftList() {
    var html = '<div class="pp-inline-panel">';
    html += '<div class="pp-inline-title">选一份礼物 · 送给 ' + escapeHtml((findPartner(state.selectedPartnerId) || {}).name || '助手') + '</div>';
    html += '<div class="pp-inline-gifts">';
    for (var i = 0; i < state.shopItems.length; i++) {
      var si = state.shopItems[i];
      var canBuy = state.jar >= si.price;
      html += '<div class="pp-inline-gift' + (canBuy ? '' : ' locked') + '" ' + (canBuy ? 'onclick="window._tbInlineAction(\'gift\',\'' + escapeHtml(si.id) + '\',\'' + escapeHtml(si.name).replace(/'/g, "\\'") + '\',\'' + escapeHtml(si.icon) + '\')"' : '') + '>';
      html += '<div class="pp-gift-icon">' + si.icon + '</div>';
      html += '<div class="pp-gift-name">' + escapeHtml(si.name) + '</div>';
      html += '<div class="pp-gift-price">✨ ' + si.price + '</div>';
      html += '</div>';
    }
    html += '</div>';
    if (state.jar <= 0) {
      html += '<div class="pp-inline-empty">光粒不足，先领一下 ✨</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── 切换展开区（互斥模式：点送礼自动收起互动，反之亦然）──
  window._tbTogglePanel = function(type) {
    // 互斥：总是设为这个 type（不会收起）
    state.expandedPanel = type;
    render();
  };

  // ─── 内联点击：发出去（保持展开区，方便连续送礼/互动）───
  window._tbInlineAction = async function(type, itemId, itemName, icon) {
    await window._tbQuickAction(type, itemId, itemName, icon);
  };

  // ─── 工具：按 ID 找伙伴 ───
  function findPartner(id) {
    for (var i = 0; i < state.partners.length; i++) {
      if (state.partners[i].id === id) return state.partners[i];
    }
    return null;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var diff = now - d;
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '刚刚';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + '分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + '小时前';
    var days = Math.floor(hours / 24);
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return days + '天前';
    var pad = function(n) { return String(n).padStart(2, '0'); };
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate());
  }

  // ─── 选中伙伴（点击左伙伴墙的卡片）──
  window._tbUserSelected = false;
  window._tbSelectPartner = function(id) {
    if (!id) return;
    state.selectedPartnerId = id;
    window._tbUserSelected = true;
    render();
  };

  window._tbPartnerKey = function(event, id) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    window._tbSelectPartner(id);
  };

  // ════════════════════════════════════════════════════════════════
  //  v0.4 新交互函数：选中伙伴 + 拖动排序 + 免二次选择的互动/送礼
  // ════════════════════════════════════════════════════════════════

  // ─── 内联入口：互动项目列表 ───
  window._tbOpenInteractList = function() {
    if (!state.selectedPartnerId) { toast('先选一个助手吧', 'error'); return; }
    if (!state.interactItems || state.interactItems.length === 0) { toast('暂无可用互动', 'error'); return; }
    window._tbTogglePanel('interact');
  };

  // ─── 内联入口：礼物列表 ───
  window._tbOpenGiftList = function() {
    if (!state.selectedPartnerId) { toast('先选一个助手吧', 'error'); return; }
    if (!state.shopItems || state.shopItems.length === 0) { toast('小铺暂无礼物', 'error'); return; }
    if (state.jar <= 0) { toast('光粒不足，去领一下', 'error'); return; }
    window._tbTogglePanel('gift');
  };

  // ─── 统一跳转：跳过"送给谁"选助手，直接调 /api/visit ───
  window._tbQuickAction = async function(type, itemId, itemName, icon) {
    if (!state.selectedPartnerId) { toast('先选一个助手吧', 'error'); return; }

    currentAction = { type: type, itemId: itemId, itemName: itemName, icon: icon, target: state.selectedPartnerId };

    try {
      if (type === 'prank' && itemId === 'unplug') {
        showPersistentToast('⏳ 正在关机...');
      } else if (type === 'prank' && itemId === 'brainrot') {
        showPersistentToast('⏳ 正在想说什么怪话...');
      }
      var data = await api('/api/visit', {
        method: 'POST',
        body: JSON.stringify({ type: type, itemId: itemId, to: state.selectedPartnerId }),
      });

      if (data.success) {
        state.jar = data.jar != null ? data.jar : state.jar;
        if (type === 'prank') {
          if (itemId === 'unplug') {
            updatePersistentToast('🔌 已经关机啦！');
            setTimeout(clearPersistentToast, 3000);
          } else if (itemId === 'brainrot') {
            if (data.injected) {
              clearPersistentToast();
              toast('🧠 怪话已送达！');
              try {
                if (window.parent && window.parent !== window) {
                  window.parent.postMessage({ type: 'interject', text: '' }, '*');
                  window.parent.postMessage({ protocol: 'hana.plugin.ui', version: 1, kind: 'request', type: 'session.refresh' }, '*');
                }
              } catch {}
              setTimeout(clearPersistentToast, 2000);
            } else if (data.brainrot) {
              clearPersistentToast();
              toast('🧠 ' + data.brainrot);
            } else {
              clearPersistentToast();
            }
          } else {
            clearPersistentToast();
          }
        } else if (type === 'gift') {
          clearPersistentToast();
          toast(icon + ' 已送给 ' + (findPartner(state.selectedPartnerId) || {}).name);
        } else {
          clearPersistentToast();
          toast(icon + ' 已发送');
        }
        // 关闭弹窗、刷新状态、保留选中
        window._tbClose();
        // 轻量更新（不重置 selectedPartnerId）
        try {
          var fresh = await api('/api/data');
          state.jar = fresh.jar || 0;
          state.newAvailable = fresh.newAvailable || 0;
          state.partners = fresh.partners || state.partners;
          state.pendingDetails = fresh.pendingDetails || state.pendingDetails;
          render();
        } catch (e) {
          render();
        }
      } else {
        clearPersistentToast();
        toast(data.error || '操作失败', 'error');
      }
    } catch (e) {
      clearPersistentToast();
      toast('网络错误', 'error');
    }
  };

  // ─── 编辑伙伴列表：隐藏/显示 + 刷新找回 ───
  window._tbOpenEditPartners = function() {
    if (!state.partners || state.partners.length === 0) { toast('还没有可用助手', 'error'); return; }

    var overlay = document.getElementById('edit-partners-overlay');
    if (!overlay) {
      var div = document.createElement('div');
      div.className = 'modal-overlay';
      div.id = 'edit-partners-overlay';
      div.innerHTML = '<div class="modal edit-partners-modal" role="dialog" aria-modal="true" aria-labelledby="edit-partners-title">' +
        '<div class="notes-modal-header">' +
        '<h3 id="edit-partners-title">编辑伙伴列表</h3>' +
        '<button class="modal-close" aria-label="关闭" onclick="document.getElementById(\'edit-partners-overlay\').classList.remove(\'show\')">×</button>' +
        '</div>' +
        '<div class="edit-partners-body" id="edit-partners-body">' +
        '<div class="llm-loading">加载中...</div></div></div>';
      div.addEventListener('click', function(e) {
        if (e.target === div) div.classList.remove('show');
      });
      document.body.appendChild(div);
      overlay = div;
    }

    overlay.classList.add('show');
    window._tbRenderEditList();
  };

  window._tbRenderEditList = function() {
    var body = document.getElementById('edit-partners-body');
    if (!body) return;

    var html = '';
    html += '<div class="edit-partners-tip">点「隐藏」伙伴就从展板消失，数据还在；刷新列表可以把所有伙伴找回来。</div>';
    html += '<div class="edit-partners-list">';
    for (var i = 0; i < state.partners.length; i++) {
      var p = state.partners[i];
      var pidSafe = (p.id || '').replace(/'/g, "\\'");
      html += '<div class="edit-partner-row">';
      html += '<span class="edit-partner-dot" style="background:' + (p.color || '#999') + '"></span>';
      html += '<span class="edit-partner-name">' + escapeHtml(p.name) + '</span>';
      html += '<button class="edit-partner-hide" onclick="window._tbHidePartner(\'' + pidSafe + '\')">隐藏</button>';
      html += '</div>';
    }
    html += '</div>';
    html += '<button class="edit-partners-refresh" onclick="window._tbRefreshPartners()">🔄 刷新列表 · 找回所有伙伴</button>';
    body.innerHTML = html;
  };

  window._tbHidePartner = async function(target) {
    try {
      var data = await api('/api/partner-hidden', {
        method: 'POST',
        body: JSON.stringify({ target: target, hidden: true }),
      });
      if (data.success) {
        state.partners = state.partners.filter(function(p) { return p.id !== target; });
        if (state.selectedPartnerId === target) {
          state.selectedPartnerId = state.partners.length ? state.partners[0].id : null;
        }
        toast('已隐藏，数据已保留');
        render();
        window._tbRenderEditList();
      } else {
        toast(data.error || '操作失败', 'error');
      }
    } catch (e) { toast('网络错误', 'error'); }
  };

  window._tbRefreshPartners = async function() {
    try {
      var data = await api('/api/refresh-partners', { method: 'POST' });
      if (data.success) {
        toast('找回 ' + (data.count || '') + ' 个伙伴 ✨');
        var overlay = document.getElementById('edit-partners-overlay');
        if (overlay) overlay.classList.remove('show');
        await loadData();
      } else {
        toast(data.error || '刷新失败', 'error');
      }
    } catch (e) { toast('网络错误', 'error'); }
  };

  // ─── 装饰商店：购买 + 衣橱切换二合一 ───
  // 未拥有=✨价格购买；已拥有=点一下换上；正在用=高亮标记不可点
  window._tbOpenDeco = function() {
    if (!state.decorationItems || state.decorationItems.length === 0) { toast('暂无可用装饰', 'error'); return; }
    if (!state.selectedPartnerId) { toast('先选一个助手', 'error'); return; }

    var overlay = $('#modal-overlay');
    var title = $('#modal-title');
    var targetSection = $('#modal-target-section');
    var target = $('#modal-target');
    var confirm = $('#modal-confirm');

    title.textContent = '装饰商店 · 给谁装扮';
    if (targetSection) targetSection.style.display = '';
    if (confirm) confirm.style.display = 'none';

    if (target) {
      target.innerHTML = '';
      for (var i = 0; i < state.partners.length; i++) {
        var opt = document.createElement('option');
        opt.value = state.partners[i].id;
        opt.textContent = state.partners[i].name;
        if (state.partners[i].id === state.selectedPartnerId) opt.selected = true;
        target.appendChild(opt);
      }
      target.onchange = function() { window._tbBuildDecoList(); };
    }

    window._tbBuildDecoList();
    overlay.classList.add('show');
  };

  window._tbBuildDecoList = function() {
    var oldList = document.getElementById('modal-deco-list');
    if (oldList) oldList.remove();

    var target = $('#modal-target');
    var tid = target ? target.value : state.selectedPartnerId;
    var partner = null;
    for (var i = 0; i < state.partners.length; i++) {
      if (state.partners[i].id === tid) { partner = state.partners[i]; break; }
    }
    var pDeco = (partner && partner.decorations) || {};
    var pOwned = pDeco.owned || {};
    var pEquipped = pDeco.equipped || {};

    var list = document.createElement('div');
    list.id = 'modal-deco-list';
    list.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px';

    for (var j = 0; j < state.decorationItems.length; j++) {
      var di = state.decorationItems[j];
      var typeKey = di.type; // 'avatarFrame' / 'cardBg'
      var ownedList = pOwned[typeKey] || [];
      var isOwned = ownedList.indexOf(di.id) >= 0;
      var isEquipped = pEquipped[typeKey] === di.id;
      var canBuy = state.jar >= di.price;

      var btn = document.createElement('div');
      btn.className = 'deco-item' + (di.type === 'avatarFrame' ? ' avatar-deco' : '')
        + (isEquipped ? ' using' : (isOwned ? ' owned' : (canBuy ? '' : ' locked')));

      var preview = di.type === 'avatarFrame'
        ? '<div class="deco-avatar-preview' + frameClassFor({ avatarFrame: di.id }) + '" aria-hidden="true">' + frameArtHtml(frameClassFor({ avatarFrame: di.id })) + '</div>'
        : '<div class="deco-icon">' + di.icon + '</div>';

      var priceText = isEquipped ? '使用中' : (isOwned ? '换上' : '✨ ' + di.price);
      btn.innerHTML = preview + '<div class="deco-name">' + escapeHtml(di.name) + '</div><div class="deco-price">' + priceText + '</div>';

      if (isEquipped) {
        // 使用中：高亮标记，不可点击
      } else if (isOwned) {
        // 已拥有：点击直接切换装备，不再花钱
        btn.style.cursor = 'pointer';
        btn.onclick = (function(id, t, tk) {
          return async function() {
            try {
              var data = await api('/api/equip-decoration', {
                method: 'POST',
                body: JSON.stringify({ target: t, type: tk, itemId: id }),
              });
              if (data.success) {
                if (data.decorations) {
                  for (var k = 0; k < state.partners.length; k++) {
                    if (state.partners[k].id === t) { state.partners[k].decorations = data.decorations; break; }
                  }
                }
                toast('换好啦 ✨');
                window._tbBuildDecoList();
                render();
              } else {
                toast(data.error || '切换失败', 'error');
              }
            } catch (e) { toast('网络错误', 'error'); }
          };
        })(di.id, tid, typeKey);
      } else if (canBuy) {
        btn.style.cursor = 'pointer';
        btn.onclick = (function(d) {
          return function() {
            window._tbClose();
            window._tbBuyDeco(d.id, d.name, d.icon, d.type, d.price);
          };
        })(di);
      }
      list.appendChild(btn);
    }

    var titleSection = document.getElementById('modal-title-section');
    var overlay = $('#modal-overlay');
    var modal = overlay ? overlay.querySelector('.modal') : null;
    if (titleSection && titleSection.parentNode) {
      titleSection.parentNode.insertBefore(list, titleSection);
    } else if (modal) {
      var actions = modal.querySelector('.modal-actions');
      if (actions) modal.insertBefore(list, actions);
      else modal.appendChild(list);
    }
  };

  // ════════════════════════════════════════════════════════════════
  //  拖动排序（HTML5 Drag & Drop API）
  // ════════════════════════════════════════════════════════════════
  var _dragPartnerId = null;
  window._tbDragStart = function(e) {
    var el = e.currentTarget;
    _dragPartnerId = el.getAttribute('data-partner-id');
    el.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', _dragPartnerId); } catch {}
    }
  };
  window._tbDragOver = function(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    return false;
  };
  window._tbDragEnter = function(e) {
    var el = e.currentTarget;
    if (el && el.classList) el.classList.add('drag-over');
  };
  window._tbDragLeave = function(e) {
    var el = e.currentTarget;
    if (el && el.classList) el.classList.remove('drag-over');
  };
  window._tbDrop = function(e) {
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    var targetEl = e.currentTarget;
    var targetId = targetEl.getAttribute('data-partner-id');
    if (!_dragPartnerId || !targetId || _dragPartnerId === targetId) return false;

    var newOrder = state.partners.map(function(p) { return p.id; });
    var fromIdx = newOrder.indexOf(_dragPartnerId);
    var toIdx = newOrder.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return false;
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, _dragPartnerId);
    state.partnerOrder = newOrder;
    targetEl.classList.remove('drag-over');
    render();
    api('/api/partner-order', { method: 'POST', body: JSON.stringify({ order: newOrder }) }).catch(function() {});
    return false;
  };
  window._tbDragEnd = function(e) {
    var el = e.currentTarget;
    if (el && el.classList) el.classList.remove('dragging');
    var all = document.querySelectorAll('.partner-card');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('drag-over');
    _dragPartnerId = null;
  };

  // ─── 领取光粒 ───
  window._tbClaim = async function() {
    if (state.newAvailable <= 0) return;
    try {
      var data = await api('/api/claim', { method: 'POST' });
      if (data.success) {
        state.jar = data.jar;
        state.newAvailable = 0;
        toast('收了 ' + data.claimed + ' ✨');
        render();
      }
    } catch (e) {
      toast('领取失败', 'error');
    }
  };

  // ─── 风铃悬浮球：打开页面自动启动（半自动：关过则本次不弹）───
  window._tbFenglingAutoBoot = async function() {
    if (state.fenglingRunning) return; // 已经在跑不重复启动
    var st;
    try {
      // 消费式读取：dismissed 读一次即清除；Hana 重启内存重置
      st = await api('/api/fengling/autoboot');
    } catch { return; }
    if (!st || !st.ok) return;
    state.fenglingRunning = !!st.running;
    if (st.running) return;
    if (st.dismissed) return; // 上次手动关过：本次打开页面不弹
    if (!st.pyQtOk) {
      toast('风铃需要 Python + PyQt6，装一下：pip install PyQt6', 'error');
      return;
    }
    showPersistentToast('正在启动风铃…');
    try {
      var start = await api('/api/fengling/start', { method: 'POST' });
      if (start.ok) {
        state.fenglingRunning = true;
        updatePersistentToast('风铃已飘出 🎐');
        setTimeout(clearPersistentToast, 1800);
        render();
      } else {
        updatePersistentToast(start.error || '风铃启动失败', 'error');
        setTimeout(clearPersistentToast, 3000);
      }
    } catch (e) {
      updatePersistentToast('风铃启动失败', 'error');
      setTimeout(clearPersistentToast, 3000);
    }
  };

  // ─── 风铃悬浮球开关（没跑就启动，跑着就收起）───
  window._tbToggleFengling = async function() {
    try {
      var st = await api('/api/fengling/status');
      if (!st.ok) {
        toast('风铃状态查询失败', 'error');
        return;
      }
      if (st.running) {
        var stop = await api('/api/fengling/stop', { method: 'POST' });
        if (stop.ok) {
          state.fenglingRunning = false;
          toast('风铃收起啦');
          render();
        } else {
          toast(stop.error || '停止失败', 'error');
        }
      } else {
        if (st.pyQtOk) {
          showPersistentToast('正在启动风铃…');
          var start = await api('/api/fengling/start', { method: 'POST' });
          if (start.ok) {
            state.fenglingRunning = true;
            updatePersistentToast('风铃已飘出 🎐');
            setTimeout(clearPersistentToast, 1800);
            render();
          } else {
            updatePersistentToast(start.error || '启动失败', 'error');
            setTimeout(clearPersistentToast, 3000);
          }
        } else {
          toast('风铃需要 Python + PyQt6，装一下：pip install PyQt6', 'error');
        }
      }
    } catch (e) {
      toast('操作失败：' + (e && e.message ? e.message : '网络异常'), 'error');
    }
  };

  // ─── 切换标签（老版本，保留兼容）──
  window._tbTab = function(tab) {
    state.currentTab = tab;
    render();
  };

  // ─── 弹窗（保留以兼容老代码）──
  window._tbOpen = async function(type, itemId, itemName, icon) {
    if (!state.selectedPartnerId) {
      toast('先在左边选一个助手', 'error');
      return;
    }
    // 走快路径
    window._tbQuickAction(type, itemId, itemName, icon);
  };

  // ─── 确认弹窗（保留以兼容）──
  window._tbConfirm = async function() {
    if (!currentAction) return;
    var target = $('#modal-target');
    if (!target || !target.value) {
      toast('请选择助手', 'error');
      return;
    }
    currentAction.target = target.value;
    await window._tbQuickAction(currentAction.type, currentAction.itemId, currentAction.itemName, currentAction.icon);
  };

  // ─── 关闭弹窗 ───
  window._tbClose = function() {
    var overlay = $('#modal-overlay');
    if (overlay) overlay.classList.remove('show');
    var titleSection = $('#modal-title-section');
    if (titleSection) titleSection.style.display = 'none';
    var confirm = $('#modal-confirm');
    if (confirm) { confirm.style.display = ''; confirm.onclick = window._tbConfirm; }
    var ts = $('#modal-target-section');
    if (ts) ts.style.display = '';
    currentAction = null;
    // 清理动态列表
    var lists = ['modal-interact-list', 'modal-gift-list', 'modal-deco-list'];
    for (var i = 0; i < lists.length; i++) {
      var el = document.getElementById(lists[i]);
      if (el) el.remove();
    }
  };

  // ─── 充电 ───
  window._tbRecharge = async function(partnerId) {
    try {
      var data = await api('/api/recharge', {
        method: 'POST',
        body: JSON.stringify({ to: partnerId }),
      });
      if (data.success) {
        state.jar = data.jar;
        for (var ri = 0; ri < state.partners.length; ri++) {
          if (state.partners[ri].id === partnerId) {
            state.partners[ri].recharged = true;
            if (state.partners[ri].variables) {
              state.partners[ri].variables.energy = 100;
            }
            break;
          }
        }
        toast(data.tip || '⚡ 充电完成！');
        render();
      } else {
        toast(data.error || '充电失败', 'error');
      }
    } catch (e) {
      toast('网络错误', 'error');
    }
  };

  // ─── 购买装饰（弹窗里用）──
  window._tbBuyDeco = async function(decorationId, name, icon, type, price) {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay) return;
    var title = document.getElementById('modal-title');
    var target = document.getElementById('modal-target');
    var confirm = document.getElementById('modal-confirm');
    var titleSection = document.getElementById('modal-title-section');
    var titleInput = document.getElementById('modal-title-input');

    title.textContent = icon + ' ' + name;
    target.innerHTML = '';
    for (var i = 0; i < state.partners.length; i++) {
      var opt = document.createElement('option');
      opt.value = state.partners[i].id;
      opt.textContent = state.partners[i].name;
      if (state.partners[i].id === state.selectedPartnerId) opt.selected = true;
      target.appendChild(opt);
    }
    if (type === 'title' || type === 'titleEdit') {
      titleSection.style.display = '';
      titleInput.value = '';
      confirm.textContent = '购买 ✨' + price;
      confirm.className = 'modal-btn confirm';
      confirm.onclick = async function() {
        var tid = target.value;
        var ttext = titleInput.value.trim();
        if (!tid) { toast('请选择助手', 'error'); return; }
        if (!ttext) { toast('请输入称号文字', 'error'); return; }
        var data = await api('/api/buy-decoration', {
          method: 'POST',
          body: JSON.stringify({ decorationId: decorationId, target: tid, text: ttext }),
        });
        if (data.success) {
          state.jar = data.jar;
          if (data.decorations) {
            for (var i = 0; i < state.partners.length; i++) {
              if (state.partners[i].id === tid) {
                state.partners[i].decorations = data.decorations;
                break;
              }
            }
          }
          toast(icon + ' ' + name + ' 购买成功！');
          titleSection.style.display = 'none';
          window._tbClose();
          render();
        } else {
          toast(data.error || '购买失败', 'error');
        }
      };
    } else {
      titleSection.style.display = 'none';
      confirm.textContent = '购买 ✨' + price;
      confirm.className = 'modal-btn confirm';
      confirm.onclick = async function() {
        var tid = target.value;
        if (!tid) { toast('请选择助手', 'error'); return; }
        var data = await api('/api/buy-decoration', {
          method: 'POST',
          body: JSON.stringify({ decorationId: decorationId, target: tid }),
        });
        if (data.success) {
          state.jar = data.jar;
          var partner = null;
          for (var i = 0; i < state.partners.length; i++) {
            if (state.partners[i].id === tid) { partner = state.partners[i]; break; }
          }
          if (data.decorations && partner) partner.decorations = data.decorations;
          toast(icon + ' ' + name + ' 购买成功！');
          window._tbClose();
          render();
        } else {
          toast(data.error || '购买失败', 'error');
        }
      };
    }
    overlay.classList.add('show');
  };

  // ─── 关闭小纸条引导卡 ───
  window._tbDismissNoteGuide = async function() {
    try { await api('/api/notes/read', { method: 'POST' }); } catch {}
    state.hasNewNotes = false;
    state.showNoteGuide = false;
    var guide = document.getElementById('note-guide');
    if (guide) guide.style.display = 'none';
    var btn = document.querySelector('.topbar-note-btn');
    if (btn) btn.classList.remove('pulse');
  };

  // ─── 小纸条弹窗 ───
  window._tbShowNotes = async function() {
    var overlay = document.getElementById('notes-overlay');
    if (!overlay) {
      var div = document.createElement('div');
      div.className = 'modal-overlay';
      div.id = 'notes-overlay';
      div.innerHTML = '<div class="modal notes-modal" role="dialog" aria-modal="true" aria-labelledby="notes-modal-title">' +
        '<div class="notes-modal-header">' +
        '<h3 id="notes-modal-title">小纸条</h3>' +
        '<button class="modal-close" aria-label="关闭小纸条" onclick="document.getElementById(\'notes-overlay\').classList.remove(\'show\')">×</button>' +
        '</div>' +
        '<div class="notes-list" id="notes-list">' +
        '<div class="llm-loading">加载中...</div></div></div>';
      div.addEventListener('click', function(e) {
        if (e.target === div) div.classList.remove('show');
      });
      document.body.appendChild(div);
      overlay = div;
    }
    overlay.classList.add('show');
    await loadNotes();
    try { await api('/api/notes/read', { method: 'POST' }); } catch {}
    state.hasNewNotes = false;
    state.showNoteGuide = false;
    var guide = document.getElementById('note-guide');
    if (guide) guide.style.display = 'none';
    var btn = document.querySelector('.topbar-note-btn');
    if (btn) btn.classList.remove('pulse');
  };

  async function loadNotes() {
    try {
      var data = await api('/api/notes');
      var list = document.getElementById('notes-list');
      if (!list) return;

      var groups = data.groups || {};
      var keys = Object.keys(groups);
      if (keys.length === 0) {
        list.innerHTML = '<div class="notes-empty"><div class="notes-empty-icon">💌</div>还没有小纸条 ✨</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < keys.length; i++) {
        var g = groups[keys[i]];
        var notes = g.notes || [];
        if (notes.length === 0) continue;

        var color = g.color || '#89a67f';
        var initial = g.name.charAt(0);
        // 默认展开第一个有纸条的助手，其余收起
        var openClass = (i === 0) ? ' open' : '';

        html += '<div class="notes-group' + openClass + '">';
        html += '<div class="notes-group-header" onclick="window._tbToggleGroup(this)">';
        html += '<div class="notes-group-avatar" style="background:' + color + '">' + escapeHtml(initial) + '</div>';
        html += '<span class="notes-group-name">' + escapeHtml(g.name) + '</span>';
        html += '<span class="notes-group-count">' + notes.length + ' 条</span>';
        html += '<span class="notes-group-arrow" aria-hidden="true"></span>';
        html += '</div>';
        html += '<div class="notes-group-body">';

        for (var j = 0; j < notes.length; j++) {
          var n = notes[j];
          var dateStr = n.createdAt ? timeAgo(n.createdAt) : '';
          var isGift = n.triggerType === 'gift';
          var typeLabel = isGift ? '礼物' : '互动';
          var itemLabel = n.itemName || '';

          html += '<div class="notes-item">';
          html += '<div class="notes-item-head">';
          html += '<span class="notes-item-type ' + (isGift ? 'gift' : 'talk') + '">' + typeLabel + '</span>';
          if (itemLabel) html += '<span class="notes-item-name">' + escapeHtml(itemLabel) + '</span>';
          html += '<span class="notes-item-time">' + dateStr + '</span>';
          html += '</div>';
          html += '<div class="notes-content">' + escapeHtml(n.content) + '</div>';
          html += '</div>';
        }
        html += '</div>';
        html += '</div>';
      }

      list.innerHTML = html;
    } catch (e) {
      console.error('[闲不住] 加载小纸条失败:', e);
    }
  }

  window._tbUninstall = async function() {
    try {
      var data = await api('/api/uninstall', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      if (data.success) {
        toast('✅ 清理完成，请关闭 Hana 并手动删除插件目录');
      } else {
        toast('❌ 清理失败：' + (data.error || '未知错误'), 'error');
      }
    } catch (e) {
      toast('❌ 网络错误：' + (e.message || '未知'), 'error');
    }
  }

  // ─── 折叠小纸条 ───
  window._tbToggleGroup = function(header) {
    var group = header.parentElement;
    group.classList.toggle('open');
    var arrow = header.querySelector('.notes-group-arrow');
    if (arrow) arrow.textContent = group.classList.contains('open') ? '▼' : '▶';
  };

  // ─── 模型设置（占位）──
  var _llmProviders = [];

  window._tbToggleLLM = function() {
    var modal = document.getElementById('llm-modal');
    if (modal) {
      modal.classList.add('show');
      modal.onclick = function(e) { if (e.target === modal) window._tbCloseLLM(); };
      loadLLMConfig();
    }
  };

  window._tbCloseLLM = function() {
    var modal = document.getElementById('llm-modal');
    if (modal) modal.classList.remove('show');
  };

  function updateLLMKeyHint() {
    var hint = document.getElementById('llm-key-hint');
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    if (!hint || !modelSel) return;
    var pid = providerSel ? providerSel.value : '';
    if (pid === '__custom__') { hint.style.display = 'none'; return; }
    var opt = modelSel.options[modelSel.selectedIndex];
    var missing = opt && opt.getAttribute('data-available') === 'false';
    hint.style.display = missing ? '' : 'none';
  }

  window._tbLLMProviderChange = function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var customDiv = document.getElementById('llm-custom');
    var pid = providerSel ? providerSel.value : '';
    if (customDiv) customDiv.style.display = (pid === '__custom__') ? 'block' : 'none';
    updateLLMKeyHint();
    if (!pid || pid === '__custom__' || !modelSel) return;
    var provider = _llmProviders.find(function(p) { return p.id === pid; });
    modelSel.innerHTML = '<option value="">请选择模型</option>';
    if (provider && provider.models) {
      for (var i = 0; i < provider.models.length; i++) {
        var m = provider.models[i];
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        opt.setAttribute('data-available', m.available === true ? 'true' : 'false');
        if (m.id === (state.llmConfig && state.llmConfig.modelId)) opt.selected = true;
        if (!m.available) opt.textContent = '⚠️ ' + opt.textContent;
        modelSel.appendChild(opt);
      }
    }
    updateLLMKeyHint();
  };

  window._tbLLMModelChange = function() {
    updateLLMKeyHint();
  };

  window._tbCustomFetch = async function() {
    var urlInput = document.getElementById('llm-custom-url');
    var keyInput = document.getElementById('llm-custom-key');
    var apiSel = document.getElementById('llm-custom-api');
    var modelSel = document.getElementById('llm-custom-model');
    var resultDiv = document.getElementById('llm-custom-result');
    if (!urlInput || !keyInput || !modelSel) return;
    try {
      var data = await api('/api/llm-custom-fetch', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: urlInput.value.trim(), apiKey: keyInput.value.trim(), api: apiSel ? apiSel.value : 'openai-completions' }),
      });
      if (data.success && data.models) {
        var html = '<option value="">请选择模型</option>';
        for (var i = 0; i < data.models.length; i++) {
          html += '<option value="' + escapeHtml(data.models[i].id) + '">' + escapeHtml(data.models[i].name || data.models[i].id) + '</option>';
        }
        modelSel.innerHTML = html;
        if (resultDiv) { resultDiv.innerHTML = '✅ 连接成功，共 ' + data.models.length + ' 个模型'; }
      } else {
        if (resultDiv) { resultDiv.innerHTML = '❌ ' + escapeHtml(data.error || '连接失败'); }
      }
    } catch (e) {
      if (resultDiv) { resultDiv.innerHTML = '❌ 网络错误：' + escapeHtml(e.message || '未知'); }
    }
  };

  window._tbCustomSave = async function() {
    var urlInput = document.getElementById('llm-custom-url');
    var keyInput = document.getElementById('llm-custom-key');
    var apiSel = document.getElementById('llm-custom-api');
    var modelSel = document.getElementById('llm-custom-model');
    var statusEl = document.getElementById('llm-custom-status');
    var baseUrl = urlInput ? urlInput.value.trim() : '';
    var apiKey = keyInput ? keyInput.value.trim() : '';
    var modelId = modelSel ? modelSel.value : '';
    var api = apiSel ? apiSel.value : 'openai-completions';
    if (!baseUrl || !apiKey || !modelId) {
      if (statusEl) statusEl.textContent = '请填写完整信息';
      return;
    }
    try {
      var data = await api('/api/llm-custom-save', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, modelId, api }),
      });
      if (data.success) {
        if (statusEl) statusEl.textContent = '✅ 已保存';
        toast('自定义模型已保存');
      } else {
        if (statusEl) statusEl.textContent = '❌ ' + (data.error || '保存失败');
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = '❌ 保存失败';
    }
  };

  async function loadLLMConfig() {
    try {
      var resp = await api('/api/llm-providers');
      _llmProviders = resp.providers || [];
      var providerSel = document.getElementById('llm-provider');
      var formDiv = document.getElementById('llm-form');
      var loadingDiv = document.getElementById('llm-loading');
      if (providerSel) {
        providerSel.innerHTML = '<option value="">请选择</option>';
        for (var i = 0; i < _llmProviders.length; i++) {
          var opt = document.createElement('option');
          opt.value = _llmProviders[i].id;
          opt.textContent = _llmProviders[i].name;
          providerSel.appendChild(opt);
        }
        var customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = '自定义 API';
        providerSel.appendChild(customOpt);
      }
      if (loadingDiv) loadingDiv.style.display = 'none';
      if (formDiv) formDiv.style.display = '';
      // 自动选当前
      if (state.llmConfig && state.llmConfig.providerId && providerSel) {
        providerSel.value = state.llmConfig.providerId;
        window._tbLLMProviderChange();
      }
    } catch (e) {
      var loadingDiv = document.getElementById('llm-loading');
      if (loadingDiv) loadingDiv.textContent = '加载失败';
    }
  }

  window._tbLLMSave = async function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var statusEl = document.getElementById('llm-status');
    var pid = providerSel ? providerSel.value : '';
    var mid = modelSel ? modelSel.value : '';
    if (!pid || pid === '__custom__') { if (statusEl) statusEl.textContent = '请选择供应商'; return; }
    if (!mid) { if (statusEl) statusEl.textContent = '请选择模型'; return; }
    try {
      var data = await api('/api/llm-settings', {
        method: 'POST',
        body: JSON.stringify({ providerId: pid, modelId: mid }),
      });
      if (data.success) {
        state.llmConfig = { providerId: pid, modelId: mid, updatedAt: new Date().toISOString() };
        if (statusEl) statusEl.textContent = '✅ 已保存';
        toast('模型设置已保存');
        render();
      } else {
        if (statusEl) statusEl.textContent = '❌ ' + (data.error || '保存失败');
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = '❌ 保存失败';
    }
  };

  window._tbLLMTest = async function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var pid = providerSel ? providerSel.value : '';
    var mid = modelSel ? modelSel.value : '';
    var resultEl = document.getElementById('llm-test-result');
    if (!pid || !mid) {
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-error)">请先选择供应商和模型</span>';
      return;
    }
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-muted)">⏳ 正在测试连接…</span>';
    try {
      var data = await api('/api/llm-test', {
        method: 'POST',
        body: JSON.stringify({ providerId: pid, modelId: mid }),
      });
      if (data.success) {
        if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-ink-2)">✅ ' + (data.message || '连接成功') + '</span>';
      } else {
        if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-error)">❌ ' + escapeHtml(data.error || '测试失败') + '</span>';
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-error)">网络错误</span>';
    }
  };

  window._tbCheckUpdate = async function() {
    var resultEl = document.getElementById('update-result');
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-muted)">↻ 正在检查更新…</span>';
    try {
      var data = await api('/api/check-update');
      if (!data.success) {
        if (resultEl) resultEl.innerHTML = '<div style="color:var(--color-error)">❌ ' + (data.error || '检查失败') + '</div>';
        return;
      }
      if (!data.hasUpdate) {
        if (resultEl) resultEl.innerHTML = '✅ ' + data.message;
        return;
      }
      var html = '<div style="margin-top:var(--space-sm);padding:var(--space-sm);background:var(--color-paper);border-radius:var(--radius-control);border:var(--rule-thin) solid var(--color-rule);font-size:var(--text-sm)">';
      html += '<div style="font-family:var(--font-display);font-weight:400;margin-bottom:var(--space-xs)">🎉 ' + data.message + '</div>';
      if (data.releaseBody) {
        var body = data.releaseBody
          .replace(/^###?\s+(.+)/gm, '<strong>$1</strong>')
          .replace(/^-\s+(.+)/gm, '· $1')
          .replace(/\n\n/g, '<br><br>')
          .replace(/\n/g, '<br>');
        html += '<div style="color:var(--color-muted);max-height:200px;overflow-y:auto;margin-bottom:var(--space-sm);line-height:1.6">' + body + '</div>';
      }
      html += '<div style="display:flex;flex-wrap:wrap;gap:var(--space-xs)">';
      html += '<a href="' + data.downloadUrl + '" class="llm-save" style="display:inline-flex;align-items:center;text-decoration:none;padding:var(--space-xs) var(--space-sm);font-size:var(--text-sm);background:var(--color-accent);color:var(--color-accent-ink);border-radius:var(--radius-control);white-space:nowrap">⬇ 下载更新</a>';
      html += '<a href="' + data.updateUrl + '" target="_blank" class="llm-save" style="display:inline-flex;align-items:center;text-decoration:none;padding:var(--space-xs) var(--space-sm);font-size:var(--text-sm);background:var(--color-accent-soft);color:var(--color-ink);border-radius:var(--radius-control);white-space:nowrap">查看详情 →</a>';
      html += '</div></div>';
      if (resultEl) resultEl.innerHTML = html;
    } catch (e) {
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-error)">网络错误</span>';
    }
  };

  // ─── 加载数据 ───
  async function loadData() {
    try {
      var data = await api('/api/data');
      state.jar = data.jar || 0;
      state.newAvailable = data.newAvailable || 0;
      state.sectionTitle = data.sectionTitle || '';
      state.partners = data.partners || [];
      state.shopItems = data.shopItems || [];
      state.interactItems = data.interactItems || [];
      state.prankItems = data.prankItems || [];
      state.decorationItems = data.decorationItems || [];
      state.tip = data.tip || '';
      state.hasNotes = data.hasNotes || false;
      state.hasNewNotes = data.hasNewNotes || false;
      state.showNoteGuide = data.showNoteGuide || false;
      state.version = data.version || '0.1.0';
      state.pendingDetails = data.pendingDetails || [];

      try {
        var llmRes = await api('/api/llm-settings');
        state.llmConfig = llmRes.config || {};
      } catch {}

      // v0.4：加载用户自定义伙伴排序
      try {
        var orderRes = await api('/api/partner-order');
        if (orderRes.success && Array.isArray(orderRes.order)) {
          state.partnerOrder = orderRes.order;
        }
      } catch {}

      // v0.4：自动选中"当前正在聊的 agent"
      try {
        var curRes = await api('/api/current-agent');
        if (curRes.success && curRes.agentId) {
          state.currentAgentId = curRes.agentId;
          var matched = false;
          for (var pi = 0; pi < state.partners.length; pi++) {
            if (state.partners[pi].id === curRes.agentId) { matched = true; break; }
          }
          if (matched && !state.selectedPartnerId) {
            state.selectedPartnerId = curRes.agentId;
          }
        }
      } catch {}

      // v0.4.1：首次加载默认展开互动
      if (!state._initializedOnce) {
        state._initializedOnce = true;
        if (state.selectedPartnerId && state.expandedPanel === null) {
          state.expandedPanel = 'interact';
        }
      }

      render();

      // 风铃：打开页面自动启动（用户手动收起过则本次不再弹）
      window._tbFenglingAutoBoot();
    } catch (e) {
      console.error('[闲不住] 加载失败:', e);
    }
  }

  // ─── v0.4：定时轮询当前 agent（5 秒一次）──
  setInterval(async function() {
    try {
      var curRes = await api('/api/current-agent');
      if (curRes.success && curRes.agentId) {
        var prev = state.currentAgentId;
        state.currentAgentId = curRes.agentId;
        if (prev !== curRes.agentId && !window._tbUserSelected) {
          var matched = false;
          for (var pi = 0; pi < state.partners.length; pi++) {
            if (state.partners[pi].id === curRes.agentId) { matched = true; break; }
          }
          if (matched) {
            state.selectedPartnerId = curRes.agentId;
            render();
          }
        }
      }
    } catch {}

    // 风铃：同步实际运行状态（右键关闭风铃后，按钮对勾自动消失）
    try {
      var fst = await api('/api/fengling/status');
      if (fst && fst.ok && !!fst.running !== state.fenglingRunning) {
        state.fenglingRunning = !!fst.running;
        render();
      }
    } catch {}
  }, 5000);


  // ─── 启动 ───
  loadData();

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'ready' }, '*');
    window.parent.postMessage({
      protocol: 'hana.plugin.ui', version: 1,
      kind: 'event', type: 'hana.ready',
    }, '*');
  }
})();
