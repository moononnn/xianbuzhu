// lib/events.js — 闲不住事件处理队列（从原 llm.js 拆出）
// 职责：visit 事件的串行队列编排（变量更新 → 回应生成 → 小纸条），30s 超时真取消
// 依赖：variables（数值规则）、responses（回应生成）、notes（小纸条）、providers（配置）、data、activity
// 这是原 llm.js 里"编排层"的归属地，也是各拆分文件的汇聚点

import {
  loadData,
  saveData,
  recordEvent,
  calcWorkConsumption,
  clampVariable,
  syncWorkDeduction,
} from "./data.js";
import { scanWorkStats, clearWorkStatsCache } from "./activity.js";
import { getLLMConfig } from "./providers.js";
import { generateReply } from "./responses.js";
import {
  generateAndSaveNote,
  shouldTriggerNote,
  isNoteOnCooldown,
} from "./notes.js";
import { applyVariableChanges, logVariableChange } from "./variables.js";

// Visit 级别处理锁（防止同一事件被异步重复处理）
const _processingVisits = new Set();

// ─── 串行队列：防止多个事件并发 load-modify-save 竞争丢更新 ───
// 单条处理最长 30s：超时不仅让外层 race 提前结束（Promise.race 本身不取消输掉的一方），
// 还通过 AbortController 真正中止内部 LLM 网络请求，避免「串行保证失效、旧任务继续在后台跑」。
let _visitQueue = Promise.resolve();
const VISIT_PROCESS_TIMEOUT = 30000;

export function processVisitEvent(visit, partnerId) {
  const run = _visitQueue.then(() => {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), VISIT_PROCESS_TIMEOUT);
    let rejectTimer;
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimer = setTimeout(
        () =>
          reject(
            new Error(
              `visit ${visit.id} 处理超时（${VISIT_PROCESS_TIMEOUT}ms）`,
            ),
          ),
        VISIT_PROCESS_TIMEOUT,
      );
    });
    return Promise.race([
      processVisitEventInternal(visit, partnerId, ac.signal).finally(() => {
        // 无论正常完成还是被 abort，两个 timer 都清理，避免僵尸定时器空转
        clearTimeout(abortTimer);
        clearTimeout(rejectTimer);
      }),
      timeoutPromise,
    ]);
  });
  _visitQueue = run.catch(() => {});
  return run;
}

// ⚠️ 队列路径的写盘（变量修改/autoReply/小纸条）依赖「load 与 save 之间无 await」的同步段原子性，
// 靠每次写前重新 loadData 保证基于最新快照。若未来在中间插入任何 await（如 scanWorkStats 变异步、
// 加日志 await），lost update 会复活——届时必须把写路径纳入 data.js 的 withDataLock。

async function processVisitEventInternal(visit, partnerId, signal) {
  // 竞态锁：防止同一 visit 被异步重复处理
  if (_processingVisits.has(visit.id)) {
    console.log(`[闲不住] visit ${visit.id} 正在处理中，跳过`);
    return;
  }
  _processingVisits.add(visit.id);

  try {
    const llmConfig = getLLMConfig();
    const llmOk = !!(llmConfig.providerId && llmConfig.modelId);
    if (!llmOk) {
      console.log("[闲不住] 模型未配置：跳过回应生成，变量更新照常执行");
    }

    console.log(`[闲不住] 开始处理事件: ${visit.type} → ${partnerId}`);

    // 0. 修改变量
    const data0 = loadData();
    const partnerCfg = data0.partnerConfig?.[partnerId];
    if (partnerCfg?.variables) {
      // 审计日志：必须在任何修改之前记录 before 快照
      const varsBeforeLog = { ...partnerCfg.variables };
      applyVariableChanges(partnerCfg.variables, visit);
      // 记录事件（供次日心情推演）
      recordEvent(data0, partnerId, {
        type: visit.type,
        itemId: visit.itemId || "",
        itemName: visit.itemName || "",
        price: visit.price || 0,
      });
      // 后面还有工作消耗的修改，等全部改完后再记日志
      // 计算并扣除工作消耗（只扣当天新增的部分）
      clearWorkStatsCache();
      const workStats = scanWorkStats(data0);
      const partnerStats = workStats[partnerId] || {};
      const workConsumption = calcWorkConsumption(partnerStats);
      const deducted = syncWorkDeduction(data0, partnerId, workConsumption);
      clampVariable(partnerCfg.variables);
      // 审计日志
      logVariableChange(partnerId, visit, varsBeforeLog, partnerCfg.variables);
      saveData(data0);
      console.log(
        `[闲不住] 变量更新: energy=${partnerCfg.variables.energy} mood=${partnerCfg.variables.mood} affection=${partnerCfg.variables.affection} (工作消耗: ${workConsumption}, 本次扣除: ${deducted})`,
      );
    }

    // 1. 生成回应（只在 push 模式（pending）时需要，completed 状态跳过以节省 LLM 开销）
    if (llmOk && visit.status === "pending") {
      const dataBefore = loadData();
      const existingVisit = dataBefore.pendingVisits?.find(
        (v) => v.id === visit.id,
      );
      if (!existingVisit?.autoReply) {
        const reply = await generateReply(visit, partnerId, signal);
        if (reply) {
          const data = loadData();
          const pendingVisit = data.pendingVisits?.find(
            (v) => v.id === visit.id,
          );
          if (pendingVisit && pendingVisit.status === "pending") {
            pendingVisit.autoReply = reply;
            saveData(data);
            console.log(`[闲不住] 已生成回应: ${visit.id}`);
          } else {
            console.log(`[闲不住] visit ${visit.id} 已被消费，跳过 autoReply`);
          }
        }
      } else {
        console.log(`[闲不住] visit ${visit.id} 已有 autoReply，跳过生成`);
      }
    }

    // 2. 判断是否触发小纸条（不依赖 pending 状态：互动/礼物是 completed 状态，
    //    小纸条逻辑必须在 pending 块之外，否则永远不触发）
    //    冷却：同一位助手 8 小时内最多一张，纸条要稀有
    if (llmOk && !isNoteOnCooldown(data0.notes?.[partnerId]) && shouldTriggerNote(visit)) {
      console.log(`[闲不住] 触发小纸条: ${partnerId}`);
      await generateAndSaveNote(visit, partnerId, signal);
    }

    console.log(`[闲不住] 事件处理完成: ${visit.id}`);
  } finally {
    _processingVisits.delete(visit.id);
  }
}
