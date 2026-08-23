// lib/fengling.js — 风铃悬浮球：进程管理 + 本地代理
//
// 悬浮球（python/fengling_app.py）不直接访问 Hana 插件 API，
// 所有动作请求都打到本模块维护的本地代理端口（127.0.0.1:18902），
// 由代理在插件进程内执行与页面完全一致的业务逻辑（lib/actions.js）。
// 这样既不需要页面 token，也保证两路行为一致。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadData,
  saveData,
  withDataLock,
  findMostActiveAgentId,
  findLatestSessionPath,
} from "./data.js";
import {
  archiveExpiredHearts,
  getActiveHearts,
  markHeartsBellDismissed,
  markHeartsDelivered,
  publicHeart,
} from "./hearts.js";
import { getDisplayName, getPartnerIds } from "./config.js";
import { isSessionPathForAgent, listNamedSessions } from "./session-picker.js";
import { performVisit } from "./actions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(__dirname, "..", "python");
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROXY_PORT = Number(process.env.XIANBUZHU_PROXY_PORT || 18902);
const TARGET_SESSION_LIMIT = 5;

const PYTHON_CANDIDATES = [
  "C:\\Python314\\python.exe",
  "C:\\Python313\\python.exe",
  "C:\\Python312\\python.exe",
  "python",
  "python3",
];

function detectPython() {
  for (const p of PYTHON_CANDIDATES) {
    // 绝对路径：直接查存在性；PATH 命令：真实执行探测（existsSync 查不到 PATH）
    if (/[\\/]/.test(p)) {
      if (fs.existsSync(p)) return p;
    } else {
      try {
        const r = spawnSync(p, ["--version"], { timeout: 3000, stdio: "ignore" });
        if (r.status === 0) return p;
      } catch {
        // 继续下一个候选
      }
    }
  }
  return "python";
}

let appProcess = null;
let proxyServer = null;
let state = {
  running: false,
  startedAt: null,
  exitCode: null,
  error: null,
};
// 用户手动关闭过风铃：Hana 本次运行期间，再打开页面不再自动弹（消费式读取）
let dismissedByUser = false;
let fusionHttpHandler = null;
let fusionActive = false;

export function setFusionHttpHandler(handler) {
  fusionHttpHandler = typeof handler === "function" ? handler : null;
}

export function setFenglingFusionActive(active) {
  fusionActive = Boolean(active);
}

export function consumeFenglingDismissed() {
  const v = dismissedByUser;
  dismissedByUser = false;
  return v;
}

// ─────────────────────────────
//  本地代理（悬浮球 ↔ 插件业务）
// ─────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64 * 1024) {
        resolve({});
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function fenglingHeartPayload(heart, data) {
  return {
    ...publicHeart(heart, data.heartSettings),
    // 仅给本地风铃代理补充送达/收起状态，主页面仍使用 publicHeart 的最小展示契约。
    deliveredAt: heart.deliveredAt || null,
    bellDismissedAt: heart.bellDismissedAt || null,
  };
}

function catalogPayload() {
  const data = loadData();
  const tag = (arr, type) =>
    (arr || []).map((i) => ({ ...i, type }));
  return {
    ok: true,
    jar: data.jar || 0,
    gifts: tag(data.shopItems, "gift"),
    interacts: tag(data.interactItems, "interact"),
    pranks: tag(data.prankItems, "prank"),
  };
}

function sessionTargetFromPinned(data) {
  const pinned = data?.pinnedTarget;
  const agentId = typeof pinned?.agentId === "string" ? pinned.agentId : "";
  const sessionPath = typeof pinned?.sessionPath === "string" ? pinned.sessionPath : "";
  if (!agentId || !sessionPath || !getPartnerIds(data).includes(agentId)) return null;
  if (!isSessionPathForAgent(sessionPath, agentId)) return null;
  return {
    id: agentId,
    agentId,
    name: getDisplayName(data, agentId),
    title: String(pinned.title || ""),
    sessionPath,
    mode: "pinned",
    pinned: { agentId, sessionPath, title: String(pinned.title || "") },
  };
}

