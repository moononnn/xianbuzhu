// 闲不住 · 伙伴状态联动扩展测试
// 自动状态由插件后台模型处理，主对话不再接收隐藏状态提示。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("状态联动扩展：不向主对话注册隐藏状态提示", async () => {
  const handlers = {};
  const pi = { on(name, fn) { handlers[name] = fn; } };
  const { default: register } = await import("../extensions/status.js");
  register(pi);

  assert.equal(handlers.before_agent_start, undefined);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.contributes.extensions, undefined);
});
