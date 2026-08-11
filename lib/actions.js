// lib/actions.js — 闲不住核心互动动作（送礼/互动/恶作剧）
// 由 routes/api.js 与本地代理（lib/fengling.js）共用，
// 保证「页面操作」和「悬浮球操作」走完全一致的业务逻辑。

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

// 弹幕模板与发送已拆到 lib/barrage.js，此处 import 供 performVisit 内部调用，
// 并 re-export 保持既有调用方 import 路径不变
import { sendBarrage } from "./barrage.js";
export { sendBarrage };

// 数据写锁统一由 lib/data.js 提供（与 API 层共用同一把锁，避免双锁分家），
// 此处 re-export 保持原有调用方（routes/api.js）的 import 路径不变。
export { withDataLock };

// ─── 推送目标为什么直接用 sessionPath（文件路径）而不是 sess_xxx ID ───
// 之前先 findLatestSessionPath 拿到桌面会话文件，再从文件内容里正则提取
// 第一个 sess_xxx 作为 sessionId 传给 Hana。两个隐患：
// 1) 桌面会话 JSONL 内容里可能先出现 subagent 直连会话的 sess_xxx
//    （委派记录等），命中后推送目标变成 subagent 会话路径，被 Hana 拒绝
//    （必须位于 agents/{id}/sessions/*.jsonl），且 session:send 只回 accepted
//    不回投递结果，失败被静默吞掉 → 界面显示「已送达」助手却毫无反应；
// 2) 正则提取脆弱，格式变化即失效。
// Hana 的 session:send / session:abort 都接受 sessionPath（关机键一直
// 这么传且正常），所以这里直接传文件路径，绕开全部解析环节。

// ─── 锁内总线请求统一超时 ───
// 数据写锁内出现的任何 bus.request（session:send / session:abort）都必须有超时兜底：
// Hana 主进程对会话请求不响应时（流式输出卡住/会话文件异常等），请求会无限挂起，
// 把数据写锁永久占住——之后所有写操作（送礼/互动/领光粒/配置）排队卡死，
// 这就是「一次送礼/怪话后，大部分操作没反应，重启才恢复」的根因。
const BUS_REQUEST_TIMEOUT_MS = 8000;
const PUSH_TOTAL_TIMEOUT_MS = 20000;

// 给任意 Promise 加超时：超时后 reject；输家仍在后台跑，但调用方保证被包裹的
// 请求自身也有超时（不会无限残留）。
export function withTimeout(promise, ms, label = "请求") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}超时（${ms}ms）`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─── 推送消息到目标助手的对话框（失败重试：助手流式输出时 session:send 会抛 session_busy） ───
// timeoutMs：总超时兜底（默认 20s，测试可注入小值），超时视为推送失败（返回 false），不无限等、不抛错。
// busRequestTimeoutMs：单次 session:send 超时（默认 8s），测试可注入小值避免后台残留拖长进程。
export async function pushToAgent(
  agentId,
  text,
  bus,
  timeoutMs = PUSH_TOTAL_TIMEOUT_MS,
  busRequestTimeoutMs = BUS_REQUEST_TIMEOUT_MS,
) {
  try {
    return await withTimeout(
      pushToAgentInner(agentId, text, bus, busRequestTimeoutMs),
      timeoutMs,
      "推送",
    );
  } catch (e) {
    console.error(
      `[闲不住] 推送超时放弃（${timeoutMs}ms）: ${agentId}`,
      e?.message || e,
    );
    return false;
  }
}

async function pushToAgentInner(agentId, text, bus, busRequestTimeoutMs) {
  if (!bus) {
    console.warn("[闲不住] 推送失败: bus 不可用");
    return false;
  }
  const sessionPath = findLatestSessionPath(agentId);
  if (!sessionPath) {
    console.warn(`[闲不住] 推送失败: 未找到 ${agentId} 的会话路径`);
    return false;
  }

  // 会话忙（流式输出中）时等待重试：2s / 5s / 10s，最多 3 次；非忙碌错误不重试。
  // 单次请求同样有超时：bus.request 挂起（非 busy）时直接放弃，不再重试。
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      await withTimeout(
        bus.request("session:send", { text, sessionPath }),
        busRequestTimeoutMs,
        "session:send",
      );
      console.log(
        `[闲不住] 推送成功 → ${agentId} 会话 ${path.basename(sessionPath)}`,
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

      // 推送（总超时兜底：推送挂起时不把数据写锁拖住）
      const ok = await pushToAgent(
        to,
        brainrotText,
        bus,
        deps.pushTimeoutMs,
        deps.busTimeoutMs,
      );

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
          const busTimeout = deps.busTimeoutMs ?? BUS_REQUEST_TIMEOUT_MS;
          await withTimeout(
            bus.request("session:abort", {
              sessionPath: latestSession,
              reason: "悄咪咪按了关机键 🔌",
            }),
            busTimeout,
            "session:abort",
          );
          console.log("[闲不住] abort 完成 → " + to);
          await withTimeout(
            bus.request("session:send", {
              text: "重启！",
              sessionPath: latestSession,
            }),
            busTimeout,
            "session:send",
          );
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

      pushToAgent(
        to,
        pushText,
        bus,
        deps.pushTimeoutMs,
        deps.busTimeoutMs,
      ).catch((err) => {
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