function currentTargetPayload() {
  const data = loadData();
  const pinned = sessionTargetFromPinned(data);
  if (pinned) return pinned;

  const id = findMostActiveAgentId(getPartnerIds(data));
  if (!id) return null;
  const sessionPath = findLatestSessionPath(id);
  if (!sessionPath) return null;
  return {
    id,
    agentId: id,
    name: getDisplayName(data, id),
    title: "",
    sessionPath,
    mode: "auto",
    pinned: null,
  };
}

async function targetPayload(bus) {
  let data = loadData();
  let pinned = sessionTargetFromPinned(data);
  if (data.pinnedTarget && !pinned) {
    // 旧会话已被 Hana 清理时回落自动判断；清理也必须走同一把数据锁，
    // 不能拿旧快照整体覆盖同时发生的互动/心意写入。
    await withDataLock(() => {
      const latest = loadData();
      if (latest.pinnedTarget && !sessionTargetFromPinned(latest)) {
        latest.pinnedTarget = null;
        if (!saveData(latest)) {
          console.warn("[闲不住] 清理失效固定对话失败");
        }
      }
    });
    data = loadData();
    pinned = sessionTargetFromPinned(data);
  }
  const target = pinned || currentTargetPayload();
  let resolved = target;
  if (target?.sessionPath) {
    const sessions = await listNamedSessions(bus, getPartnerIds(data), target.agentId, 24);
    const matched = sessions.find((item) => path.normalize(item.sessionPath) === path.normalize(target.sessionPath));
    if (matched) resolved = { ...target, title: matched.title || target.title };
  }
  return {
    ok: true,
    target: resolved,
    mode: resolved?.mode || "auto",
    pinned: resolved?.mode === "pinned" ? resolved.pinned : null,
  };
}

async function sessionListPayload(bus, agentId = "") {
  const data = loadData();
  const partnerIds = getPartnerIds(data);
  if (agentId && !partnerIds.includes(agentId)) {
    return { ok: false, status: 400, error: "助手当前不在闲不住列表里" };
  }
  const sessions = await listNamedSessions(bus, partnerIds, agentId, TARGET_SESSION_LIMIT);
  return {
    ok: true,
    sessions: sessions.map((session) => ({
      ...session,
      agentName: getDisplayName(data, session.agentId),
    })),
  };
}

function agentListPayload() {
  const data = loadData();
  return {
    ok: true,
    agents: getPartnerIds(data).map((id) => ({ id, name: getDisplayName(data, id) })),
  };
}

async function setPinnedTarget(pinned) {
  return withDataLock(() => {
    const data = loadData();
    data.pinnedTarget = pinned
      ? {
          agentId: String(pinned.agentId || ""),
          sessionPath: String(pinned.sessionPath || ""),
          title: String(pinned.title || ""),
        }
      : null;
    return saveData(data);
  });
}

export async function performFenglingVisit(input, bus, visitFn = performVisit) {
  // 目标以收到点击请求的这一刻为准；后续执行期间切换窗口不改写本次动作。
  const target = currentTargetPayload();
  if (!target) {
    return {
      status: 409,
      body: { success: false, error: "还没找到正在聊天的窗口" },
    };
  }
  const result = await visitFn(
    { ...input, to: target.id, sessionPath: target.sessionPath },
    { bus },
  );
  return { status: result.status, body: { ...result.body, target } };
}

// 本地代理随机鉴权 token：防止任意网页跨域调用 127.0.0.1:18902 触发插件动作。
// 每次 startProxy 生成，随环境变量注入 python 子进程，两边共享同一个值。
let _proxyToken = "";
function getProxyToken() {
  if (!_proxyToken) {
    _proxyToken = crypto.randomBytes(24).toString("hex");
  }
  return _proxyToken;
}

