// 闲不住 — callLLM 外部 signal 穿透测试（第 8 点：队列超时真取消的核心链路）
// 覆盖：外部 AbortSignal 已 abort / 中途 abort 时，fetch 立即被终止（AbortError），
//       而不是等到内部 30s timeout —— 验证「Promise.race 输家不再后台跑」的机制。
// 运行：node --test tests/llm-abort.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-llm-abort-"));
process.env.HANA_HOME = tmp;

// 构造 provider 配置：callLLM 要读到 provider 配置才会走到 fetch 环节
fs.writeFileSync(
  path.join(tmp, "added-models.yaml"),
  [
    "providers:",
    "  test:",
    "    base_url: http://127.0.0.1:9",
    "    api_key: k",
    "    api: openai-completions",
    "    models:",
    "      - test-model",
    "",
  ].join("\n"),
  "utf-8",
);

const { callLLM } = await import("../lib/llm.js?v=" + Date.now());

// mock fetch：返回一个挂起的 Promise，只有 signal abort 时才会 reject。
// 注意必须处理「signal 已 abort」的情况：abort 事件已发生过，不会再次触发监听，
// 真 fetch 对已 abort 的 signal 是立即 reject，mock 要模拟这个行为，否则 promise 永远挂起。
function hangFetch() {
  let receivedSignal = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    receivedSignal = opts?.signal || null;
    return new Promise((_, reject) => {
      if (opts.signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };
  return {
    restore: () => {
      globalThis.fetch = orig;
    },
    get receivedSignal() {
      return receivedSignal;
    },
  };
}

test("callLLM: 外部 signal 已 abort 时 fetch 立即失败（AbortError）", async () => {
  const mock = hangFetch();
  try {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await assert.rejects(
      callLLM("hello", {
        providerId: "test",
        modelId: "test-model",
        signal: ac.signal,
      }),
      (e) => e.name === "AbortError",
      "应抛 AbortError",
    );
    assert.ok(
      Date.now() - start < 2000,
      "abort 应立即失败而非等 30s 内部超时",
    );
    assert.ok(mock.receivedSignal, "signal 应透传到 fetch");
  } finally {
    mock.restore();
  }
});

test("callLLM: 外部 signal 中途 abort 时挂起的 fetch 被终止", async () => {
  const mock = hangFetch();
  try {
    const ac = new AbortController();
    const p = callLLM("hello", {
      providerId: "test",
      modelId: "test-model",
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e) => e.name === "AbortError");
    assert.ok(mock.receivedSignal, "signal 应透传到 fetch");
  } finally {
    mock.restore();
  }
});
