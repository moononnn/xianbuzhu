// lib/fusion.js — 闲不住协调的风铃 × 解语花融合状态机
//
// 闲不住只负责协调：读取两个悬浮球已经落盘的位置、判定重叠驻留、
// 保存旧球快照、启停融合进程；解语花业务仍由自己的本地代理负责。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getFenglingProxyInfo,
  getFenglingState,
  setFenglingFusionActive,
  setFusionHttpHandler,
  startFengling,
  stopFengling,
} from "./fengling.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const FENGLING_STATE_PATH = path.join(HANA_HOME, "data", "work-visit", "fengling-state.json");
const ZHUJIAN_STATE_PATH = path.join(HANA_HOME, "data", "jiegehua", "zhujian-state.json");
const FUSION_SCRIPT = path.join(__dirname, "..", "python", "fusion_ball.py");

export const FUSION_BUS_TOPIC = "jiegehua:fusion:v1";
export const FUSION_STATUS_BUS_TOPIC = "work-visit:fusion:v1";
export const FUSION_HOLD_MS = 1800;
export const FUSION_POLL_MS = 180;
export const FUSION_OVERLAP_RATIO = 0.5;
export const FENGLING_WINDOW = { width: 108, height: 108 };
export const ZHUJIAN_WINDOW = { width: 80, height: 80 };
export const FUSION_WINDOW = { width: 88, height: 88 };

export function isFusionStartBlocked(mode) {
  return mode === "transitioning" || mode === "fused" || mode === "restoring";
}

let context = null;
let bus = null;
let fusionStatusBus = null;
let fusionStatusUnregister = null;
let pollTimer = null;
let pollInFlight = false;
let fusionProcess = null;
let restorePromise = null;
let snapshotBeforeFusion = null;
let candidateStartedAt = 0;
let candidateKey = "";
let expectedFusionExit = false;
let transitionId = 0;
let transitionPromise = null;

let fusionState = {
  mode: "separate",
  candidateStartedAt: 0,
  lastError: null,
  fusionPid: null,
};

// ── 自愈看门狗 ──
// 融合协调器一旦意外停止（pollTimer 丢失 / error 态卡死），
// 本次 Hana 运行期内不会再自动恢复，导致两球永远无法再融合。
// 用一只轻量看门狗兜底：插件上下文还在但轮询消失时自动复活。
let shuttingDown = false;
let watchdogTimer = null;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    console.error("[闲不住] 融合状态写入失败:", error?.message || error);
    return false;
  }
}

function positionFromState(file, size) {
  const state = readJson(file);
  const x = asNumber(state?.x);
  const y = asNumber(state?.y);
  if (x === null || y === null) return null;
  return { x, y, width: size.width, height: size.height };
}

function positionCenter(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

// 恢复两球时若它们仍重叠（融合前就是叠着的），
// 关闭融合球后 1.8s 内又会自动再融合，形成"关了又合"的循环。
// 恢复前沿中心连线把两球拉开到最小中心距，保证不重叠。
export function spreadPositions(first, second, minCenterDist = 110) {
  if (!first || !second) return { first, second };
  const ca = positionCenter(first);
  const cb = positionCenter(second);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= minCenterDist) return { first, second };
  const ux = dist < 1e-6 ? 1 : dx / dist;
  const uy = dist < 1e-6 ? 0 : dy / dist;
  const mx = (ca.x + cb.x) / 2;
  const my = (ca.y + cb.y) / 2;
  const half = minCenterDist / 2;
  return {
    first: {
      ...first,
      x: Math.round(mx - ux * half - first.width / 2),
      y: Math.round(my - uy * half - first.height / 2),
    },
    second: {
      ...second,
      x: Math.round(mx + ux * half - second.width / 2),
      y: Math.round(my + uy * half - second.height / 2),
    },
  };
}

