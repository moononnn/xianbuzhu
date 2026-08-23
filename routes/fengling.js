// routes/fengling.js — 风铃悬浮球域路由
// /api/fengling/start、/api/fengling/stop、/api/fengling/status、/api/fengling/autoboot

import {
  startFengling,
  stopFengling,
  getFenglingState,
  checkFenglingDeps,
  consumeFenglingDismissed,
} from "../lib/fengling.js";
import { getFusionState, initFusionCoordinator, restoreSeparate } from "../lib/fusion.js";
import { json } from "./_helpers.js";

export function registerFengling(app, ctx) {
  const bus = ctx.bus || ctx._bus;
  initFusionCoordinator(ctx);

  // ════════════════════════════════════════
  //  风铃悬浮球 — 启动 / 停止 / 状态 / 依赖检查
  // ════════════════════════════════════════
  app.post("/api/fengling/start", async (c) => {
    const res = startFengling(bus);
    return json(res, res.ok ? 200 : 400);
  });
  app.post("/api/fengling/stop", async (c) => {
    const fusion = getFusionState();
    if (fusion.mode !== "separate") {
      // 融合态下"停止风铃"= 收起融合球、恢复两球；
      // 协调器保持存活（两球会被拉开不重叠，不会立刻又自动融合），下次拖到一起仍能再融合
      const res = await restoreSeparate("user");
      return json(res.ok ? { ...res, message: "融合球已收起，旧球已恢复" } : res, res.ok ? 200 : 500);
    }
    const res = await stopFengling();
    return json(res, res.ok ? 200 : 400);
  });
  app.get("/api/fengling/status", async (c) => {
    const st = getFenglingState();
    const deps = await checkFenglingDeps();
    return json({ ...st, ...deps });
  });
  // 风铃自动启动状态（消费式读取：dismissed 读一次即清除；Hana 重启内存重置）
  app.get("/api/fengling/autoboot", async (c) => {
    const st = getFenglingState();
    const dismissed = consumeFenglingDismissed();
    const deps = await checkFenglingDeps();
    return json({ ok: true, running: st.running, dismissed, pyQtOk: deps.pyQtOk });
  });
  app.get("/api/fengling/fusion/status", async (c) => {
    return json(getFusionState());
  });
}
