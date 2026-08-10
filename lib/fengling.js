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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadData, findMostActiveAgentId } from "./data.js";
import { getPartnerIds } from "./config.js";
import { performVisit } from "./actions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(__dirname, "..", "python");
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROXY_PORT = Number(process.env.XIANBUZHU_PROXY_PORT || 18902);

const PYTHON_CANDIDATES = [
  "C:\\Python314\\python.exe",
  "C:\\Python313\\python.exe",
  "C:\\Python312\\python.exe",
  "python",
  "python3",
];

function detectPython() {
  for (const p of PYTHON_CANDIDATES) {
    if (fs.existsSync(p)) return p;
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

function currentTargetPayload() {
  const data = loadData();
  const id = findMostActiveAgentId(getPartnerIds(data));
  if (!id) return null;
  return { id, name: data.partnerConfig?.[id]?.name || id };
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
  const result = await visitFn({ ...input, to: target.id }, { bus });
  return { status: result.status, body: { ...result.body, target } };
}

function startProxy(bus) {
  if (proxyServer) return;
  proxyServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const url = req.url || "/";
      if (req.method === "GET" && url === "/health") {
        return sendJson(res, 200, { ok: true, running: !!appProcess });
      }
      if (req.method === "GET" && url === "/catalog") {
        return sendJson(res, 200, catalogPayload());
      }
      if (req.method === "GET" && url === "/target") {
        return sendJson(res, 200, { ok: true, target: currentTargetPayload() });
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
export function startFengling(bus) {
  if (appProcess) return { ok: true, message: "已在运行" };
  const python = detectPython();
  const script = path.join(PY_DIR, "fengling_app.py");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "fengling_app.py 不存在" };
  }

  startProxy(bus);

  const env = { ...process.env };
  env.XIANBUZHU_API = `http://127.0.0.1:${PROXY_PORT}`;
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

export function stopFengling() {
  if (!appProcess) return { ok: true, message: "未在运行" };
  try {
    appProcess.kill();
  } catch (e) {
    console.error("[风铃] 停止失败:", e?.message || e);
  }
  appProcess = null;
  state.running = false;
  dismissedByUser = true; // 用户手动收起：本次打开页面不再自动弹，下次再弹
  return { ok: true, message: "已停止" };
}

export function getFenglingState() {
  return {
    ok: true,
    running: !!appProcess,
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
