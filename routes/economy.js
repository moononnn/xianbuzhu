// routes/economy.js — 经济与装饰域路由
// /api/claim、/api/recharge、装饰购买/装备/卸下、伙伴排序/隐藏/刷新

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadData,
  saveData,
  getToday,
  nowISO,
  isRechargedToday,
  markRechargedToday,
  recordEvent,
  getRechargeTip,
  withDataLock,
} from "../lib/data.js";
import { getUserDisplayName } from "../lib/activity.js";
import {
  getPartnerIds,
  scanPartners,
  mergeRefreshedPartners,
} from "../lib/config.js";
import {
  pushToAgent,
  sendBarrage,
} from "../lib/actions.js";
import { isValidAgentId } from "../lib/validate.js";
import { cancelHeartPlanForPartner } from "../lib/heartbeat.js";
import { encryptKey } from "../lib/providers.js";
import { readBody, json } from "./_helpers.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export function registerEconomy(app, ctx) {
  const bus = ctx.bus || ctx._bus;

  // ════════════════════════════════════════
  //  POST /api/claim — 领取光粒
  // ════════════════════════════════════════
  app.post("/api/claim", async (c) => {
    return withDataLock(async () => {
      const data = loadData();
      const today = getToday(data);

      let totalEffort = 0;
      for (const p of Object.values(today.partners))
        totalEffort += p.effortLP || 0;
      today.totalLP = today.baseLP + totalEffort;

      const claimed = today.claimed || 0;
      const toClaim = today.totalLP - claimed;
      if (toClaim <= 0)
        return json({
          success: true,
          jar: data.jar,
          claimed: 0,
          message: "今天没有新光粒可以收 ✨",
        });

      today.claimed = claimed + toClaim;
      data.jar += toClaim;
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      return json({ success: true, jar: data.jar, claimed: toClaim });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/recharge — 充电（消耗 50 光粒，体力回满）
  // ════════════════════════════════════════
  app.post("/api/recharge", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      const { to } = input;

      if (!to) return json({ success: false, error: "缺少助手 ID" }, 400);
      if (!isValidAgentId(to)) {
        return json({ success: false, error: "无效的助手 ID" }, 400);
      }

      // 检查今天是否已充过
      if (isRechargedToday(data, to)) {
        return json(
          { success: false, error: "今天已经充过啦 ⚡", alreadyRecharged: true },
          400,
        );
      }

      // 检查光粒
      const RECHARGE_COST = 50;
      if ((data.jar || 0) < RECHARGE_COST) {
        return json({ success: false, error: "光粒不够了 ✨" }, 400);
      }

      // 检查助手是否存在
      const partnerCfg = data.partnerConfig?.[to];
      if (!partnerCfg) return json({ success: false, error: "助手不存在" }, 400);

      // 扣光粒
      data.jar -= RECHARGE_COST;

      // 体力拉满
      partnerCfg.variables.energy = 100;

      // 标记今天已充
      markRechargedToday(data, to);

      // 记录事件（供次日心情推演）
      recordEvent(data, to, {
        type: "recharge",
        itemId: "recharge",
        itemName: "充电",
        price: 0,
      });

      // 生成充电提示
      const tip = getRechargeTip();

      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }

      // 推送统一充电通知到助手对话框
      const _chargeVariants = [
        `⚡ 收到来自${getUserDisplayName()}的充电～`,
        `⚡ ${getUserDisplayName()}给你充了电！`,
      ];
      pushToAgent(
        to,
        _chargeVariants[Math.floor(Math.random() * _chargeVariants.length)],
        bus,
      ).catch((err) => {
        console.error("[闲不住] 充电推送失败:", err?.message || err);
      });

      sendBarrage(to, "recharge", "recharge", "充电", "");

      return json({
        success: true,
        jar: data.jar,
        energy: 100,
        tip,
      });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/buy-decoration — 购买装饰
  // ════════════════════════════════════════
  app.post("/api/buy-decoration", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      const { decorationId, target, text } = input;

      if (!decorationId || !target) {
        return json({ success: false, error: "缺少参数" }, 400);
      }
      if (!isValidAgentId(target)) {
        return json({ success: false, error: "无效的助手 ID" }, 400);
      }

      const item = (data.decorationItems || []).find(
        (i) => i.id === decorationId,
      );
      if (!item) return json({ success: false, error: "装饰不存在" }, 400);

      if ((data.jar || 0) < item.price) {
        return json({ success: false, error: "光粒不够了 ✨" }, 400);
      }

      const partnerCfg = data.partnerConfig?.[target];
      if (!partnerCfg) return json({ success: false, error: "助手不存在" }, 400);

      // 初始化新格式装饰数据
      if (!partnerCfg.decorations || !partnerCfg.decorations.owned) {
        partnerCfg.decorations = {
          owned: { avatarFrame: [], cardBg: [], title: [] },
          equipped: { avatarFrame: null, cardBg: null, title: null },
        };
      }
      const deco = partnerCfg.decorations;

      if (item.type === "title") {
        // 称号：需要输入文字
        if (!text) return json({ success: false, error: "请输入称号文字" }, 400);
        if (typeof text !== "string" || text.length > 12)
          return json({ success: false, error: "称号文字限 12 字以内" }, 400);
        // 检查是否已拥有
        if (deco.owned.title.includes(text)) {
          return json({ success: false, error: "已拥有该称号" }, 400);
        }
        deco.owned.title.push(text);
        deco.equipped.title = text;
      } else if (item.type === "titleEdit") {
        // 改称号卡：必须先拥有至少一个称号
        if (deco.owned.title.length === 0) {
          return json({ success: false, error: "请先购买自定义称号" }, 400);
        }
        if (!text)
          return json({ success: false, error: "请输入新的称号文字" }, 400);
        if (typeof text !== "string" || text.length > 12)
          return json({ success: false, error: "称号文字限 12 字以内" }, 400);
        if (deco.owned.title.includes(text)) {
          return json({ success: false, error: "已拥有该称号" }, 400);
        }
        deco.owned.title.push(text);
        deco.equipped.title = text;
      } else {
        // 头像框/卡面：检查是否已拥有
        const typeKey = item.type; // 'avatarFrame' or 'cardBg'
        if (deco.owned[typeKey] && deco.owned[typeKey].includes(item.id)) {
          return json({ success: false, error: "已拥有该装饰" }, 400);
        }
        if (!deco.owned[typeKey]) deco.owned[typeKey] = [];
        deco.owned[typeKey].push(item.id);
        deco.equipped[typeKey] = item.id;
      }

      data.jar -= item.price;
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }

      console.log(`[闲不住] 装饰购买成功: ${item.name} → ${target}`);
      return json({ success: true, jar: data.jar, decorations: deco });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/equip-decoration — 切换装饰
  // ════════════════════════════════════════
  app.post("/api/equip-decoration", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      const { target, type, itemId } = input;

      if (!target || !type || !itemId) {
        return json({ success: false, error: "缺少参数" }, 400);
      }
      if (!isValidAgentId(target)) {
        return json({ success: false, error: "无效的助手 ID" }, 400);
      }

      const partnerCfg = data.partnerConfig?.[target];
      if (!partnerCfg) return json({ success: false, error: "助手不存在" }, 400);

      const deco = partnerCfg.decorations;
      if (!deco?.owned?.[type] || !deco.owned[type].includes(itemId)) {
        return json({ success: false, error: "未拥有该装饰" }, 400);
      }

      deco.equipped[type] = itemId;
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      return json({ success: true, decorations: deco });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/unequip-decoration — 卸下装饰
  // ════════════════════════════════════════
  app.post("/api/unequip-decoration", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      const { target, type } = input;

      if (!target || !type) {
        return json({ success: false, error: "缺少参数" }, 400);
      }
      if (!isValidAgentId(target)) {
        return json({ success: false, error: "无效的助手 ID" }, 400);
      }

      const partnerCfg = data.partnerConfig?.[target];
      if (!partnerCfg) return json({ success: false, error: "助手不存在" }, 400);

      const deco = partnerCfg.decorations;
      if (deco?.equipped) {
        deco.equipped[type] = null;
        if (!saveData(data)) {
          return json({ success: false, error: "数据保存失败，请重试" }, 500);
        }
      }
      return json({ success: true, decorations: deco });
    });
  });

  // ════════════════════════════════════════
  //  GET /api/partner-order — 读取用户自定义伙伴排序
  //  v0.4 新增：左侧伙伴墙可拖动排序，保存到 data.partnerOrder
  // ════════════════════════════════════════
  app.get("/api/partner-order", async (c) => {
    const data = loadData();
    return json({ success: true, order: data.partnerOrder || [] });
  });

  // ════════════════════════════════════════
  //  POST /api/partner-order — 保存伙伴排序
  // ════════════════════════════════════════
  app.post("/api/partner-order", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      if (!Array.isArray(input.order)) {
        return json({ success: false, error: "order 必须是数组" }, 400);
      }
      data.partnerOrder = input.order;
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      return json({ success: true });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/partner-hidden — 隐藏/显示伙伴（展板编辑）
  // ════════════════════════════════════════
  app.post("/api/partner-hidden", async (c) => {
    return withDataLock(async () => {
      const input = await readBody(c);
      const data = loadData();
      const { target, hidden } = input;

      if (!target) return json({ success: false, error: "缺少参数" }, 400);
      if (!isValidAgentId(target))
        return json({ success: false, error: "无效的助手 ID" }, 400);
      const cfg = data.partnerConfig?.[target];
      if (!cfg) return json({ success: false, error: "助手不存在" }, 400);

      cfg.hidden = !!hidden;
      if (cfg.hidden) cancelHeartPlanForPartner(data, target);
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      console.log(
        `[闲不住] 伙伴显示状态: ${target} → ${cfg.hidden ? "隐藏" : "显示"}`,
      );
      return json({ success: true });
    });
  });

  // ════════════════════════════════════════
  //  POST /api/refresh-partners — 刷新列表：重新扫描 agents，找回所有伙伴
  // ════════════════════════════════════════
  app.post("/api/refresh-partners", async (c) => {
    return withDataLock(async () => {
      const data = loadData();
      const scanned = scanPartners();
      data.partnerConfig = mergeRefreshedPartners(data.partnerConfig, scanned);
      if (!saveData(data)) {
        return json({ success: false, error: "数据保存失败，请重试" }, 500);
      }
      console.log(
        `[闲不住] 刷新伙伴列表，共 ${Object.keys(scanned).length} 个`,
      );
      return json({ success: true, count: Object.keys(scanned).length });
    });
  });
}
