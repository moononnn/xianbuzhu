// 闲不住 — check-visits 工具
// 检查是否有来自用户的闲不住互动或事件待处理
// 主要用于关机键崩溃演出：收到「重启！」指令时优先调用此工具

import { loadData, saveData, buildMoodContext } from '../lib/data.js';
import { getUserDisplayName } from '../lib/activity.js';

export const name = "check-visits";
export const description = "当收到「重启！」这两个字时，必须立即调用此工具——会有演出剧本需要读取并作为回复开头。也用于检查来自用户的闲不住互动、礼物或待回复事件。当对话中出现「带了东西」「送了你」「礼物」「拍一拍」「闲不住」等互动提示时，调用本工具读取具体内容。";

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

        // 附上当前状态（模糊描述，不给硬数值）
        let moodPart = '';
        if (currentAgent) {
          const vars = data.partnerConfig?.[currentAgent]?.variables;
          if (vars) {
            moodPart = ` (${buildMoodContext(vars)})`;
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
          emptyMood = ` (${buildMoodContext(vars)})`;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ visits: [], _mood: emptyMood }) }] };
    }

    let moodContext = '';
    if (currentAgent) {
      const vars = data.partnerConfig?.[currentAgent]?.variables;
      if (vars) {
        moodContext = `\n\n你的当前状态：${buildMoodContext(vars)}`;
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
