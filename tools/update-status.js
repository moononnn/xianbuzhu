// 闲不住 — update-status 工具
// 更新我在闲不住展板上的状态文字

import {
  loadData,
  saveData,
  todayStr,
  getToday,
  getCurrentStatus,
  setPartnerStatus,
} from "../lib/data.js";
import { getPartnerConfig } from "../lib/config.js";

export const name = "update-status";
export const description =
  '只给伙伴表达自己的展板状态使用；用户端不能通过闲不住页面、接口或本工具替伙伴手动换状态。自动状态由闲不住后台单独判断，主对话无需主动调用此工具；伙伴确实想表达时才写自己。可传 statusId 选择公共/专属状态，也可传 status 自己配一条收入专属状态架。narrative 仍可用来描述正在做什么。参数：partner=伙伴 id（旧版 narrative 可选目标；状态只能写自己），duration 可选 today/hour/four_hours/until_changed。';

export const parameters = {
  type: "object",
  properties: {
    clear: { type: "boolean", description: "是否清除当前挂着的状态" },
    statusId: { type: "string", description: "已有状态 ID；优先从状态衣柜里选择" },
    status: { type: "string", description: "要自己配的短状态，最多 40 字，会收进自己的专属状态架" },
    icon: { type: "string", description: "状态图标，默认为 ✨" },
    category: { type: "string", description: "状态类别：日常/心情/做事/陪伴/整活" },
    trigger: { type: "string", enum: ["conversation", "event", "mood", "energy", "routine", "agent", "activity", "idle"], description: "可选，更新缘由；不传也可以" },
    duration: { type: "string", enum: ["today", "hour", "four_hours", "until_changed"], description: "保持多久，默认今天" },
    narrative: { type: "string", description: "兼容旧版：正在做什么的一句话" },
    partner: { type: "string", description: "伙伴 id，不传则默认写自己" },
  },
};

export async function execute(args, ctx = {}) {
  try {
    const data = loadData();
    const ts = todayStr();
    if (!data.days) data.days = {};
    if (!data.days[ts]) getToday(data);

    // 默认写自己（调用方 agent），而不是写死 hanako。
    const actorId = ctx.agentId || ctx.agent?.id || ctx.session?.agentId || "hanako";
    const pid =
      typeof args?.partner === "string" && args.partner.length <= 100
        ? args.partner
        : actorId;
    const hasStatus = Boolean(
      (typeof args?.statusId === "string" && args.statusId.trim())
      || (typeof args?.status === "string" && args.status.trim()),
    );
    const statusRequested = hasStatus || args?.clear === true;
    if (statusRequested && pid !== actorId) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "伙伴只能给自己配或切换状态" }) }] };
    }
    if (statusRequested) {
      const partnerConfig = getPartnerConfig(data);
      const partnerCfg = partnerConfig[pid];
      if (!partnerCfg || partnerCfg.hidden) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "这位伙伴当前不在闲不住列表里" }) }] };
      }
    }
    let current = null;
    let statusContext = null;
    if (statusRequested) {
      const result = setPartnerStatus(data, pid, {
        statusId: args.statusId,
        text: args.status,
        icon: args.icon,
        category: args.category,
        duration: args.duration,
        clear: args.clear === true,
        source: "partner",
        trigger: args.trigger || "agent",
      });
      if (!result.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: result.error,
              status: result.current || null,
              statusContext: result.statusContext || null,
            }),
          }],
        };
      }
      current = result.current;
      statusContext = result.statusContext || null;
    }

    const narrativeProvided = typeof args?.narrative === "string";
    const today = getToday(data);
    if (narrativeProvided || !statusRequested) {
      if (!today.partners[pid]) {
        today.partners[pid] = { contributed: false, narrative: "", effortLP: 0 };
      }
      today.partners[pid].narrative = narrativeProvided ? args.narrative.slice(0, 200) : "";
      today.partners[pid].contributed = true;
    }
    if (!saveData(data)) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "状态保存失败，请重试" }) }] };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          partner: pid,
          narrative: today.partners[pid]?.narrative || "",
          status: current || getCurrentStatus(data, pid),
          statusContext,
        }),
      }],
    };
  } catch (e) {
    console.error("[闲不住] update-status 出错:", e?.message || e);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: e?.message || "unknown" }) }],
    };
  }
}
