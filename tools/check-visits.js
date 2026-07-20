// 闲不住 — check-visits 工具
// 检查是否有来自用户的闲不住互动或事件待处理
// 主要用于关机键崩溃演出：收到「重启！」指令时优先调用此工具

import { loadData, saveData, getAffectionStage } from '../lib/data.js';
import { getUserDisplayName } from '../lib/activity.js';

export const name = "check-visits";
export const description = "检查是否有来自用户的闲不住互动或待回复事件。当收到「重启！」指令时请先调用此工具查看。";

export const parameters = {
  type: "object",
  properties: {
    markReadAll: { type: "boolean", description: "标记全部已读" }
  }
};

export async function execute(args, ctx = {}) {
  try {
    const data = loadData();

    const currentAgent = ctx.agentId || ctx.agent?.id || ctx.session?.agentId || '';

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
        if (v.type === 'prank' && v.itemId === 'unplug' && v.autoReply.length > 60) {
          entry._isCrashScript = true;
          // 崩溃剧本读取后自动标记已读，不留在展板待处理提示中
          v.status = 'received';
          saveData(data);
        }
      }
      return entry;
    });

    if (visits.length === 0) {
      // 没有 pending 时，检查最近一条 completed 的互动/礼物（供助手了解具体内容）
      const recentCompleted = (data.pendingVisits || [])
        .filter(v => v.status === 'completed' && (!currentAgent || v.to === currentAgent))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 3);

      if (recentCompleted.length > 0) {
        const userName = getUserDisplayName() || '用户';
        const recentList = recentCompleted.map(rc => ({
          icon: rc.icon,
          itemName: rc.itemName,
          type: rc.type,
          itemId: rc.itemId,
          createdAt: rc.createdAt,
        }));

        // 附上当前状态
        let moodPart = '';
        if (currentAgent) {
          const vars = data.partnerConfig?.[currentAgent]?.variables;
          if (vars) {
            const stage = getAffectionStage(vars.affection);
            const energyL = vars.energy >= 70 ? '精力充沛' : vars.energy >= 40 ? '还行' : vars.energy >= 20 ? '有点累' : '累坏了';
            const moodL = vars.mood >= 76 ? '心情很好' : vars.mood >= 51 ? '心情平稳' : vars.mood >= 26 ? '不太好' : '心情很差';
            moodPart = ` (精力${vars.energy} ${energyL}，心情${vars.mood} ${moodL}，${stage.emoji} ${stage.label})`;
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ visits: recentList, _recent: true, _mood: moodPart })
          }]
        };
      }

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

    const userName = getUserDisplayName() || '用户';
    let prefix = `\u26A0\uFE0F 有来自 ${userName} 的未处理事件：\n\n`;
    const visitList = visits.map(v => {
      let line = `${v.icon || '\uD83D\uDCE9'} ${v.itemName}`;
      if (v._isCrashScript) {
        prefix = `\u26A0\uFE0F 用户 ${userName} 按了关机键！你必须立即回应这个事件。\n\n你的回复**必须以下面提供的「回复正文」作为开头**，从第一个字开始使用，不得省略任何部分。先完整写出回复正文的内容，然后就结束了——**不要强行续写**之前的话题，除非你自然地还有话要说。\n\n`;
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