function startProxy(bus) {
  if (proxyServer) return;
  const token = getProxyToken();
  proxyServer = http.createServer(async (req, res) => {
    // 所有端点强制鉴权：Authorization: Bearer <token>
    // （不再设置 CORS 头——python 客户端是本地进程不走浏览器 CORS，
    //   移除通配 CORS + token 校验双保险，浏览器里的任意网页无法再跨域调用）
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    try {
      const url = req.url || "/";
      if (fusionHttpHandler && url.startsWith("/fusion/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        const result = await fusionHttpHandler({ method: req.method, url, body });
        return sendJson(res, result?.status || 200, result?.body || { ok: false, error: "融合桥没有返回" });
      }
      if (req.method === "GET" && url === "/health") {
        return sendJson(res, 200, { ok: true, running: !!appProcess });
      }
      if (req.method === "GET" && url === "/catalog") {
        return sendJson(res, 200, catalogPayload());
      }
      if (req.method === "GET" && url === "/target") {
        return sendJson(res, 200, await targetPayload(bus));
      }
      if (req.method === "GET" && url === "/agents") {
        return sendJson(res, 200, agentListPayload());
      }
      if (req.method === "GET" && url.startsWith("/sessions")) {
        const parsed = new URL(url, "http://127.0.0.1");
        const result = await sessionListPayload(bus, parsed.searchParams.get("agentId") || "");
        return sendJson(res, result.ok ? 200 : (result.status || 400), result);
      }
      if (req.method === "POST" && url === "/pin") {
        const input = await readBody(req);
        const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
        const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath.trim() : "";
        if (!sessionPath) {
          const ok = await setPinnedTarget(null);
          return sendJson(res, ok ? 200 : 500, ok
            ? { ok: true, mode: "auto", pinned: null }
            : { ok: false, error: "自动选择保存失败" });
        }
        const data = loadData();
        if (!agentId || !getPartnerIds(data).includes(agentId)) {
          return sendJson(res, 400, { ok: false, error: "助手当前不在闲不住列表里" });
        }
        if (!isSessionPathForAgent(sessionPath, agentId)) {
          return sendJson(res, 400, { ok: false, error: "这段对话已经不存在了，请重新选择" });
        }
        const pinned = {
          agentId,
          sessionPath,
          title: typeof input.title === "string" ? input.title.trim().slice(0, 80) : "",
        };
        const ok = await setPinnedTarget(pinned);
        return sendJson(res, ok ? 200 : 500, ok
          ? { ok: true, mode: "pinned", pinned }
          : { ok: false, error: "固定对话保存失败" });
      }
      if (req.method === "GET" && url === "/hearts") {
        const data = loadData();
        const expiredChanged = archiveExpiredHearts(data);
        if (expiredChanged) saveData(data);
        // 风铃需要持续看到已送达但尚未在主页面确认的心意，才能同步收起提示。
        const hearts = getActiveHearts(data).map((heart) => fenglingHeartPayload(heart, data));
        return sendJson(res, 200, { ok: true, hearts });
      }
      if (req.method === "POST" && url === "/hearts/ack") {
        const input = await readBody(req);
        const result = await withDataLock(() => {
          const data = loadData();
          const count = markHeartsDelivered(data, input.ids);
          if (count > 0 && !saveData(data)) return { ok: false, error: "心意送达状态保存失败" };
          return { ok: true, count };
        });
        return sendJson(res, result.ok ? 200 : 500, result);
      }
      if (req.method === "POST" && url === "/hearts/dismiss") {
        const input = await readBody(req);
        const result = await withDataLock(() => {
          const data = loadData();
          const count = markHeartsBellDismissed(data, input.ids);
          if (count > 0 && !saveData(data)) return { ok: false, error: "心意收起状态保存失败" };
          return { ok: true, count };
        });
        return sendJson(res, result.ok ? 200 : 500, result);
      }
      if (req.method === "POST" && url === "/visit") {
        const input = await readBody(req);
        const result = await performFenglingVisit(input, bus);
        return sendJson(res, result.status, result.body);
      }
      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      console.error("[闲不住] 悬浮球本地代理错误:", e?.message || e);
      return sendJson(res, 500, { ok: false, error: "内部错误" });
    }
  });
  proxyServer.on("error", (e) => {
    console.error("[闲不住] 本地代理端口 " + PROXY_PORT + " 异常:", e?.message || e);
    proxyServer = null;
  });
  proxyServer.listen(PROXY_PORT, "127.0.0.1");
}

// ─────────────────────────────
//  悬浮球进程管理
// ─────────────────────────────
export function startFengling(bus, { allowDuringRestore = false } = {}) {
  if (fusionActive && !allowDuringRestore) return { ok: true, message: "融合球已在运行", fusion: true };
  if (appProcess) return { ok: true, message: "已在运行" };
  const python = detectPython();
  const script = path.join(PY_DIR, "fengling_app.py");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "fengling_app.py 不存在" };
  }

  startProxy(bus);

  const env = { ...process.env };
  env.XIANBUZHU_API = `http://127.0.0.1:${PROXY_PORT}`;
  env.XIANBUZHU_TOKEN = getProxyToken();
  env.HANA_HOME = HANA_HOME;
  env.PYTHONDONTWRITEBYTECODE = "1";

  try {
    appProcess = spawn(python, [script], {
      cwd: PY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
  } catch (e) {
    state.error = e?.message || String(e);
    return { ok: false, error: state.error };
  }

  appProcess.stdout?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.log("[风铃] " + s);
  });
  appProcess.stderr?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.warn("[风铃] " + s);
  });
  appProcess.on("exit", (code) => {
    console.log("[风铃] 进程退出, code:", code);
    appProcess = null;
    state.running = false;
    state.exitCode = code;
    // 进程退出（含右键关闭/崩溃）：视为用户已关闭，本次运行期间不再自动弹
    dismissedByUser = true;
  });
  appProcess.on("error", (err) => {
    console.error("[风铃] 启动失败:", err.message);
    appProcess = null;
    state.running = false;
    state.error = err.message;
  });

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.exitCode = null;
  state.error = null;
  dismissedByUser = false; // 用户重新要球了，下次打开页面恢复自动
  return { ok: true, message: "已启动" };
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

