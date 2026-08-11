// routes/visits.js — 展板与互动域路由
// /api/data（展板数据）、/api/visit（互动/礼物/恶作剧）、/api/update-narrative、/api/current-agent、/api/mark-read

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadData,
  saveData,
  getToday,
  todayStr,
  calcLightParticles,
  calcWorkConsumption,
  syncWorkDeduction,
  randomIdle,
  isRechargedToday,
  randomTip,
  withDataLock,
  findMostActiveAgentId,
} from "../lib/data.js";
import {
  scanTodayActivity,
  getUserDisplayName,
  scanWorkStats,
} from "../lib/activity.js";
import {
  getPartnerConfig,
  getPartnerIds,
} from "../lib/config.js";
import { performVisit } from "../lib/actions.js";
import { isValidAgentId } from "../lib/validate.js";
import { readBody, json } from "./_helpers.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export function registerVisits(app, ctx) {
  const bus = ctx.bus || ctx._bus;

  // ════════════════════════════════════════
  //  GET /api/data — 展板数据
  // ════════════════════════════════════════
  app.get("/api/data", (c) => {
    const data = loadData();
    const today = getToday(data);
    const ts = todayStr();

    const activity = scanTodayActivity(data);
    const partnerConfig = getPartnerConfig(data);
    const userName = getUserDisplayName();

    // ── 扫描今日会话，统计每个助手的 effortLP ──
    // 统一走 scanWorkStats（带 1 分钟缓存），与工作消耗统计同口径
    const partnerIds = getPartnerIds(data);
    const workStats = scanWorkStats(data);
    let workDeductedAny = false;
    for (const agentId of partnerIds) {
      const stats = workStats[agentId] || {
        toolCalls: 0,
        charsOutput: 0,
        fileOps: 0,
        subagentDispatches: 0,
      };
      const effortLP = calcLightParticles(stats);
      if (!today.partners[agentId]) {
        today.partners[agentId] = {
          contributed: false,
          narrative: "",
          effortLP: 0,
        };
      }
      today.partners[agentId].effortLP = effortLP;
      // 实时扣减工作消耗（与事件触发补扣同口径，只扣新增差额）
      // 这样聊一天打开展板就能看到精力实时在掉，不用等互动或次日重置
      if (syncWorkDeduction(data, agentId, calcWorkConsumption(stats))) {
        workDeductedAny = true;
      }
    }

    // ── 计算总 effortLP ──
    let totalEffort = 0;
    for (const p of Object.values(today.partners)) {
      totalEffort += p.effortLP || 0;
    }
    const prevTotalEffort = today.totalEffortLP;
    today.totalEffortLP = totalEffort;
    today.totalLP = today.baseLP + totalEffort;
    // 统计结果变化时才写盘（前端轮询时避免每 GET 都 saveData）
    // ⚠️ GET 全程同步无 await（load 与 save 之间没有异步点），单线程下是原子段，无需加锁。
    //    若未来把 scanWorkStats 变异步，这两处写盘必须包 withDataLock。
    if (today.totalEffortLP !== prevTotalEffort || workDeductedAny) {
      saveData(data);
    }

    const todayTotal = today.totalLP;
    const todayClaimed = today.claimed || 0;
    const newAvailable = Math.max(0, todayTotal - todayClaimed);

    const partners = [];
    let decoMigrated = false;
    for (const [id, info] of Object.entries(partnerConfig)) {
      if (info.hidden) continue; // 用户隐藏的伙伴不在展板显示
      const p = today.partners[id];
      const act = activity[id] || {};
      let active = !!p?.contributed;
      let doing = "";

      if (act.dispatched) {
        active = true;
        const byName =
          partnerConfig[act.dispatchedBy]?.name || act.dispatchedBy;
        doing = `被 ${byName} 派去做 ${act.dispatched}`;
      } else if (act.title) {
        active = true;
        doing = `正在和 ${userName} 讨论 ${act.title}`;
      } else if (p?.narrative) {
        active = true;
        doing = p.narrative;
      }

      if (!doing) {
        active = false;
        doing = randomIdle(data.idlePool || []);
      }

      // 检查是否有真实头像
      const avatarPath = path.join(
        HANA_HOME,
        "agents",
        id,
        "avatars",
        "agent.png",
      );
      const hasAvatar = fs.existsSync(avatarPath);

      // 装饰数据迁移（兼容旧格式 → 新格式）
      var deco = info.decorations;
      if (deco && !deco.owned) {
        // 旧格式: { avatarFrame: 'id', cardBg: null, title: null }
        var newDeco = {
          owned: { avatarFrame: [], cardBg: [], title: [] },
          equipped: { avatarFrame: null, cardBg: null, title: null },
        };
        if (deco.avatarFrame) {
          newDeco.owned.avatarFrame.push(deco.avatarFrame);
          newDeco.equipped.avatarFrame = deco.avatarFrame;
        }
        if (deco.cardBg) {
          newDeco.owned.cardBg.push(deco.cardBg);
          newDeco.equipped.cardBg = deco.cardBg;
        }
        if (deco.title) {
          newDeco.owned.title.push(deco.title);
          newDeco.equipped.title = deco.title;
        }
        info.decorations = newDeco;
        deco = newDeco;
        decoMigrated = true;
      }

      partners.push({
        id,
        name: info.name,
        color: info.color,
        active,
        doing,
        avatarUrl: hasAvatar ? `/api/avatar/${id}` : "",
        variables: info.variables || null,
        decorations: deco || {
          owned: { avatarFrame: [], cardBg: [], title: [] },
          equipped: { avatarFrame: null, cardBg: null, title: null },
        },
        recharged: isRechargedToday(data, id),
      });
    }

    const activeList = partners.filter((p) => p.active);
    const idleList = partners.filter((p) => !p.active);
    let sectionTitle = "";
    const a = activeList.length,
      i = idleList.length;

    if (a === 0) {
      const pool = [
        "大家好像都在摸鱼",
        "摸鱼时间到 ✨",
        "全员待机中",
        "安静得有点不习惯",
        "今天好像都很闲",
      ];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else if (i === 0) {
      const pool = [
        "全员都在认真干活 💪",
        "忙碌的一天",
        "大家都在努力中",
        "没有一个人在偷懒",
      ];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else if (a === 1) {
      const pool = [
        `${activeList[0].name}在忙，其他人摸鱼中`,
        `只有${activeList[0].name}在干活`,
        `${activeList[0].name}好忙啊`,
      ];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else if (a === 2) {
      const pool = [
        `${activeList[0].name}和${activeList[1].name}在忙`,
        "有人在忙有人在摸鱼",
      ];
      sectionTitle = pool[Math.floor(Math.random() * pool.length)];
    } else {
      sectionTitle = `大家都在各忙各的${i > 0 ? `，只有${idleList.map((p) => p.name).join("和")}在摸鱼` : ""}`;
    }

    // 装饰迁移发生时才会写盘（平时 GET 不写盘）
    if (decoMigrated) {
      saveData(data);
    }
    // 是否有小纸条（控制小纸条按钮是否显示）
    const hasNotes = Object.values(data.notes || {}).some(
      (arr) => arr && arr.length > 0,
    );

    // 是否有未读小纸条（自上次阅读后的新纸条）
    const lastReadTs = data.lastReadNotesTs || 0;
    const hasNewNotes =
      hasNotes &&
      Object.values(data.notes || {}).some(
        (arr) =>
          arr &&
          arr.some((n) => {
            const createdAt = n.createdAt ? new Date(n.createdAt).getTime() : 0;
            return createdAt > lastReadTs;
          }),
      );

    // 首次引导：从未打开过纸条弹窗 + 有新纸条
    const showNoteGuide = hasNewNotes && !data.lastReadNotesTs;

    return json({
      jar: data.jar,
      todayTotal,
      todayClaimed,
      newAvailable,
      version: ctx.pluginVersion || "",
      tip: randomTip(),
      sectionTitle,
      partners,
      hasNotes,
      hasNewNotes,
      showNoteGuide,
      pendingPartners: [
        ...new Set(
          (data.pendingVisits || [])
            .filter((v) => v.status === "pending")
            .map((v) => v.to),
        ),
      ],
      pendingDetails: (data.pendingVisits || [])
        .filter((v) => v.status === "pending")
        .map((v) => ({
          id: v.id,
          to: v.to,
          type: v.type,
          itemId: v.itemId,
          itemName: v.itemName,
          icon: v.icon,
          createdAt: v.createdAt,
        })),
      shopItems: data.shopItems || [],
      interactItems: data.interactItems || [],
      prankItems: data.prankItems || [],
      decorationItems: data.decorationItems || [],
    });
  });

  // ════════════════════════════════════════
  //  POST /api/visit — 互动 / 礼物 / 恶作剧（推送模式）
  //  不再依赖 pendingVisits + check-visits，直接推送到助手对话框
  // ════════════════════════════════════════
  app.post("/api/visit", async (c) => {
    const input = await readBody(c);
    const result = await performVisit(input, { bus });
    return json(result.body, result.status);
  });

  // ════════════════════════════════════════
  //  POST /api/update-narrative — 更新状态
  // ════════════════════════════════════════
  app.post("/api/update-narrative", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      const today = getToday(data);
      const pid = input.partner || "hanako";

      // 输入校验
      if (typeof pid !== "string" || pid.length > 100) {
        return json({ success: false, error: "参数错误" }, 400);
      }
      if (!isValidAgentId(pid)) {
        return json({ success: false, error: "无效的助手 ID" }, 400);
      }
      const narrative =
        typeof input.narrative === "string" ? input.narrative.slice(0, 200) : "";

      if (!today.partners[pid]) {
        today.partners[pid] = { contributed: false, narrative: "", effortLP: 0 };
      }
      today.partners[pid].narrative = narrative;
      today.partners[pid].contributed = true;
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      return json({
        success: true,
        partner: pid,
        narrative: today.partners[pid].narrative,
      });
    });
  });

  // ════════════════════════════════════════
  //  GET /api/current-agent — 获取当前正在对话的 agent
  //  v0.4 新增：让闲不住能自动选中"你正在聊的那个"
  // ════════════════════════════════════════
  app.get("/api/current-agent", async (c) => {
    try {
      const partnerIds = getPartnerIds(loadData());
      const agentId = findMostActiveAgentId(partnerIds);
      return json({ success: true, agentId });
    } catch (e) {
      console.error("[闲不住] 获取当前 agent 失败:", e?.message || e);
      return json({ success: false, error: e?.message || "查询失败" });
    }
  });

  // ════════════════════════════════════════
  //  POST /api/mark-read — 标记已读（推送模式已无待处理事件）
  // ════════════════════════════════════════
  app.post("/api/mark-read", async (c) => {
    return json({ success: true });
  });
}
