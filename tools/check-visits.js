// 闲不住 — check-visits 工具
// 检查是否有来自用户的闲不住互动或礼物

import { loadData, saveData } from '../lib/data.js';

export const name = "check-visits";
export const description = "【每次回复前必须调用】检查是否有来自用户的闲不住互动或礼物。先不带参数调用查看 visits 内容，逐一回应后，再用 markReadAll=true 标记已读。不要直接带 markReadAll 跳过查看步骤。";

export const parameters = {
  type: "object",
  properties: {
    markReadAll: { type: "boolean", description: "标记全部已读" }
  }
};

export async function execute(args, ctx = {}) {
  try {
    const data = loadData();

    // 从上下文获取当前助手的 agent ID
    const currentAgent = ctx.agentId || ctx.agent?.id || ctx.session?.agentId || '';

    // 只返回当前助手的 pending visit，避免跨助手误吞
    const pending = (data.pendingVisits || [])
      .filter(v => v.status === 'pending')
      .filter(v => !currentAgent || v.to === currentAgent);

    if (args?.markReadAll) {
      let count = 0;
      const marked = [];
      for (const v of data.pendingVisits || []) {
        if (v.status === 'pending' && (!currentAgent || v.to === currentAgent)) {
          v.status = 'received';
          marked.push({
            id: v.id, type: v.type, icon: v.icon || '',
            itemName: v.itemName, to: v.to,
            createdAt: v.createdAt,
          });
          count++;
        }
      }
      saveData(data);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, marked: count, visits: marked }) }] };
    }

    const visits = pending.map(v => {
      const entry = {
        id: v.id,
        type: v.type,
        icon: v.icon || '',
        itemName: v.itemName,
        to: v.to,
        createdAt: v.createdAt,
      };
      // 闲不住已算好回应文本时才带上，模型只需自然地融入
      // 如果为空说明还在处理中（时序竞争），模型正常发挥即可
      if (v.autoReply) {
        entry.autoReply = v.autoReply;
      }
      return entry;
    });

    if (visits.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ visits: [] }) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ visits })
      }]
    };
  } catch (e) {
    console.error('[闲不住] check-visits 出错:', e?.message || e);
    return { content: [{ type: 'text', text: JSON.stringify({ visits: [], error: e?.message || 'unknown' }) }] };
  }
}