export async function stopFengling() {
  const child = appProcess;
  if (!child) return { ok: true, message: "未在运行", exited: true };
  dismissedByUser = true; // 用户手动收起：本次打开页面不再自动弹，下次再弹
  try {
    child.kill();
  } catch (e) {
    console.error("[风铃] 停止失败:", e?.message || e);
  }
  let exited = await waitForProcessExit(child);
  if (!exited) {
    try { child.kill("SIGKILL"); } catch {}
    exited = await waitForProcessExit(child, 1000);
  }
  if (!exited) {
    return { ok: false, error: "风铃进程退出超时，暂不重新启动，避免出现两个风铃" };
  }
  if (appProcess === child) {
    appProcess = null;
    state.running = false;
  }
  return { ok: true, message: "已停止", exited: true };
}

export function getFenglingProxyInfo() {
  return {
    baseUrl: `http://127.0.0.1:${PROXY_PORT}`,
    token: getProxyToken(),
    running: !!appProcess,
  };
}

export function getFenglingState() {
  return {
    ok: true,
    running: !!appProcess || fusionActive,
    fusionActive,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    error: state.error,
    python: detectPython(),
    pyQtOk: null, // 由 checkFenglingDeps 填充
  };
}

// ─────────────────────────────
//  依赖检查（Python + PyQt6，30 秒缓存）
// ─────────────────────────────
let _depsCache = null;
let _depsCacheTime = 0;

export async function checkFenglingDeps() {
  const now = Date.now();
  if (_depsCache && now - _depsCacheTime < 30_000) {
    return _depsCache;
  }
  const python = detectPython();
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ["-c", "import PyQt6; import PyQt6.QtSvg"], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, python, pyQtOk: false, error: "无法启动 Python" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, python, pyQtOk: false, error: "依赖检查超时" });
    }, 15000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, python, pyQtOk: false, error: "Python 不存在" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const pyQtOk = code === 0;
      resolve({ ok: pyQtOk, python, pyQtOk, error: pyQtOk ? null : "缺少 PyQt6（pip install PyQt6）" });
    });
  });
  _depsCache = result;
  _depsCacheTime = now;
  return result;
}