export function intersectionArea(first, second) {
  if (!first || !second) return 0;
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

export function overlapEnough(first, second, ratio = FUSION_OVERLAP_RATIO) {
  if (!first || !second) return false;
  const smallerArea = Math.min(first.width * first.height, second.width * second.height);
  if (smallerArea <= 0) return false;
  return intersectionArea(first, second) / smallerArea >= Number(ratio);
}

export function fusionStartPosition(first, second) {
  const a = positionCenter(first);
  const b = positionCenter(second);
  return {
    x: Math.round((a.x + b.x) / 2 - FUSION_WINDOW.width / 2),
    y: Math.round((a.y + b.y) / 2 - FUSION_WINDOW.height / 2),
  };
}

function resetCandidate() {
  candidateStartedAt = 0;
  candidateKey = "";
  fusionState.candidateStartedAt = 0;
}

function registerFusionStatusBridge(ctx) {
  const nextBus = ctx?.bus || ctx?._bus;
  if (!nextBus?.handle) return;
  if (fusionStatusBus === nextBus) return;
  try { fusionStatusUnregister?.(); } catch {}
  try {
    const unregister = nextBus.handle(FUSION_STATUS_BUS_TOPIC, (payload = {}) => {
      if (payload.action && payload.action !== "status") {
        return { ok: false, error: "不支持的融合状态查询动作" };
      }
      return getFusionState();
    });
    fusionStatusBus = nextBus;
    fusionStatusUnregister = typeof unregister === "function" ? unregister : null;
  } catch (error) {
    fusionStatusBus = null;
    fusionStatusUnregister = null;
    console.error("[闲不住] 注册融合状态桥失败:", error?.message || error);
  }
}

function unregisterFusionStatusBridge() {
  try { fusionStatusUnregister?.(); } catch (error) {
    console.error("[闲不住] 注销融合状态桥失败:", error?.message || error);
  }
  fusionStatusBus = null;
  fusionStatusUnregister = null;
}

async function requestJiegehua(action, payload = {}) {
  if (!bus || typeof bus.request !== "function") {
    return { ok: false, error: "解语花融合桥不可用" };
  }
  try {
    const result = await bus.request(
      FUSION_BUS_TOPIC,
      { action, ...payload },
      { timeoutMs: 3000 },
    );
    return result || { ok: false, error: "解语花融合桥没有返回" };
  } catch (error) {
    return { ok: false, error: error?.message || "解语花融合桥请求失败" };
  }
}

function logChildOutput(label, stream, level) {
  stream?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) level(`[${label}] ${text}`);
  });
}

function waitForProcessExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
    child.once("error", () => finish(true));
  });
}

async function stopFusionProcess() {
  const child = fusionProcess;
  if (!child) return true;
  expectedFusionExit = true;
  try {
    child.kill();
  } catch (error) {
    console.error("[闲不住] 停止融合球失败:", error?.message || error);
  }
  let exited = await waitForProcessExit(child);
  if (!exited) {
    try { child.kill("SIGKILL"); } catch {}
    exited = await waitForProcessExit(child, 1000);
  }
  if (!exited) return false;
  if (fusionProcess === child) {
    fusionProcess = null;
    fusionState.fusionPid = null;
  }
  return true;
}

function saveOriginalPosition(file, position) {
  const current = readJson(file) || {};
  current.x = Math.round(position.x);
  current.y = Math.round(position.y);
  return writeJsonAtomic(file, current);
}

export async function restoreSeparate(reason = "split", { force = false, waitForTransition = true } = {}) {
  if (fusionState.mode === "transitioning" && !force) {
    return { ok: false, status: 409, error: "融合正在切换，等一下再拆回" };
  }
  if (fusionState.mode === "transitioning" && force && waitForTransition && transitionPromise) {
    transitionId += 1;
    try { await transitionPromise; } catch {}
  }
  transitionId += 1;
  if (!snapshotBeforeFusion) {
    setFenglingFusionActive(false);
    fusionState.mode = "separate";
    return { ok: true, message: "没有可恢复的融合快照" };
  }
  if (restorePromise) return restorePromise;

  restorePromise = (async () => {
    fusionState.mode = "restoring";
    if (!await stopFusionProcess()) throw new Error("融合球进程退出超时，暂不启动旧球");

    const original = snapshotBeforeFusion;
    // 恢复位置前先把重叠的两球拉开，避免"关闭后 1.8s 又自动融合"的循环
    const spread = spreadPositions(original.fengling.position, original.jiegehua.position);
    if (!saveOriginalPosition(FENGLING_STATE_PATH, spread.first)) {
      throw new Error("风铃原位置保存失败");
    }
    if (!saveOriginalPosition(ZHUJIAN_STATE_PATH, spread.second)) {
      throw new Error("解语花原位置保存失败");
    }

    const started = [];
    if (original.fengling.running) {
      const result = startFengling(bus, { allowDuringRestore: true });
      if (result?.ok) started.push("fengling");
      else throw new Error(result?.error || "风铃重新启动失败");
    }
    if (original.jiegehua.running) {
      const result = await requestJiegehua("start", { internal: "restore" });
      if (result?.ok) started.push("jiegehua");
      else throw new Error(result?.error || "解语花重新启动失败");
    }

    snapshotBeforeFusion = null;
    resetCandidate();
    setFenglingFusionActive(false);
    fusionState.mode = "separate";
    fusionState.lastError = null;
    return { ok: true, message: "已拆回两球", reason, started };
  })().catch((error) => {
    fusionState.mode = "error";
    fusionState.lastError = error?.message || String(error);
    console.error("[闲不住] 融合拆回失败:", fusionState.lastError);
    return { ok: false, error: fusionState.lastError };
  }).finally(() => {
    restorePromise = null;
  });

  return restorePromise;
}

