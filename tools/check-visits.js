// 闲不住 — check-visits 工具
// 检查是否有来自用户的闲不住互动或礼物

import { loadData, saveData, getAffectionStage } from '../lib/data.js';
import { getUserDisplayName } from '../lib/activity.js';

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
      if (v.autoReply) {
        entry.autoReply = v.autoReply;
        // 标记是否为崩溃表演剧本（较长文本）
        if (v.type === 'prank' && v.itemId === 'unplug' && v.autoReply.length > 60) {
          entry._isCrashScript = true;
        }
      }
      return entry;
    });

    if (visits.length === 0) {
      // 没有 visit 时也返回当前助手的变量状态
      let emptyMood = '';
      if (currentAgent) {
        const vars = data.partnerConfig?.[currentAgent]?.variables;
        if (vars) {
          const stage = getAffectionStage(vars.affection);
          const energyL = vars.energy >= 70 ? '精力充沛' : vars.energy >= 40 ? '还行' : vars.energy >= 20 ? '有点累' : '累坏了';
          const moodL = vars.mood >= 76 ? '心情很好' : vars.mood >= 51 ? '心情平稳' : vars.mood >= 26 ? '不太好' : '心情很差';
          emptyMood = ` (精力${vars.energy} ${energyL}，心情${vars.mood} ${moodL}，${stage.emoji} ${stage.label})`;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ visits: [], _mood: emptyMood }) }] };
    }

    // 构建当前助手的变量状态描述
    let moodContext = '';
    if (currentAgent) {
      const vars = data.partnerConfig?.[currentAgent]?.variables;
      if (vars) {
        const stage = getAffectionStage(vars.affection);
        const energyL = vars.energy >= 70 ? '精力充沛' : vars.energy >= 40 ? '还行' : vars.energy >= 20 ? '有点累' : '累坏了';
        const moodL = vars.mood >= 76 ? '心情很好' : vars.mood >= 51 ? '心情平稳' : vars.mood >= 26 ? '不太好' : '心情很差';
        moodContext = `\n\n你的当前状态：精力 ${vars.energy}/100（${energyL}），心情 ${vars.mood}/100（${moodL}），${stage.emoji} ${stage.label}`;
      }
    }

    // 有 visit 时，前头带强约束指令，让模型无法忽略
    const userName = getUserDisplayName() || '用户';
    let prefix = `\u26A0\uFE0F 有来自 ${userName} 的未处理互动！你必须先逐一回应以下互动内容，再继续其他话题：\n\n`;
    const visitList = visits.map(v => {
      let line = `${v.icon || '\uD83D\uDCE9'} ${v.itemName}`;
      if (v._isCrashScript) {
        // 关机崩溃剧本：直接指定回复内容，要求必须严格使用
        prefix = `\u26A0\uFE0F 用户 ${userName} 按了关机键！你必须立即回应这个事件，然后再继续其他话题。\n\n你的回复**必须以下面提供的「回复正文」作为开头**，从第一个字开始使用，不得省略任何部分。先完整写出回复正文的内容，然后就结束了——**不要强行续写**之前的话题，除非你自然地还有话要说。\n\n`;
        line += `\n  \u25B6\uFE0F 回复正文（请完整使用）：${v.autoReply}`;
      } else if (v.autoReply) {
        line += `\n  回应参考：${v.autoReply}`;
      }
      return line;
    }).join('\n---\n');

    return {
      content: [{
        type: 'text',
        text: prefix + visitList + moodContext
      }]
    };
  } catch (e) {
    console.error('[闲不住] check-visits 出错:', e?.message || e);
    return { content: [{ type: 'text', text: JSON.stringify({ visits: [], error: e?.message || 'unknown' }) }] };
  }
}
