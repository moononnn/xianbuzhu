// 闲不住 · Yuan 默认头像回退测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultAvatarFilename,
  normalizeYuan,
  parseAgentYuan,
  resolveAgentAvatar,
} from "../lib/avatar.js";

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-avatar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hanaHome = path.join(root, "hana");
  const productDir = path.join(root, "product");
  fs.mkdirSync(path.join(hanaHome, "agents"), { recursive: true });
  return { root, hanaHome, productDir };
}

function writeAgent(hanaHome, agentId, yuan, avatarContent) {
  const agentDir = path.join(hanaHome, "agents", agentId);
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    `agent:\n  name: ${agentId}\n  yuan: ${yuan}\n`,
    "utf-8",
  );
  if (avatarContent !== undefined) {
    fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), avatarContent);
  }
}

test("Yuan 类型映射到 Hana 内置头像文件", () => {
  assert.equal(normalizeYuan("hanako"), "hanako");
  assert.equal(normalizeYuan("BUTTER"), "butter");
  assert.equal(normalizeYuan("unknown"), "hanako");
  assert.equal(defaultAvatarFilename("hanako"), "Hanako.png");
  assert.equal(defaultAvatarFilename("ming"), "Ming.png");
  assert.equal(defaultAvatarFilename("kong"), "Kong.png");
});

test("从助手 config.yaml 读取 Yuan，未知值回到 hanako", () => {
  assert.equal(
    parseAgentYuan("agent:\n  name: 伙伴甲\n  yuan: hanako\n"),
    "hanako",
  );
  assert.equal(
    parseAgentYuan("agent:\n  name: 伙伴\n  yuan: 'butter'\n"),
    "butter",
  );
  assert.equal(parseAgentYuan("agent:\n  yuan: future\n"), "hanako");
  assert.equal(parseAgentYuan("agent:\n  name: 没有配置\n"), "hanako");
});

test("有自定义头像时优先使用自定义头像", (t) => {
  const { hanaHome, productDir } = makeFixture(t);
  writeAgent(hanaHome, "yunying", "hanako", "custom-avatar");
  const result = resolveAgentAvatar(hanaHome, "yunying", {
    productDirs: [productDir],
    includeRuntimeRoots: false,
  });
  assert.ok(result);
  assert.equal(result.source, "custom");
  assert.equal(result.mimeType, "image/png");
  assert.equal(fs.readFileSync(result.path, "utf-8"), "custom-avatar");
});

test("没有自定义头像时使用 Yuan 对应的 Hana 内置头像", (t) => {
  const { hanaHome, productDir } = makeFixture(t);
  writeAgent(hanaHome, "yunying", "hanako");
  const defaultAvatar = path.join(
    productDir,
    "desktop",
    "dist-renderer",
    "assets",
    "Hanako.png",
  );
  fs.mkdirSync(path.dirname(defaultAvatar), { recursive: true });
  fs.writeFileSync(defaultAvatar, "hana-default");

  const result = resolveAgentAvatar(hanaHome, "yunying", {
    productDirs: [productDir],
    includeRuntimeRoots: false,
  });
  assert.ok(result);
  assert.equal(result.source, "yuan-default");
  assert.equal(result.yuan, "hanako");
  assert.equal(path.basename(result.path), "Hanako.png");
  assert.equal(fs.readFileSync(result.path, "utf-8"), "hana-default");
});

test("Yuan 切换为 butter 时跟随切换默认头像", (t) => {
  const { hanaHome, productDir } = makeFixture(t);
  writeAgent(hanaHome, "yunying", "butter");
  const defaultAvatar = path.join(
    productDir,
    "desktop",
    "src",
    "assets",
    "Butter.png",
  );
  fs.mkdirSync(path.dirname(defaultAvatar), { recursive: true });
  fs.writeFileSync(defaultAvatar, "butter-default");

  const result = resolveAgentAvatar(hanaHome, "yunying", {
    productDirs: [productDir],
    includeRuntimeRoots: false,
  });
  assert.ok(result);
  assert.equal(result.source, "yuan-default");
  assert.equal(result.yuan, "butter");
  assert.equal(path.basename(result.path), "Butter.png");
});

test("头像文件不存在时返回 null，交给前端最后兜底", (t) => {
  const { hanaHome, productDir } = makeFixture(t);
  writeAgent(hanaHome, "yunying", "hanako");
  assert.equal(
    resolveAgentAvatar(hanaHome, "yunying", {
      productDirs: [productDir],
      includeRuntimeRoots: false,
    }),
    null,
  );
});
