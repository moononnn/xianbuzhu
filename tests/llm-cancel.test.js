// 闲不住 — callLLM 外部 signal 取消测试（node:test）
// 审查意见：外层超时后网络请求应被实际中止，而非只停止写盘
// 独立文件：node --test 每个文件独立进程，避免与其它测试共享 ESM 模块缓存
// 运行：node --test tests/llm-cancel.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHARED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wv-llm-cancel-"));
process.env.HANA_HOME = SHARED_HOME;
const DATA_DIR = path.join(SHARED_HOME, "data", "work-visit");

function writeData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "data.json"),
    JSON.stringify({
      days: {},
      lastResetDate: new Date(Date.now() + 480 * 60000)
        .toISOString()
        .slice(0, 10),
      jar: 100,
      pendingVisits: [],
      partnerConfig: {},
      // 用 supplementKeys 提供假供应商，绕过 added-models.yaml 依赖
      supplementKeys: {
        testprov: { apiKey: "k", baseUrl: "http://127.0.0.1:1" },
      },
    }),
    "utf-8",
  );
}

test("callLLM: 外部 signal abort 会真正中止 fetch 并 reject", async () => {
  writeData();

  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const { callLLM } = await import("../lib/llm.js?v=" + stamp);

  const origFetch = globalThis.fetch;
  let capturedSignal = null;
  globalThis.fetch = (url, opts) => {
    capturedSignal = opts.signal;
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  };

  try {
    const ctrl = new AbortController();
    const p = callLLM("hi", {
      providerId: "testprov",
      modelId: "m",
      signal: ctrl.signal,
    });
    // 等 fetch 被调用（微任务/IO 让出）
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(capturedSignal, "fetch 应接收到 signal");
    assert.equal(capturedSignal.aborted, false);

    ctrl.abort(); // 外部超时/取消
    await assert.rejects(p, /Abort/i, "外部 abort 应使 callLLM reject");
    assert.equal(
      capturedSignal.aborted,
      true,
      "传给 fetch 的 signal 应已被中止（网络请求真正取消，不只是停止写盘）",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
