// lib/actions.js — 闲不住核心互动动作（送礼/互动/恶作剧）
// 由 routes/api.js 与本地代理（lib/fengling.js）共用，
// 保证「页面操作」和「悬浮球操作」走完全一致的业务逻辑。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadData,
  saveData,
  nextId,
  nowISO,
  findLatestSessionPath,
  withDataLock,
} from "./data.js";
import { isValidAgentId } from "./validate.js";
import {
  processVisitEvent,
  generateBrainrot,
  generateCrashReply,
} from "./llm.js";
import { getUserDisplayName } from "./activity.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

// 数据写锁统一由 lib/data.js 提供（与 API 层共用同一把锁，避免双锁分家），
// 此处 re-export 保持原有调用方（routes/api.js）的 import 路径不变。
export { withDataLock };

// ─── 通过 session-manifest.db 将最新会话文件解析为 sess_xxx ID ───
async function findLatestSessionId(agentId) {
  try {
    const latestPath = findLatestSessionPath(agentId);
    if (!latestPath) return "";

    // 方案1：从最新会话文件内容里提取 sess id（零依赖，不依赖 sqlite3 CLI）
    try {
      const content = fs.readFileSync(latestPath, "utf-8");
      const m = content.match(/sess_[a-z0-9]+_[a-f0-9]+/);
      if (m) return m[0];
    } catch (e) {
      console.error("[闲不住] 读取最新会话失败:", e?.message || e);
    }

    // 方案2：从 session-titles.json 取最新的 sess_xxx（兜底）
    const titlesPath = path.join(
      HANA_HOME,
      "agents",
      agentId,
      "sessions",
      "session-titles.json",
    );
    if (fs.existsSync(titlesPath)) {
      try {
        const raw = fs.readFileSync(titlesPath, "utf-8");
        const titles = JSON.parse(raw);
        let latestSess = "";
        for (const key of Object.keys(titles)) {
          if (key.startsWith("sess_") && key > latestSess) {
            latestSess = key;
          }
        }
        if (latestSess) return latestSess;
      } catch (e) {
        console.error("[闲不住] session-titles 解析失败:", e?.message || e);
      }
    }

    return "";
  } catch (e) {
    console.error("[闲不住] 解析 sess_xxx ID 失败:", e?.message || e);
    return "";
  }
}

