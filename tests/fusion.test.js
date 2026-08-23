import test from "node:test";
import assert from "node:assert/strict";

import {
  FUSION_HOLD_MS,
  FUSION_OVERLAP_RATIO,
  FUSION_STATUS_BUS_TOPIC,
  fusionStartPosition,
  initFusionCoordinator,
  intersectionArea,
  isFusionStartBlocked,
  overlapEnough,
  spreadPositions,
  stopFusionCoordinator,
} from "../lib/fusion.js";
import { setFenglingFusionActive, startFengling } from "../lib/fengling.js";

const fengling = { x: 100, y: 100, width: 108, height: 108 };
const jiegehua = { x: 154, y: 100, width: 80, height: 80 };

test("融合重叠面积按较小窗口计算", () => {
  assert.equal(intersectionArea(fengling, jiegehua), 54 * 80);
  assert.equal(overlapEnough(fengling, jiegehua, FUSION_OVERLAP_RATIO), true);
  assert.equal(overlapEnough(fengling, { ...jiegehua, x: 181 }, FUSION_OVERLAP_RATIO), false);
});

test("融合球启动位置取两个旧球中心的中点", () => {
  assert.deepEqual(fusionStartPosition(fengling, jiegehua), { x: 130, y: 103 });
});

test("状态机默认驻留门槛明确且不是零", () => {
  assert.equal(FUSION_HOLD_MS, 1800);
  assert.ok(FUSION_OVERLAP_RATIO > 0 && FUSION_OVERLAP_RATIO <= 1);
});

test("融合状态桥在融合/切换/恢复期间阻止外部原版启动", () => {
  assert.equal(isFusionStartBlocked("separate"), false);
  assert.equal(isFusionStartBlocked("error"), false);
  assert.equal(isFusionStartBlocked("transitioning"), true);
  assert.equal(isFusionStartBlocked("fused"), true);
  assert.equal(isFusionStartBlocked("restoring"), true);
});

test("风铃原版启动入口在融合标志开启时不重复拉起进程", () => {
  setFenglingFusionActive(true);
  try {
    const result = startFengling();
    assert.deepEqual(result, { ok: true, message: "融合球已在运行", fusion: true });
  } finally {
    setFenglingFusionActive(false);
  }
});

test("融合状态桥在协调器轮询前注册，停止时注销", async () => {
  const handlers = new Map();
  let unregistered = 0;
  const ctx = {
    bus: {
      handle(topic, handler) {
        handlers.set(topic, handler);
        return () => { unregistered += 1; };
      },
    },
  };
  const state = initFusionCoordinator(ctx);
  assert.equal(state.blocking, false);
  assert.ok(handlers.has(FUSION_STATUS_BUS_TOPIC));
  assert.equal(handlers.get(FUSION_STATUS_BUS_TOPIC)({ action: "status" }).blocking, false);
  await stopFusionCoordinator();
  assert.equal(unregistered, 1);
});

test("恢复两球时若重叠则沿连线拉开到不重叠", () => {
  const fenglingNear = { x: 130, y: 100, width: 108, height: 108 };
  const jiegehuaNear = { x: 154, y: 100, width: 80, height: 80 };
  const { first, second } = spreadPositions(fenglingNear, jiegehuaNear);
  assert.equal(overlapEnough(first, second), false);
  const a = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  const b = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= 110 - 1e-9);
});

test("两球本来就分开时不移动位置", () => {
  const f = { x: 100, y: 100, width: 108, height: 108 };
  const j = { x: 300, y: 100, width: 80, height: 80 };
  const r = spreadPositions(f, j);
  assert.deepEqual(r.first, f);
  assert.deepEqual(r.second, j);
});

test("完全重合时水平拉开，不除零不崩溃", () => {
  const f = { x: 100, y: 100, width: 108, height: 108 };
  const j = { x: 114, y: 114, width: 80, height: 80 }; // 与 f 同中心 (154,154)
  const { first, second } = spreadPositions(f, j);
  assert.equal(overlapEnough(first, second), false);
});
