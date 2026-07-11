// 闲不住 — update-status 工具
// 更新我在闲不住展板上的状态文字

import { loadData, saveData, todayStr } from '../lib/data.js';

export const name = "update-status";
export const description = "更新我在闲不住展板上的状态文字。参数：narrative=状态文字（如\"在陪用户写插件 📝\"），partner=伙伴id（可选，默认hanako）。";

export const parameters = {
  type: "object",
  properties: {
    narrative: { type: "string", description: "状态文字，描述当前在做什么" },
    partner: { type: "string", description: "伙伴id，不传则默认hanako" }
  }
};

export async function execute(args, ctx = {}) {
  try {
    const data = loadData();
    const ts = todayStr();

    if (!data.days) data.days = {};
    if (!data.days[ts]) {
      data.days[ts] = { date: ts, partners: {}, baseLP: 100, totalLP: 100, claimed: 0 };
    }
    const pid = (args && args.partner) || 'hanako';
    if (!data.days[ts].partners[pid]) {
      data.days[ts].partners[pid] = { contributed: false, narrative: '', effortLP: 0 };
    }
    data.days[ts].partners[pid].narrative = args?.narrative || '';
    data.days[ts].partners[pid].contributed = true;
    saveData(data);

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, partner: pid, narrative: args?.narrative || '' }) }]
    };
  } catch (e) {
    console.error('[闲不住] update-status 出错:', e?.message || e);
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e?.message || 'unknown' }) }] };
  }
}