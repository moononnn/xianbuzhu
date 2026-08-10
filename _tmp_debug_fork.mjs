// 调试脚本：并发 fork 所有测试文件，抓真实崩溃堆栈
import { fork } from "node:child_process";
import path from "node:path";

const files = [
  "actions.test.js",
  "fengling-proxy.test.js",
  "fixes.test.js",
  "partners.test.js",
  "session-pick.test.js",
  "variables.test.js",
];

const procs = files.map((f) => {
  const p = fork(path.join("tests", f), [], {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
  });
  p.stdout.on("data", (d) => {});
  p.stderr.on("data", (d) => {
    process.stderr.write(`[${f}] ERR: ${d}`);
  });
  p.on("exit", (code, sig) => {
    console.log(`[${f}] exit code=${code} sig=${sig}`);
  });
  return p;
});

process.on("exit", () => console.log("debug done"));