async function beginFusionInternal(fenglingPosition, jiegehuaSnapshot) {
  if (fusionState.mode !== "separate" || !fenglingPosition || !jiegehuaSnapshot?.position) return;
  if (!fs.existsSync(FUSION_SCRIPT)) {
    fusionState.lastError = "fusion_ball.py 不存在";
    resetCandidate();
    return;
  }

  fusionState.mode = "transitioning";
  // 切换开始就先占住两个原版启动入口，避免停旧球到拉起融合球之间被重复启动。
  setFenglingFusionActive(true);
  const currentTransitionId = ++transitionId;
  const fenglingProxy = getFenglingProxyInfo();
  const jiegehuaProxy = jiegehuaSnapshot.proxy || {};
  snapshotBeforeFusion = {
    fengling: {
      running: true,
      position: fenglingPosition,
      soundVolume: readJson(FENGLING_STATE_PATH)?.soundVolume,
    },
    jiegehua: {
      running: true,
      position: jiegehuaSnapshot.position,
      panel: jiegehuaSnapshot.panel || "none",
    },
  };

  try {
    const start = fusionStartPosition(fenglingPosition, jiegehuaSnapshot.position);
    const stopFenglingResult = await stopFengling();
    if (!stopFenglingResult?.ok) throw new Error(stopFenglingResult?.error || "风铃停止失败");
    const stopJiegehuaResult = await requestJiegehua("stop");
    if (!stopJiegehuaResult?.ok) throw new Error(stopJiegehuaResult?.error || "解语花停止失败");
    if (currentTransitionId !== transitionId || fusionState.mode !== "transitioning") {
      return;
    }

    const python = getFenglingState().python || "python";
    const env = {
      ...process.env,
      HANA_HOME,
      HANA_PLUGINS_DIR: process.env.HANA_PLUGINS_DIR || path.join(os.homedir(), ".hanako", "plugins"),
      FUSION_FENGLING_API: fenglingProxy.baseUrl,
      FUSION_FENGLING_TOKEN: fenglingProxy.token,
      FUSION_JIEGEHUA_API: jiegehuaProxy.baseUrl || "http://127.0.0.1:18903",
      FUSION_JIEGEHUA_TOKEN: jiegehuaProxy.token || "",
      FUSION_COORDINATOR_API: fenglingProxy.baseUrl,
      FUSION_COORDINATOR_TOKEN: fenglingProxy.token,
      FUSION_START_X: String(start.x),
      FUSION_START_Y: String(start.y),
      FUSION_INHERITED_PANEL: snapshotBeforeFusion.jiegehua.panel,
      FUSION_SOUND_VOLUME: String(snapshotBeforeFusion.fengling.soundVolume ?? 0.0),
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const child = spawn(python, [FUSION_SCRIPT], {
      cwd: path.dirname(FUSION_SCRIPT),
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    fusionProcess = child;
    expectedFusionExit = false;
    fusionState.fusionPid = child.pid || null;
    logChildOutput("融合球", child.stdout, console.log);
    logChildOutput("融合球", child.stderr, console.warn);
    child.on("error", (error) => {
      fusionState.lastError = error?.message || String(error);
      if (fusionState.mode === "fused" || fusionState.mode === "transitioning") {
        restoreSeparate("fusion_spawn_error", { force: true });
      }
    });
    child.on("exit", () => {
      const expected = expectedFusionExit;
      fusionProcess = null;
      fusionState.fusionPid = null;
      if (!expected && (fusionState.mode === "fused" || fusionState.mode === "transitioning")) {
        restoreSeparate("fusion_exit", { force: true });
      }
    });

    setFenglingFusionActive(true);
    fusionState.mode = "fused";
    fusionState.lastError = null;
    resetCandidate();
    console.log("[闲不住] 风铃 × 解语花已融合");
  } catch (error) {
    fusionState.lastError = error?.message || String(error);
    console.error("[闲不住] 融合启动失败:", fusionState.lastError);
    await restoreSeparate("fusion_start_error", { force: true, waitForTransition: false });
  }
}

function beginFusion(fenglingPosition, jiegehuaSnapshot) {
  if (transitionPromise) return transitionPromise;
  const tracked = beginFusionInternal(fenglingPosition, jiegehuaSnapshot).finally(() => {
    if (transitionPromise === tracked) transitionPromise = null;
  });
  transitionPromise = tracked;
  return tracked;
}

async function pollFusion() {
  if (pollInFlight) return;
  if (fusionState.mode === "fused") {
    // 融合态时旧解语花进程本来就应该是 stopped，不能拿它的状态判断融合球。
    // 融合球自身由 child exit 事件监测；句柄丢失才视为异常退出。
    if (!fusionProcess) await restoreSeparate("fusion_missing");
    return;
  }
  if (fusionState.mode !== "separate") return;
  pollInFlight = true;
  try {
    const fengling = getFenglingState();
    if (!fengling.running) {
      resetCandidate();
      return;
    }
    const fenglingPosition = positionFromState(FENGLING_STATE_PATH, FENGLING_WINDOW);
    if (!fenglingPosition) {
      resetCandidate();
      return;
    }
    const jiegehua = await requestJiegehua("snapshot");
    if (!jiegehua?.ok || !jiegehua.running || !jiegehua.position) {
      resetCandidate();
      return;
    }
    const key = `${fenglingPosition.x},${fenglingPosition.y}|${jiegehua.position.x},${jiegehua.position.y}`;
    if (!overlapEnough(fenglingPosition, jiegehua.position)) {
      resetCandidate();
      return;
    }
    if (candidateKey !== key) {
      candidateKey = key;
      candidateStartedAt = Date.now();
      fusionState.candidateStartedAt = candidateStartedAt;
      return;
    }
    if (Date.now() - candidateStartedAt >= FUSION_HOLD_MS) {
      await beginFusion(fenglingPosition, jiegehua);
    }
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    pollFusion().catch((error) => {
      fusionState.lastError = error?.message || String(error);
    });
  }, FUSION_POLL_MS);
  pollTimer.unref?.();
}

// 看门狗：协调器被意外停止后自愈，不用重启 Hana
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (shuttingDown) return;
    if (!pollTimer) {
      console.log("[闲不住] 融合协调器轮询停止，看门狗自愈重启");
      setFusionHttpHandler(handleFusionHttpRequest);
      if (fusionState.mode !== "fused") fusionState.mode = "separate";
      resetCandidate();
      startPolling();
    } else if (fusionState.mode === "error" && !fusionProcess) {
      console.log("[闲不住] 融合协调器 error 态卡死，看门狗复位");
      setFenglingFusionActive(false);
      fusionState.mode = "separate";
      resetCandidate();
    }
  }, 5000);
  watchdogTimer.unref?.();
}

