// lib/barrage.js — 弹幕模板与发送（从原 actions.js 拆出）
// 职责：好感 x 心情双维度的弹幕文本生成 + 发送到「在干嘛」插件本地服务
// 依赖：data（变量读取）；发送失败静默，不影响主流程

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadData } from "./data.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

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
