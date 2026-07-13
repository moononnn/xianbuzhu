// 闲不住 — 前端（补给站风格）
(function() {
  'use strict';

  // ─── HTML 转义（防 XSS） ───
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── 主题同步 ───
  async function syncTheme() {
    try {
      const resp = await fetch('/plugins/theme.css?_t=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) return;
      const css = await resp.text();
      const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
      if (!rootMatch) return;
      const decls = rootMatch[1];
      const get = function(name) {
        var m = decls.match(new RegExp('--' + name + '\\s*:\\s*([^;]+);'));
        return m ? m[1].trim() : null;
      };
      var root = document.documentElement;
      var bg = get('bg'); if (bg) root.style.setProperty('--bg', bg);
      var card = get('bg-card'); if (card) root.style.setProperty('--card', card);
      var border = get('border'); if (border) root.style.setProperty('--border', border);
      var text = get('text'); if (text) root.style.setProperty('--text', text);
      var ts = get('text-muted'); if (ts) root.style.setProperty('--text-secondary', ts);
      var accent = get('accent'); if (accent) {
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--accent-soft', accent + '1a');
      }
    } catch (e) {}
  }

  syncTheme();

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
  };
  var currentAction = null;

  // ─── Toast ───
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
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
    var claimLabel = hasNew ? '收 ✨ +' + state.newAvailable : '已领取';
    var claimClass = hasNew ? 'topbar-btn' : 'topbar-btn done';
    var isLLMConfigured = !!(state.llmConfig && state.llmConfig.providerId);

    var html = '';

    // 顶栏
    html += '<div class="topbar">';
    html += '<div class="topbar-left"><span class="topbar-num">' + state.jar + '</span><span class="topbar-unit">✨</span></div>';
    html += '<div class="topbar-right">';
    // 小纸条按钮：有了第一条小纸条后才出现（保持惊喜感）
    if (state.hasNotes) {
      html += '<button class="topbar-note-btn' + (state.hasNewNotes ? ' pulse' : '') + '" onclick="window._tbShowNotes()" title="小纸条">📝</button>';
    }
    html += '<button class="topbar-note-btn ' + (isLLMConfigured ? '' : 'topbar-warn') + '" onclick="window._tbToggleLLM()" title="模型设置">⚙️</button>';
    html += '<button class="' + claimClass + '" ' + (!hasNew ? 'disabled' : '') + ' onclick="window._tbClaim()">' + claimLabel + '</button>';
    html += '</div></div>';

    // ── 小纸条引导卡：仅首次出现小纸条时展示（完整引导） ──
    //    后续有新纸条只靠按钮脉冲，不重复弹引导卡
    if (state.showNoteGuide) {
      html += '<div class="note-guide" id="note-guide">';
      html += '<div class="note-guide-icon">💌</div>';
      html += '<div class="note-guide-body">';
      html += '<div class="note-guide-title">收到了一张小纸条！</div>';
      html += '<div class="note-guide-desc">你送给助手的每一次互动和礼物，它们都悄悄记在心里了。偶尔会写张小纸条，塞回给你——就像朋友之间的小秘密。</div>';
      html += '<div class="note-guide-actions">';
      html += '<button class="note-guide-btn" onclick="window._tbShowNotes();window._tbDismissNoteGuide()">去看看 📝</button>';
      html += '<span class="note-guide-dismiss" onclick="window._tbDismissNoteGuide()">知道了</span>';
      html += '</div></div></div>';
    }

    // 展板
    html += '<div class="board">';
    html += '<div class="board-title tip">' + (state.tip || state.sectionTitle || '') + '</div>';
    for (var i = 0; i < state.partners.length; i++) {
      var p = state.partners[i];
      var initial = p.name.charAt(0);
      html += '<div class="board-item">';
      if (p.avatarUrl) {
        html += '<div class="board-avatar-img"><img src="' + BASE + p.avatarUrl + AUTH + '" alt="" onerror="this.style.display=\'none\';this.parentElement.className=\'board-avatar\';this.parentElement.style.background=\'' + p.color + '\';this.parentElement.textContent=\'' + initial + '\'"></div>';
      } else {
        html += '<div class="board-avatar" style="background:' + p.color + '">' + initial + '</div>';
      }
      html += '<div class="board-info">';
      html += '<div class="board-name">' + p.name + '</div>';
      html += '<div class="board-doing">' + p.doing + '</div>';
      html += '</div>';
      html += '<span class="board-badge ' + (p.active ? 'badge-on' : 'badge-off') + '">' + (p.active ? '在线' : '摸鱼') + '</span>';
      html += '</div>';
    }
    html += '</div>';

    // Tab 切换
    html += '<div class="tabbar">';
    html += '<div class="tab' + (state.currentTab === 'interact' ? ' active' : '') + '" onclick="window._tbTab(\'interact\')">互动</div>';
    html += '<div class="tab' + (state.currentTab === 'shop' ? ' active' : '') + '" onclick="window._tbTab(\'shop\')">小铺</div>';
    html += '</div>';

    // 互动区
    html += '<div class="tab-content' + (state.currentTab === 'interact' ? ' active' : '') + '" id="tab-interact">';
    html += '<div class="tab-label">日常互动</div>';
    html += '<div class="action-grid">';
    for (var j = 0; j < state.interactItems.length; j++) {
      var it = state.interactItems[j];
      html += '<button class="action-btn" onclick="window._tbOpen(\'interact\',\'' + it.id + '\',\'' + it.name + '\',\'' + it.icon + '\')">' + it.icon + ' ' + it.name + '</button>';
    }
    html += '</div>';

    // 恶作剧
    html += '<div class="prank-divider">恶作剧</div>';
    html += '<div class="action-grid">';
    for (var k = 0; k < state.prankItems.length; k++) {
      var pk = state.prankItems[k];
      html += '<button class="prank-btn" onclick="window._tbOpen(\'prank\',\'' + pk.id + '\',\'' + pk.name + '\',\'' + pk.icon + '\')">' + pk.icon + ' ' + pk.name + '</button>';
    }
    html += '</div>';
    html += '</div>';

    // 小铺
    html += '<div class="tab-content' + (state.currentTab === 'shop' ? ' active' : '') + '" id="tab-shop">';
    html += '<div class="tab-label">小铺 · 用光粒兑换礼物</div>';
    html += '<div class="shop-grid">';
    for (var m = 0; m < state.shopItems.length; m++) {
      var si = state.shopItems[m];
      var canBuy = state.jar >= si.price;
      html += '<div class="shop-item' + (!canBuy ? ' locked' : '') + '" ' + (canBuy ? 'onclick="window._tbOpen(\'gift\',\'' + si.id + '\',\'' + si.name + '\',\'' + si.icon + '\')"' : '') + '>';
      html += '<div class="item-icon">' + si.icon + '</div>';
      html += '<div class="item-name">' + si.name + '</div>';
      html += '<div class="item-price">✨ ' + si.price + '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';

    // 弹窗
    html += '<div class="modal-overlay" id="modal-overlay">';
    html += '<div class="modal">';
    html += '<h3 id="modal-title"></h3>';
    html += '<div class="modal-section"><label>送给谁？</label><select class="modal-select" id="modal-target"></select></div>';
    html += '<div class="modal-actions">';
    html += '<button class="modal-btn cancel" onclick="window._tbClose()">取消</button>';
    html += '<button class="modal-btn confirm" id="modal-confirm" onclick="window._tbConfirm()">确认</button>';
    html += '</div></div></div>';

    // ── 模型设置弹窗（由顶栏 ⚙️ 触发） ──
    html += '<div class="modal-overlay" id="llm-modal">';
    html += '<div class="modal llm-modal">';
    html += '<h3>⚙️ 模型设置 <button class="modal-close" onclick="window._tbCloseLLM()">✕</button></h3>';
    html += '<div class="llm-loading" id="llm-loading">加载中...</div>';
    html += '<div class="llm-form" id="llm-form" style="display:none">';
    html += '<div class="llm-row"><label>供应商</label><select id="llm-provider" onchange="window._tbLLMProviderChange()"><option value="">请选择</option></select></div>';
    html += '<div class="llm-row"><label>模型</label><select id="llm-model" onchange="window._tbLLMModelChange()"><option value="">先选供应商</option></select></div>';
    html += '<div class="llm-supplement" id="llm-supplement" style="display:none">';
    html += '<div class="llm-row"><label>API Key</label><input id="llm-supplement-key" class="llm-input" type="password" placeholder="sk-..."></div>';
    html += '<div class="llm-row"><button class="llm-save" onclick="window._tbLLMSupplementKey()">保存 Key</button>';
    html += '<span class="llm-status" id="llm-supplement-status"></span></div></div>';
    html += '<div class="llm-custom" id="llm-custom" style="display:none">';
    html += '<div class="llm-row"><label>API 地址</label><input id="llm-custom-url" class="llm-input" placeholder="https://api.example.com/v1"></div>';
    html += '<div class="llm-row"><label>API Key</label><input id="llm-custom-key" class="llm-input" type="password" placeholder="sk-..."></div>';
    html += '<div class="llm-row"><label>协议</label><select id="llm-custom-api" class="llm-select"><option value="openai-completions">OpenAI 兼容</option><option value="anthropic-messages">Anthropic</option></select></div>';
    html += '<div class="llm-row"><button class="llm-test-btn" onclick="window._tbCustomFetch()">🔄 获取模型列表</button></div>';
    html += '<div class="llm-row"><label>模型</label><select id="llm-custom-model"><option value="">先获取模型列表</option></select></div>';
    html += '<div class="llm-row"><button class="llm-save" onclick="window._tbCustomSave()">保存自定义</button>';
    html += '<span class="llm-status" id="llm-custom-status"></span></div>';
    html += '<div class="llm-test-result" id="llm-custom-result"></div></div>';
    html += '<div class="llm-row"><button class="llm-save" onclick="window._tbLLMSave()">保存</button>';
    html += '<span class="llm-status" id="llm-status"></span></div>';
    html += '<div class="llm-test-result" id="llm-test-result"></div>';
    html += '<div class="llm-row" style="margin-top:12px;gap:8px;display:flex;flex-wrap:wrap">';
    html += '<button class="llm-save" onclick="window._tbLLMTest()" style="background:var(--accent-soft);color:var(--text)">🔄 测试连接</button>';
    html += '<button class="llm-save" onclick="window._tbCheckUpdate()" style="background:var(--accent-soft);color:var(--text)">📦 检查更新</button>';
    html += '</div>';
    html += '<div id="update-result" style="font-size:12px;margin-top:8px;color:var(--text-secondary)"></div></div>';
    html += '<div class="uninstall-section">';
    html += '<hr style="margin:20px 0;border-color:var(--border)">';
    html += '<details style="font-size:12px;color:var(--text-secondary)">';
    html += '<summary style="cursor:pointer;color:#e74c3c">⚠️ 彻底卸载闲不住</summary>';
    html += '<p style="margin:8px 0">点击后清理所有闲不住残留数据，包括：助手协议注入、数据文件、skill 配置。</p>';
    html += '<p style="margin:8px 0">清理后请关闭 Hana 并手动删除插件目录。</p>';
    html += '<button class="llm-save" onclick="window._tbUninstall()" style="background:#e74c3c;color:#fff">🗑️ 清理残留数据</button>';
    html += '</details></div></div></div>';

    app.innerHTML = html;
  }

  // ─── 模型设置 ───
  var _llmProviders = [];

  window._tbToggleLLM = function() {
    var modal = document.getElementById('llm-modal');
    if (modal) {
      modal.classList.add('show');
      // 点击弹窗外关闭
      modal.onclick = function(e) { if (e.target === modal) window._tbCloseLLM(); };
      loadLLMConfig();
    }
  };

  window._tbCloseLLM = function() {
    var modal = document.getElementById('llm-modal');
    if (modal) modal.classList.remove('show');
  };

  // ─── 补填 API Key ───
  window._tbLLMSupplementKey = async function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var keyInput = document.getElementById('llm-supplement-key');
    var statusEl = document.getElementById('llm-supplement-status');

    var pid = providerSel ? providerSel.value : '';
    var mid = modelSel ? modelSel.value : '';
    var key = keyInput ? keyInput.value.trim() : '';

    if (!pid || !mid || !key) {
      if (statusEl) statusEl.textContent = '请选择模型并填写 Key';
      return;
    }

    try {
      var data = await api('/api/llm-supplement-key', {
        method: 'POST',
        body: JSON.stringify({ providerId: pid, modelId: mid, apiKey: key }),
      });
      if (data.success) {
        if (statusEl) statusEl.textContent = '✅ 已保存';
        toast('Key 已保存，该模型现在可用');
        // 刷新模型列表，移除 ⚠️
        setTimeout(loadLLMConfig, 500);
      } else {
        if (statusEl) statusEl.textContent = '❌ ' + (data.error || '保存失败');
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = '❌ 保存失败';
    }
  };

  window._tbLLMProviderChange = function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var customDiv = document.getElementById('llm-custom');
    var pid = providerSel ? providerSel.value : '';

    // 显示/隐藏自定义配置区域
    if (customDiv) {
      customDiv.style.display = (pid === '__custom__') ? 'block' : 'none';
    }

    // 隐藏补 key 区域
    var suppDiv = document.getElementById('llm-supplement');
    if (suppDiv) suppDiv.style.display = 'none';

    if (!pid || pid === '__custom__' || !modelSel) return;

    var provider = _llmProviders.find(function(p) { return p.id === pid; });
    modelSel.innerHTML = '<option value="">请选择模型</option>';
    if (provider && provider.models) {
      for (var i = 0; i < provider.models.length; i++) {
        var m = provider.models[i];
        var label = m.name;
        if (m.contextWindow) label += ' (' + m.contextWindow + (m.reasoning ? ' 🧠' : '') + ')';
        if (m.available === false) label += ' ⚠️';
        modelSel.innerHTML += '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(label) + '</option>';
      }
    }
  };

  // 选中模型时，如果是 ⚠️ 模型，显示补 key 输入框
  window._tbLLMModelChange = function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var suppDiv = document.getElementById('llm-supplement');
    var suppStatus = document.getElementById('llm-supplement-status');
    if (!suppDiv || !providerSel || !modelSel) return;

    var pid = providerSel.value;
    var mid = modelSel.value;
    if (!pid || !mid || pid === '__custom__') {
      suppDiv.style.display = 'none';
      return;
    }

    // 查这个模型是否 available
    var provider = _llmProviders.find(function(p) { return p.id === pid; });
    var model = provider ? provider.models.find(function(m) { return m.id === mid; }) : null;
    if (model && model.available === false) {
      suppDiv.style.display = 'block';
      if (suppStatus) suppStatus.textContent = '';
    } else {
      suppDiv.style.display = 'none';
    }
  };

  window._tbLLMSave = async function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var status = document.getElementById('llm-status');
    var pid = providerSel ? providerSel.value : '';
    var mid = modelSel ? modelSel.value : '';
    if (!pid || !mid) {
      if (status) status.textContent = '请选择供应商和模型';
      return;
    }
    try {
      var data = await api('/api/llm-settings', {
        method: 'POST',
        body: JSON.stringify({ providerId: pid, modelId: mid }),
      });
      if (data.success) {
        if (status) status.textContent = '✅ 已保存';
        toast('模型设置已保存');
      } else {
        if (status) status.textContent = '❌ ' + (data.error || '保存失败');
      }
    } catch (e) {
      if (status) status.textContent = '❌ 保存失败';
    }
  };

  window._tbLLMTest = async function() {
    var providerSel = document.getElementById('llm-provider');
    var modelSel = document.getElementById('llm-model');
    var resultDiv = document.getElementById('llm-test-result');
    var pid = providerSel ? providerSel.value : '';
    var mid = modelSel ? modelSel.value : '';
    if (!pid || !mid) {
      if (resultDiv) {
        resultDiv.innerHTML = '<span class="test-fail">请先选择供应商和模型</span>';
        resultDiv.style.display = 'block';
      }
      return;
    }
    if (resultDiv) {
      resultDiv.innerHTML = '<span class="test-loading">⏳ 连接中...</span>';
      resultDiv.style.display = 'block';
    }
    try {
      var data = await api('/api/llm-test', {
        method: 'POST',
        body: JSON.stringify({ providerId: pid, modelId: mid }),
      });
      if (resultDiv) {
        if (data.success) {
          resultDiv.innerHTML = '✅ 连接成功！<br>模型回复：<span class="test-reply">' + escapeHtml(data.reply) + '</span>';
        } else {
          resultDiv.innerHTML = '<span class="test-fail">❌ 连接失败：' + escapeHtml(data.error || '未知错误') + '</span>';
        }
      }
    } catch (e) {
      if (resultDiv) {
        resultDiv.innerHTML = '<span class="test-fail">❌ 网络错误：' + escapeHtml(e.message || '未知') + '</span>';
        resultDiv.style.display = 'block';
      }
    }
  };

  async function loadLLMConfig() {
    try {
      var data = await api('/api/llm-providers');
      _llmProviders = data.providers || [];
      var selected = data.selected || {};

      var loading = document.getElementById('llm-loading');
      var form = document.getElementById('llm-form');
      var providerSel = document.getElementById('llm-provider');
      var modelSel = document.getElementById('llm-model');
      var status = document.getElementById('llm-status');

      if (loading) loading.style.display = 'none';
      if (form) form.style.display = 'block';

      if (!providerSel || !modelSel) return;

      providerSel.innerHTML = '<option value="">请选择供应商</option>';
      var firstAvailable = null;
      for (var i = 0; i < _llmProviders.length; i++) {
        var p = _llmProviders[i];
        var hasKey = p.models && p.models.some(function(m) { return m.available !== false; });
        var label = escapeHtml(p.name) + (hasKey ? ' ✅' : '');
        providerSel.innerHTML += '<option value="' + escapeHtml(p.id) + '">' + label + '</option>';
        if (hasKey && !firstAvailable) firstAvailable = p.id;
      }
      providerSel.innerHTML += '<option value="__custom__" style="border-top:2px solid var(--border);margin-top:4px">✏️ 自定义</option>';

      // 如果当前选的是自定义，回显配置
      if (selected.providerId === '__custom__' && data.custom && data.custom.baseUrl) {
        var urlInput = document.getElementById('llm-custom-url');
        var keyInput = document.getElementById('llm-custom-key');
        var apiSel = document.getElementById('llm-custom-api');
        var modelSel2 = document.getElementById('llm-custom-model');
        if (urlInput) urlInput.value = data.custom.baseUrl || '';
        if (keyInput) keyInput.value = data.custom.apiKey || '';
        if (apiSel && data.custom.api) apiSel.value = data.custom.api;
        if (modelSel2 && selected.modelId) {
          modelSel2.innerHTML = '<option value="' + escapeHtml(selected.modelId) + '">' + escapeHtml(selected.modelId) + '</option>';
          modelSel2.value = selected.modelId;
        }
      }

      if (selected.providerId) {
        providerSel.value = selected.providerId;
        window._tbLLMProviderChange();
        if (selected.modelId && selected.providerId !== '__custom__') {
          modelSel.value = selected.modelId;
        }
      } else if (firstAvailable) {
        // 首次使用：自动选第一个有 key 的供应商和模型，自动保存
        providerSel.value = firstAvailable;
        window._tbLLMProviderChange();
        var firstProvider = _llmProviders.find(function(p) { return p.id === firstAvailable; });
        if (firstProvider && firstProvider.models) {
          var firstModel = firstProvider.models.find(function(m) { return m.available !== false; });
          if (firstModel) {
            modelSel.value = firstModel.id;
            // 自动保存
            try {
              await api('/api/llm-settings', {
                method: 'POST',
                body: JSON.stringify({ providerId: firstAvailable, modelId: firstModel.id }),
              });
              state.llmConfig = { providerId: firstAvailable, modelId: firstModel.id };
              if (status) status.textContent = '当前：' + firstAvailable + ' / ' + firstModel.id;
            } catch (e) {
              console.error('[闲不住] 自动保存配置失败:', e);
            }
          }
        }
      }

      state.llmConfig = selected;
      if (selected.providerId && selected.modelId && status) {
        status.textContent = '当前：' + selected.providerId + ' / ' + selected.modelId;
      }
    } catch (e) {
      console.error('[闲不住] 加载模型配置失败:', e);
    }
  }

  // ─── 自定义供应商 ───
  window._tbCustomFetch = async function() {
    var urlInput = document.getElementById('llm-custom-url');
    var keyInput = document.getElementById('llm-custom-key');
    var apiSel = document.getElementById('llm-custom-api');
    var modelSel = document.getElementById('llm-custom-model');
    var resultDiv = document.getElementById('llm-custom-result');

    if (!urlInput || !keyInput || !urlInput.value.trim() || !keyInput.value.trim()) {
      if (resultDiv) { resultDiv.innerHTML = '请填写 API 地址和 Key'; resultDiv.style.display = 'block'; }
      return;
    }

    if (resultDiv) { resultDiv.innerHTML = '⏳ 连接中...'; resultDiv.style.display = 'block'; }

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
      state.tip = data.tip || '';
      state.hasNotes = data.hasNotes || false;
      state.hasNewNotes = data.hasNewNotes || false;
      state.showNoteGuide = data.showNoteGuide || false;

      // 顺便获取模型配置状态，用于齿轮图标
      try {
        var llmRes = await api('/api/llm-settings');
        state.llmConfig = llmRes.config || {};
      } catch {}

      render();
    } catch (e) {
      console.error('[闲不住] 加载失败:', e);
    }
  }


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

  // ─── 切换标签 ───
  window._tbTab = function(tab) {
    state.currentTab = tab;
    render();
  };

  // ─── 弹窗 ───
  window._tbOpen = async function(type, itemId, itemName, icon) {
    currentAction = { type: type, itemId: itemId, itemName: itemName, icon: icon };

    var title = $('#modal-title');
    var target = $('#modal-target');
    var confirm = $('#modal-confirm');
    var overlay = $('#modal-overlay');

    if (type === 'prank') {
      if (itemId === 'unplug') {
        title.textContent = icon + ' 悄咪咪按下关机键';
        confirm.className = 'modal-btn danger';
        confirm.textContent = '关机！';
      } else if (itemId === 'brainrot') {
        title.textContent = icon + ' ' + itemName;
        confirm.className = 'modal-btn danger';
        confirm.textContent = '搞事！';
      }
    } else if (type === 'gift') {
      title.textContent = icon + ' 送 ' + itemName;
      confirm.className = 'modal-btn confirm';
      confirm.textContent = '送出';
    } else {
      title.textContent = icon + ' ' + itemName;
      confirm.className = 'modal-btn confirm';
      confirm.textContent = '发送';
    }

    var targetHtml = '';
    for (var i = 0; i < state.partners.length; i++) {
      targetHtml += '<option value="' + escapeHtml(state.partners[i].id) + '">' + escapeHtml(state.partners[i].name) + '</option>';
    }
    target.innerHTML = targetHtml;

    overlay.classList.add('show');
  };

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


  window._tbClose = function() {
    $('#modal-overlay').classList.remove('show');
    currentAction = null;
  };

  window._tbConfirm = async function() {
    if (!currentAction) return;

    var target = $('#modal-target').value;
    if (!target) {
      toast('请选择助手', 'error');
      return;
    }

    try {
      // 恶作剧需要等待，用持久 toast 显示进度
      if (currentAction.type === 'prank' && currentAction.itemId === 'unplug') {
        showPersistentToast('⏳ 正在关机...');
      } else if (currentAction.type === 'prank' && currentAction.itemId === 'brainrot') {
        showPersistentToast('⏳ 正在想说什么怪话...');
      }
      var data = await api('/api/visit', {
        method: 'POST',
        body: JSON.stringify({
          type: currentAction.type,
          itemId: currentAction.itemId,
          to: target,
        }),
      });

      if (data.success) {
        state.jar = data.jar;
        if (currentAction.type === 'prank') {
          if (currentAction.itemId === 'unplug') {
            updatePersistentToast('🔌 已经关机啦！');
            setTimeout(clearPersistentToast, 3000);
          } else if (currentAction.itemId === 'brainrot') {
            if (data.injected) {
              clearPersistentToast();
              toast('🧠 怪话已送达！');
              // 强制刷新对话框视图，让用户看到注入的怪话
              try {
                if (window.parent && window.parent !== window) {
                  window.parent.postMessage({ type: 'interject', text: '' }, '*');
                  window.parent.postMessage({
                    protocol: 'hana.plugin.ui', version: 1,
                    kind: 'request', type: 'session.refresh',
                  }, '*');
                }
              } catch (e) {}
              setTimeout(clearPersistentToast, 2000);
            } else if (data.brainrot) {
              // 注入失败，显示文本让用户看到
              clearPersistentToast();
              toast('🧠 ' + data.brainrot);
            } else {
              clearPersistentToast();
            }
          } else {
            clearPersistentToast();
          }
        } else if (currentAction.type === 'gift') {
          clearPersistentToast();
          toast(currentAction.icon + ' 已送出');
        } else {
          clearPersistentToast();
          toast(currentAction.icon + ' 已发送');
        }
        window._tbClose();
        render();
      } else {
        clearPersistentToast();
        toast(data.error || '操作失败', 'error');
      }
    } catch (e) {
      clearPersistentToast();
      toast('网络错误', 'error');
    }
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
      // 第一次点击时创建弹窗
      var div = document.createElement('div');
      div.className = 'modal-overlay';
      div.id = 'notes-overlay';
      div.innerHTML = '<div class="modal notes-modal">' +
        '<div class="notes-modal-header">' +
        '<h3>📝 小纸条</h3>' +
        '<button class="modal-close" onclick="document.getElementById(\'notes-overlay\').classList.remove(\'show\')">✕</button>' +
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
    // 标记已读，隐藏引导
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

        var color = g.color || '#999';
        var initial = g.name.charAt(0);

        // 助手折叠卡片
        html += '<div class="notes-group">';
        html += '<div class="notes-group-header" onclick="window._tbToggleGroup(this)">';
        html += '<div class="notes-group-avatar" style="background:' + color + '">' + escapeHtml(initial) + '</div>';
        html += '<span class="notes-group-name">' + escapeHtml(g.name) + '</span>';
        html += '<span class="notes-group-count">' + notes.length + ' 条</span>';
        html += '<span class="notes-group-arrow">▶</span>';
        html += '</div>';
        html += '<div class="notes-group-body">';

        for (var j = 0; j < notes.length; j++) {
          var n = notes[j];
          var dateStr = n.createdAt ? timeAgo(n.createdAt) : '';
          var triggerLabel = n.triggerType === 'gift' ? '🎁 礼物' : '💬 互动';
          var itemLabel = n.itemName || '';

          html += '<div class="notes-item">';
          html += '<div class="notes-item-bar" style="background:' + color + '"></div>';
          html += '<div class="notes-item-body">';
          html += '<div class="notes-meta">';
          html += '<span class="notes-meta-tag">' + triggerLabel + '</span>';
          if (itemLabel) html += escapeHtml(itemLabel);
          html += '<span class="notes-meta-time">' + dateStr + '</span>';
          html += '</div>';
          html += '<div class="notes-content">' + escapeHtml(n.content) + '</div>';
          html += '</div>';
          html += '</div>';
        }
        html += '</div>';
        html += '</div>';
      }

      list.innerHTML = html || '<div class="notes-empty"><div class="notes-empty-icon">💌</div>还没有小纸条 ✨</div>';
    } catch (e) {
      console.error('[闲不住] 加载小纸条失败:', e);
    }
  }

  window._tbUninstall = async function() {
    try {
      var data = await api('/api/uninstall', { method: 'POST' });
      if (data.success) {
        toast('✅ 清理完成，请关闭 Hana 并手动删除插件目录');
      } else {
        toast('❌ 清理失败：' + (data.error || '未知错误'), 'error');
      }
    } catch (e) {
      toast('❌ 网络错误：' + (e.message || '未知'), 'error');
    }
  }

  // ─── 插话：把文本填入主对话框并触发发送 ───
  function injectIntoDialog(text) {
    if (window.parent && window.parent !== window) {
      // 方法1：postMessage 协议（Hana 插件标准通信）
      try {
        window.parent.postMessage({
          protocol: 'hana.plugin.ui', version: 1,
          kind: 'request', type: 'interject',
          text: text,
        }, '*');
      } catch (e) {
        console.error('[闲不住] 协议 postMessage 失败:', e);
      }
      // 方法1b：简洁格式的 interject 消息
      try {
        window.parent.postMessage({ type: 'interject', text: text }, '*');
      } catch (e) {
        console.error('[闲不住] 简洁 postMessage 失败:', e);
      }
    }

    // 方法2：尝试直接访问父窗口 DOM（同源时可用）
    try {
      var doc = window.parent ? window.parent.document : document;
      if (doc) {
        var editor = doc.querySelector('.ProseMirror');
        if (editor) {
          editor.innerHTML = '';
          var p = doc.createElement('p');
          p.textContent = text;
          editor.appendChild(p);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(function() {
            var sendBtn = doc.querySelector('button[class*="send" i], button[class*="interject" i], [data-testid="send"]');
            if (!sendBtn) {
              var allBtns = doc.querySelectorAll('button');
              for (var i = 0; i < allBtns.length; i++) {
                var btn = allBtns[i];
                if (btn.textContent.includes('发送') || btn.textContent.includes('插话') || btn.textContent.includes('Send') || btn.textContent.includes('Steer')) {
                  sendBtn = btn;
                  break;
                }
              }
            }
            if (sendBtn) sendBtn.click();
          }, 100);
          return;
        }
      }
    } catch (e) {
      console.error('[闲不住] DOM 注入失败:', e);
    }

    // 方法3：注入失败，展示文本让用户手动复制
    toast('🧠 没自动插进去，怪话内容：' + text, 'error');
  }

  // ─── 检查更新 ───
  window._tbCheckUpdate = async function() {
    var resultEl = document.getElementById('update-result');
    if (resultEl) resultEl.innerHTML = '<span style="color:#888">↻ 正在检查更新...</span>';
    try {
      var data = await api('/api/check-update');
      if (!data.success) {
        if (resultEl) resultEl.innerHTML = '<span style="color:#e74c3c">❌ ' + (data.error || '检查失败') + '</span>';
        return;
      }
      if (!data.hasUpdate) {
        if (resultEl) resultEl.innerHTML = '✅ ' + data.message;
        return;
      }
      // 有更新：显示更新卡片
      var html = '<div style="margin-top:12px;padding:12px;background:var(--card);border-radius:8px;border:1px solid var(--border);font-size:13px">';
      html += '<div style="font-weight:600;margin-bottom:8px">🎉 ' + data.message + '</div>';
      if (data.releaseBody) {
        // 简单渲染 release body（GitHub markdown 转纯文本）
        var body = data.releaseBody
          .replace(/^###?\s+(.+)/gm, '<strong>$1</strong>')
          .replace(/^-\s+(.+)/gm, '· $1')
          .replace(/\n\n/g, '<br><br>')
          .replace(/\n/g, '<br>');
        html += '<div style="color:var(--text-secondary);max-height:200px;overflow-y:auto;margin-bottom:10px;line-height:1.6">' + body + '</div>';
      }
      html += '<div style="display:flex;gap:8px">';
      html += '<a href="' + data.downloadUrl + '" class="llm-save" style="display:inline-block;text-decoration:none;padding:6px 14px;font-size:13px;background:var(--accent);color:#fff;border-radius:6px">⬇ 下载更新</a>';
      html += '<a href="' + data.updateUrl + '" target="_blank" class="llm-save" style="display:inline-block;text-decoration:none;padding:6px 14px;font-size:13px;background:var(--accent-soft);color:var(--text);border-radius:6px">查看详情 →</a>';
      html += '</div></div>';
      if (resultEl) resultEl.innerHTML = html;
    } catch (e) {
      if (resultEl) resultEl.innerHTML = '<span style="color:#e74c3c">网络错误</span>';
      console.error('[闲不住] 检查更新:', e);
    }
  };

  // ─── 启动 ───
  // ─── 折叠小纸条 ───
  window._tbToggleGroup = function(header) {
    var group = header.parentElement;
    group.classList.toggle('open');
    var arrow = header.querySelector('.notes-group-arrow');
    if (arrow) arrow.textContent = group.classList.contains('open') ? '▼' : '▶';
  };

  loadData();

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'ready' }, '*');
    window.parent.postMessage({
      protocol: 'hana.plugin.ui', version: 1,
      kind: 'event', type: 'hana.ready',
    }, '*');
  }
})();