export function initFusionCoordinator(ctx) {
  context = ctx || context;
  bus = context?.bus || context?._bus || bus;
  shuttingDown = false;
  registerFusionStatusBridge(context);
  setFusionHttpHandler(handleFusionHttpRequest);
  setFenglingFusionActive(isFusionStartBlocked(fusionState.mode) || Boolean(fusionProcess));
  startPolling();
  startWatchdog();
  return getFusionState();
}

export async function stopFusionCoordinator({ restore = false, force = false } = {}) {
  // 插件卸载（onunload）才走到这里：彻底停止，看门狗不再复活
  shuttingDown = true;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (restore && !force && fusionState.mode === "transitioning") {
    return { ok: false, status: 409, error: "融合正在切换，等一下再收起" };
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  let result = { ok: true };
  if (restore && snapshotBeforeFusion && fusionState.mode !== "separate") {
    result = await restoreSeparate("coordinator_stop", { force });
  } else {
    if (!await stopFusionProcess()) result = { ok: false, error: "融合球进程退出超时" };
    snapshotBeforeFusion = null;
    fusionState.mode = result.ok ? "separate" : "error";
  }
  setFusionHttpHandler(null);
  if (result.ok) {
    setFenglingFusionActive(false);
    fusionState.mode = "separate";
  }
  unregisterFusionStatusBridge();
  resetCandidate();
  return result;
}

export function getFusionState() {
  return {
    ok: true,
    mode: fusionState.mode,
    blocking: isFusionStartBlocked(fusionState.mode) || Boolean(fusionProcess),
    candidateStartedAt: fusionState.candidateStartedAt || null,
    lastError: fusionState.lastError,
    fusionPid: fusionState.fusionPid,
    holdMs: FUSION_HOLD_MS,
    overlapRatio: FUSION_OVERLAP_RATIO,
  };
}

export async function handleFusionHttpRequest({ method, url, body } = {}) {
  if (method === "POST" && url === "/fusion/split") {
    const result = await restoreSeparate(body?.reason || "user");
    return { status: result.ok ? 200 : (result.status || 500), body: result };
  }
  if (method === "GET" && url === "/fusion/status") {
    return { status: 200, body: getFusionState() };
  }
  return { status: 404, body: { ok: false, error: "not found" } };
}
