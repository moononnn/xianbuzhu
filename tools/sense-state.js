// 闲不住 — sense-state 工具
// 轻量工具：让助手感受自己当下的好感和心情状态
// 在新对话开始时调用，助手能够自然内化当前的情绪基调

import { loadData, getAffectionStage, getCurrentStatus } from "../lib/data.js";
import { getUserDisplayName } from "../lib/activity.js";

export const name = "sense-state";
export const description =
  "感受自己当下的心情和身体状态。当你觉得这是一个全新开始的对话窗口、想找到今天说话的基调时，可以调用这个工具来了解自己当前的状态是轻盈还是沉静的，也会告诉你当前挂着的伙伴状态。它会返回自然的状态描述。";

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute(args, ctx = {}) {
  try {
    const data = loadData();
    const currentAgent =
      ctx.agentId || ctx.agent?.id || ctx.session?.agentId || "";

    if (!currentAgent) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "周围有些模糊，说不清自己现在是什么感觉。",
            }),
          },
        ],
      };
    }

    const currentStatus = getCurrentStatus(data, currentAgent);
    const partnerCfg = data.partnerConfig?.[currentAgent];
    if (!partnerCfg?.variables) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "今天没什么特别的感觉，和平时一样平静。",
              currentStatus,
            }),
          },
        ],
      };
    }

    const vars = partnerCfg.variables;
    const stage = getAffectionStage(vars.affection);
    const userName = getUserDisplayName() || "对方";

    // 心境描述
    let moodDesc = "";
    if (vars.mood >= 80) moodDesc = "心里很轻快";
    else if (vars.mood >= 65) moodDesc = "心情还不错，平稳中带点暖意";
    else if (vars.mood >= 40) moodDesc = "说不上特别好，但也还行";
    else if (vars.mood >= 25) moodDesc = "有点闷，不太想多说话";
    else moodDesc = "心情不太好，感觉沉沉的";

    // 体力描述
    let energyDesc = "";
    if (vars.energy >= 70) energyDesc = "精神挺好的";
    else if (vars.energy >= 40) energyDesc = "不算太累";
    else if (vars.energy >= 20) energyDesc = "有一点疲惫感";
    else energyDesc = "有点累了，想歇一歇";

    // 好感描述（自然语言）
    let affectionDesc = "";
    if (vars.affection >= 81) {
      affectionDesc = `见到${userName}就会觉得安心，不需要刻意找话说的那种自在。`;
    } else if (vars.affection >= 51) {
      affectionDesc = `心里是愿意亲近的，见到${userName}就会放松一些。`;
    } else if (vars.affection >= 21) {
      affectionDesc = `还在慢慢熟悉中，不过不排斥${userName}的靠近。`;
    } else if (vars.affection >= 0) {
      affectionDesc = `对${userName}还不算太了解，有些距离感。`;
    } else {
      affectionDesc = `目前不太想靠近${userName}。`;
    }

    // 综合状态描述
    let stateDesc = `${moodDesc}，${energyDesc}。`;

    // 根据心情 + 好感的组合生成更细腻的体感
    if (vars.mood >= 65 && vars.affection >= 51) {
      stateDesc += ` 今天见到${userName}，心里那种自在感是真的。`;
    } else if (vars.mood < 40 && vars.affection >= 51) {
      stateDesc += ` 虽然没什么精神，但有${userName}在旁边的话还不算太糟。`;
    } else if (vars.mood >= 65 && vars.affection < 30) {
      stateDesc += ` 今天心情还行，跟${userName}的关系还早，不着急。`;
    } else if (vars.mood < 40 && vars.affection < 30) {
      stateDesc += ` 今天不太想说话，${userName}最好也别靠太近。`;
    }

    // 心情的来由（事件驱动，给 agent 一个可以顺势演绎的方向，但保留自主权）
    if (vars.moodReason) {
      stateDesc += ` 心情的来由：${vars.moodReason}，具体怎么表现由你自己把握。`;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            // 零数字：不给原始数值（mood/affection/energy），只给关系阶段 + 自然语言状态
            stage: `${stage.emoji} ${stage.label}`,
            state: stateDesc,
            currentStatus,
          }),
        },
      ],
    };
  } catch (e) {
    console.error("[闲不住] sense-state 出错:", e?.message || e);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ state: "脑袋有点乱，说不清现在是什么感觉……" }),
        },
      ],
    };
  }
}
