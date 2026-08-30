// tests/fengling-pid.test.js — 风铃 PID 文件握手回归测试
//
// 背景（2026-08-25）：Hana 重启/插件重载后，闲不住进程内存里的 appProcess 句柄会丢，
// 但风铃 Python 球是独立进程不会消失，导致「球还在桌面、页面却显示关闭」的状态失忆。
// 修复：python 侧写 PID 文件，node 侧以此作为「风铃是否真在跑」的事实源，并支持
// 识别/清理遗留球（防双球）。下面覆盖 PID 解析、状态判定、遗留球清理三条链路。
//
// 模块只在 import 时绑定 HANA_HOME，这里用临时目录隔离，不碰生产数据。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-fengling-pid-"));
process.env.HANA_HOME = tmp;
const PID_FILE = path.join(tmp, "data", "work-visit", "fengling.pid");

const fengling = await import("../lib/fengling.js");

function writePid(value) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(value), "ascii");
}

test("readPidFile：无文件/乱内容/越界都返回 null，合法 pid 返回数字", () => {
  // 没有文件
  assert.equal(fengling.readPidFile(), null);
  // 乱内容
  writePid("abc");
  assert.equal(fengling.readPidFile(), null);
  writePid("12.5");
  assert.equal(fengling.readPidFile(), null);
  writePid("0");
  assert.equal(fengling.readPidFile(), null);
  writePid("-3");
  assert.equal(fengling.readPidFile(), null);
  // 合法 pid
  writePid("12345");
  assert.equal(fengling.readPidFile(), 12345);
  fs.rmSync(PID_FILE, { force: true });
});

test("pidAlive：非数字/非正整数为假，活进程为真", () => {
  assert.equal(fengling.pidAlive(), false);
  assert.equal(fengling.pidAlive(0), false);
  assert.equal(fengling.pidAlive(-1), false);
  assert.equal(fengling.pidAlive(999999999), false); // 大概率不存在的 pid
  assert.equal(fengling.pidAlive(process.pid), true); // 测试进程自身活着
});

test("getFenglingState：让遗留进程存活时 running=true（认得还在跑的球）", () => {
  // 无 appProcess、无 fusion、PID 指向一个真实存活的进程（本测试进程自身）
  writePid(String(process.pid));
  const st1 = fengling.getFenglingState();
  assert.equal(st1.running, true);
  assert.equal(st1.stray, true);
  assert.equal(st1.pid, process.pid);
  fs.rmSync(PID_FILE, { force: true });

  // 指向不存在的进程 → 视为没在跑
  writePid("999999999");
  const st2 = fengling.getFenglingState();
  assert.equal(st2.running, false);
  assert.equal(st2.stray, false);
  fs.rmSync(PID_FILE, { force: true });

  // fusionActive 时仍算 running（不回归）
  fengling.setFenglingFusionActive(true);
  const st3 = fengling.getFenglingState();
  assert.equal(st3.running, true);
  fengling.setFenglingFusionActive(false);
  fs.rmSync(PID_FILE, { force: true });
});

test("stopFengling：插件丢句柄时按 PID 文件收掉遗留球并清文件", async () => {
  // 造一个真实存活的假「风铃」子进程，把它的 pid 写进 PID 文件
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((r) => {
    child.once("spawn", r);
    child.once("error", r); // spawn 失败（如 PATH 无 node）也用 error 唤醒，避免永远等待
  });
  if (child.pid === undefined) {
    // spawn 失败：没法造真实子进程，跳过此用例的进程断言，只验证 PID 文件清理路径
    writePid("999999999");
    const res = await fengling.stopFengling();
    assert.equal(res.stray, false);
    assert.equal(fs.existsSync(PID_FILE), false);
    return;
  }
  child.on("error", () => {}); // 后续错误不再 unhandled
  writePid(String(child.pid));

  const res = await fengling.stopFengling();
  assert.equal(res.ok, true);
  assert.equal(res.stray, true);
  assert.equal(res.exited, true);
  // 遗留球应已被终止（等 Node 结算 exit 通知，带 3s 超时避免 CI 上 exit 事件延迟）
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    const timer = setTimeout(r, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      r();
    });
  });
  assert.equal(fs.existsSync(PID_FILE), false);
});
