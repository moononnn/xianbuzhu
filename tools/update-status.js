// 闲不住 — update-status 工具
// 更新我在闲不住展板上的状态文字

import { loadData, saveData, todayStr } from "../lib/data.js";
import { isValidAgentId } from "../lib/validate.js";

export const name = "update-status";
export const description =
  '更新我在闲不住展板上的状态文字。参数：narrative=状态文字（如"在陪用户写插件 📝"），partner=伙伴id（可选，不传则默认写自己）。';

export const parameters = {
  type: "object",
  properties: {
    narrative: { type: "string", description: "状态文字，描述当前在做什么" },
    partner: { type: "string", description: "伙伴id，不传则默认hanako" },
  },
};

export async function execute(args, ctx = {}) {
  try {
    const data = loadData();
    const ts = todayStr();

    if (!data.days) data.days = {};
    if (!data.days[ts]) {
      data.days[ts] = {
        date: ts,
        partners: {},
        baseLP: 100,
        totalLP: 100,
        claimed: 0,
      };
    }
    // 默认写自己（调用方 agent），而不是写死 'hanako'（通用设计：其他用户默认 agent 不叫 hanako）
    // 与接口层同一校验规则：非法 partner（__proto__/路径分隔符等）回退到调用方自己，
    // 防止实例级原型污染与规则分叉
    const rawPid = typeof args?.partner === "string" ? args.partner : "";
    const pid =
      rawPid && isValidAgentId(rawPid)
        ? rawPid
        : ctx.agentId || ctx.agent?.id || ctx.session?.agentId || "hanako";
    if (!data.days[ts].partners[pid]) {
      data.days[ts].partners[pid] = {
        contributed: false,
        narrative: "",
        effortLP: 0,
      };
    }
    const narrative =
      typeof args?.narrative === "string" ? args.narrative.slice(0, 200) : "";
    data.days[ts].partners[pid].narrative = narrative;
    data.days[ts].partners[pid].contributed = true;
    saveData(data);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, partner: pid, narrative }),
        },
      ],
    };
  } catch (e) {
    console.error("[闲不住] update-status 出错:", e?.message || e);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: e?.message || "unknown",
          }),
        },
      ],
    };
  }
}