// ─── 推送消息到目标助手的对话框（失败重试：助手流式输出时 session:send 会抛 session_busy） ───
export async function pushToAgent(agentId, text, bus) {
  if (!bus) {
    console.warn("[闲不住] 推送失败: bus 不可用");
    return false;
  }
  const sessionId = await findLatestSessionId(agentId);
  if (!sessionId) {
    console.warn(`[闲不住] 推送失败: 未找到 ${agentId} 的会话 ID`);
    return false;
  }

  // 会话忙（流式输出中）时等待重试：2s / 5s / 10s，最多 3 次；非忙碌错误不重试
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      await bus.request("session:send", { text, sessionId });
      console.log(
        `[闲不住] 推送成功 → ${agentId} 会话 ${sessionId.slice(0, 20)}...`,
      );
      return true;
    } catch (e) {
      const msg = e?.message || String(e);
      const busy = /busy/i.test(msg);
      if (!busy || attempt >= delays.length) {
        console.error(
          `[闲不住] 推送失败${busy ? `（会话忙，重试 ${delays.length} 次后仍失败）` : "（非忙碌错误）"}:`,
          msg,
        );
        return false;
      }
      const delay = delays[attempt];
      console.log(
        `[闲不住] 会话忙，${delay / 1000}s 后重试 (${attempt + 1}/${delays.length})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── 弹幕模板（好感 x 心情双维度） ───
const DANMU_TEMPLATES = {
  gift: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["超开心！", "好耶！", "太棒了~今天运气不错！"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["收到了，有心了", "放在桌角了~"],
    },
    { minAffection: 0, minMood: 60, texts: ["谢、谢谢", "哇……谢谢"] },
    { minAffection: 0, minMood: 0, texts: ["嗯", "……收到了"] },
  ],
  quiet: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["你安静地待了一会儿……我居然觉得挺安心的", "不用说话也舒服~"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["你在这里……", "安静地待了一会儿"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["……有人在不说话", "沉默了但还好"],
    },
    { minAffection: 0, minMood: 0, texts: ["……", "……"] },
  ],
  hum: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["你哼的歌我听到了~挺好听的！", "哼着哼着心情好起来了"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["听到你哼歌了", "你刚才哼的那句我记住了"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["你在哼歌啊……", "调子还挺好听的"],
    },
    { minAffection: 0, minMood: 0, texts: ["……嗯", "……"] },
  ],
  doodle: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["这张便签我收起来了~画得好可爱！", "手绘小卡片太棒了！"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["收到你的小卡片了", "画得挺用心"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["啊，是小卡片……谢谢", "第一次收到手绘卡片"],
    },
    { minAffection: 0, minMood: 0, texts: ["……收下了", "嗯"] },
  ],
  fan: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["风好舒服！你真好！", "凉快多了~"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["谢谢你的风", "凉快了"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["哇，有风……", "谢谢你"],
    },
    { minAffection: 0, minMood: 0, texts: ["……嗯", "……"] },
  ],
  blanket: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["毯子好暖……你总是这么细心", "谢谢！"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["毯子……收到了", "谢谢"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["咦，毯子……", "……谢谢你"],
    },
    { minAffection: 0, minMood: 0, texts: ["……", "……"] },
  ],
  pillow: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["靠枕拍得好舒服！", "你还会照顾人"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["靠枕……谢了", "舒服点了"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["啊，靠枕……", "谢谢"],
    },
    { minAffection: 0, minMood: 0, texts: ["……嗯"] },
  ],
  unplug: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["哎？刚才我话说到哪儿了……诶，你按关机键了？！"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["……你按了关机键吧。我记住你了。"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["啊！！我的思路！被你按掉了！"],
    },
    { minAffection: 0, minMood: 0, texts: ["……呵。"] },
  ],
  brainrot: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["你刚才说什么？！我的脑回路打结了！"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["这句话……我可能需要缓一缓。"],
    },
    {
      minAffection: 0,
      minMood: 60,
      texts: ["啊？？？等、等等，我理一下……"],
    },
    { minAffection: 0, minMood: 0, texts: ["……你赢了。"] },
  ],
  recharge: [
    {
      minAffection: 51,
      minMood: 60,
      texts: ["满血复活！有你真好！", "能量回来了！"],
    },
    {
      minAffection: 51,
      minMood: 0,
      texts: ["充电完成，谢谢", "体力恢复了"],
    },
    { minAffection: 0, minMood: 60, texts: ["充、充电……谢谢", "能量回来了"] },
    { minAffection: 0, minMood: 0, texts: ["……嗯"] },
  ],
};

// ─── 生成弹幕文本（好感 x 心情双维度） ───
function generateBarrageText(type, itemId, itemName, icon, vars) {
  const mood = vars?.mood ?? 60;
  const affection = vars?.affection ?? 0;
  const templateKey =
    type === "gift" ? "gift" : type === "recharge" ? "recharge" : itemId;
  const levels = DANMU_TEMPLATES[templateKey];
  if (!levels) return "";
  let chosen = "";
  for (const level of levels) {
    const affOk =
      level.minAffection === undefined || affection >= level.minAffection;
    const moodOk = level.minMood === undefined || mood >= level.minMood;
    if (affOk && moodOk) {
      chosen = level.texts[Math.floor(Math.random() * level.texts.length)];
      break;
    }
  }
  if (!chosen) return "";
  if (type === "gift") {
    return "" + (icon || "") + itemName + "~" + chosen;
  }
  return chosen;
}

// ─── 发弹幕到在干嘛（静默失败，不影响主流程） ───
export async function sendBarrage(agentId, type, itemId, itemName, icon) {
  try {
    let buddyName = "";
    let buddyColor = "";
    try {
      const cfgPath = path.join(HANA_HOME, "data", "zaiganma", "config.json");
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, "utf-8");
        const zCfg = JSON.parse(raw);
        const buddy = zCfg.buddies?.[agentId];
        if (buddy) {
          buddyName = buddy.name || "";
          buddyColor = buddy.color || "";
        }
      }
    } catch (eCfg) {}
    const d = loadData();
    const vars = d.partnerConfig?.[agentId]?.variables;
    const content = generateBarrageText(type, itemId, itemName, icon, vars);
    if (!content) return;
    const text = buddyName ? buddyName + "：" + content : content;
    const resp = await fetch("http://127.0.0.1:18900/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        buddy_color: buddyColor || undefined,
        framed: true,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log("[闲不住] 弹幕发送成功:", text.slice(0, 30));
    }
  } catch (e) {
    console.log(
      "[闲不住] 弹幕发送跳过（在干嘛不可用）:",
      e?.message?.slice(0, 50) || "unknown",
    );
  }
}

// ─── 核心动作：送礼 / 互动 / 恶作剧（与页面 /api/visit 完全一致） ───
// 返回 { status, body }，由调用方（HTTP 路由 / 本地代理）转成响应。
export async function performVisit(input, deps = {}) {
  const bus = deps.bus;
  return withDataLock(async () => {
    let data = loadData();

    const { type, itemId, to } = input;

    if (!type || !itemId || !to) {
      return { status: 400, body: { success: false, error: "缺少必要参数" } };
    }

    // 助手 ID 白名单（防路径穿越 / 原型污染）：与装饰等接口同一套校验
    if (!isValidAgentId(to)) {
      return { status: 400, body: { success: false, error: "无效的助手 ID" } };
    }
    if (!data.partnerConfig?.[to]) {
      return { status: 400, body: { success: false, error: "助手不存在" } };
    }

    // 输入校验：type 白名单 + 长度限制
    const validTypes = ["interact", "gift", "prank"];
    if (!validTypes.includes(type)) {
      return { status: 400, body: { success: false, error: "无效的互动类型" } };
    }
    if (
      typeof itemId !== "string" ||
      itemId.length > 50 ||
      typeof to !== "string" ||
      to.length > 100
    ) {
      return { status: 400, body: { success: false, error: "参数格式错误" } };
    }

    let item;
    if (type === "interact") {
      item = (data.interactItems || []).find((i) => i.id === itemId);
    } else if (type === "prank") {
      item = (data.prankItems || []).find((i) => i.id === itemId);
    } else if (type === "gift") {
      item = (data.shopItems || []).find((i) => i.id === itemId);
    }

    if (!item) return { status: 400, body: { success: false, error: "项目不存在" } };

    // ── 恶作剧前置处理 ──
    if (type === "prank" && itemId === "brainrot") {
      // 扣光粒（先内存扣减，落盘在合并写盘时统一做）
      const prankCost = 3;
      if ((data.jar || 0) < prankCost) {
        return { status: 400, body: { success: false, error: "光粒不够了 ✨" } };
      }

      // 生成怪话（锁内限时 10s：LLM 挂起时不把数据写锁拖到默认 30s，避免写接口排队过久）
      const brainrotText = await generateBrainrot({ timeout: 10000 });
      if (!brainrotText) {
        return { status: 500, body: { success: false, error: "怪话生成失败" } };
      }

      // 推送
      const ok = await pushToAgent(to, brainrotText, bus);

      // 创建 visit 记录并异步修改变量
      // 合并写盘：await 期间锁外写者（GET 统计/工具状态）可能已提交新数据，
      // 用锁内开头旧快照整体覆盖会丢它们的更新，必须基于最新快照重新合并再落盘
      const fresh = loadData();
      fresh.jar = (fresh.jar || 0) - prankCost;
      if (!fresh.pendingVisits) fresh.pendingVisits = [];
      const visit = {
        id: nextId(),
        type,
        itemId: item.id,
        itemName: item.name,
        icon: item.icon,
        price: 0,
        to,
        from: "owner",
        createdAt: nowISO(),
        status: "completed",
      };
      fresh.pendingVisits.push(visit);
      if (!saveData(fresh)) {
        return {
          status: 500,
          body: { success: false, error: "数据保存失败，请重试" },
        };
      }

      processVisitEvent(visit, to).catch((err) => {
        console.error("[闲不住] 脑洞袭击变量更新失败:", err?.message || err);
      });

      sendBarrage(to, "prank", "brainrot", "说怪话", "");

      if (!ok) {
        return {
          status: 200,
          body: {
            success: true,
            jar: fresh.jar,
            brainrot: brainrotText,
            injected: false,
          },
        };
      }
      return {
        status: 200,
        body: { success: true, jar: fresh.jar, injected: true },
      };
    }

    // ── 检查模型是否已配置（恶作剧豁免：关机键/说怪话不依赖插件模型） ──
    const llmOk = !!(data.llmConfig?.providerId && data.llmConfig?.modelId);
    if (!llmOk && type !== "prank") {
      return {
        status: 400,
        body: {
          success: false,
          error: "请先打开闲不住页面底部「模型设置」配置模型后再使用",
        },
      };
    }

    // ── 光粒变动 ──
    if (type === "gift") {
      if ((data.jar || 0) < item.price) {
        return { status: 400, body: { success: false, error: "光粒不够了 ✨" } };
      }
      data.jar -= item.price;
      data.jar += 3; // 送礼回礼：助手回赠 3 光粒，让送礼不亏太多
    } else if (type === "prank") {
      const prankCost = itemId === "unplug" ? 5 : 3;
      if ((data.jar || 0) < prankCost) {
        return { status: 400, body: { success: false, error: "光粒不够了 ✨" } };
      }
      data.jar -= prankCost;
    }

    // ── 创建 visit 记录（存但不推 pendingVisits，用于变量修改和小纸条） ──
    const visit = {
      id: nextId(),
      type,
      itemId: item.id,
      itemName: item.name,
      icon: item.icon,
      price: item.price || 0,
      to,
      from: "owner",
      createdAt: nowISO(),
      status: "pushed",
    };

    if (type === "prank" && itemId === "unplug") {
      // 关机键：生成崩溃剧本（锁内限时 10s）→ 存 pendingVisit → abort → 推送「重启！」──
      const crashReply = await generateCrashReply(to, undefined, 10000);
      if (crashReply) {
        visit.autoReply = crashReply;
        console.log("[闲不住] 崩溃剧本已生成，长度：" + crashReply.length);
      }
      // 合并写盘：await 期间锁外写者可能已提交新数据，基于最新快照追加（通用段的光粒
      // 扣减只在内存快照上做过、未落盘，这里重新从磁盘快照扣），避免旧快照覆盖丢更新
      const fresh = loadData();
      fresh.jar = (fresh.jar || 0) - (itemId === "unplug" ? 5 : 3);
      if (!fresh.pendingVisits) fresh.pendingVisits = [];
      visit.status = "pending";
      fresh.pendingVisits.push(visit);
      if (!saveData(fresh)) {
        return {
          status: 500,
          body: { success: false, error: "数据保存失败，请重试" },
        };
      }
      data = fresh; // 后续响应与流程基于最新快照

      // 弹幕在 abort 之前发送，避免 abort 中断后续请求
      sendBarrage(to, "prank", "unplug", "关机键", "");

      try {
        const latestSession = findLatestSessionPath(to);
        if (bus && latestSession) {
          await bus.request("session:abort", {
            sessionPath: latestSession,
            reason: "悄咪咪按了关机键 🔌",
          });
          console.log("[闲不住] abort 完成 → " + to);
          await bus.request("session:send", {
            text: "重启！",
            sessionPath: latestSession,
          });
          console.log("[闲不住] 关机键「重启！」注入成功 → " + to);
        }
      } catch (e) {
        console.error("[闲不住] 关机键处理失败:", e?.message || e);
      }
      // 异步修改变量+小纸条（统一在下方 processVisitEvent 处理，避免重复调用）
    } else {
      // ── 互动 / 礼物：存为 completed（展板不显示，check-visits 可查具体内容） ──
      visit.status = "completed";
      if (!data.pendingVisits) data.pendingVisits = [];
      data.pendingVisits.push(visit);
      if (!saveData(data)) {
        return {
          status: 500,
          body: { success: false, error: "数据保存失败，请重试" },
        };
      }

      // 推送统一通知：带上礼物/互动名，助手一眼可知内容，可再调 check-visits 读细节
      const _n = getUserDisplayName();
      const _pushVariants =
        type === "gift"
          ? [
              `📦 收到来自${_n}的一份礼物：${item.icon || ""}${item.name}～`,
              `🎁 ${_n}给你带了东西：${item.icon || ""}${item.name}～`,
            ]
          : [
              `📬 收到来自${_n}的一条互动：${item.icon || ""}${item.name}～`,
              `📬 ${_n}拍了拍你：${item.icon || ""}${item.name}～`,
            ];
      let pushText =
        _pushVariants[Math.floor(Math.random() * _pushVariants.length)];

      pushToAgent(to, pushText, bus).catch((err) => {
        console.error("[闲不住] 互动/礼物推送失败:", err?.message || err);
      });

      sendBarrage(to, type, itemId, item.name, item.icon);
    }

    // ── 异步修改变量 + 生成小纸条 ──
    processVisitEvent(visit, to).catch((err) => {
      console.error("[闲不住] 异步处理事件失败:", err?.message || err);
    });

    return {
      status: 200,
      body: {
        success: true,
        visitId: visit.id,
        jar: data.jar,
        item: { id: item.id, icon: item.icon, name: item.name, type },
      },
    };
  });
}
