// 闲不住 — 伙伴列表编辑逻辑测试
// 覆盖：刷新找回（清除 hidden + 保留装饰/颜色/变量）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPartnerIds,
  getVisiblePartnerConfig,
  mergeRefreshedPartners,
} from "../lib/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("mergeRefreshedPartners: 刷新找回所有伙伴（清除 hidden）", () => {
  const old = {
    hanako: { name: "小花", color: "#4CAF50", hidden: true, variables: { mood: 60 } },
    helperA: { name: "伙伴A", color: "#E91E63", hidden: true, variables: { mood: 40 } },
  };
  const scanned = {
    hanako: { name: "小花", color: "#111111", variables: { mood: 99 } },
    helperA: { name: "伙伴A", color: "#222222", variables: { mood: 88 } },
  };
  const out = mergeRefreshedPartners(old, scanned);
  assert.equal(out.hanako.hidden, undefined, "刷新后 hidden 应被清除");
  assert.equal(out.helperA.hidden, undefined, "刷新后 hidden 应被清除");
});

test("mergeRefreshedPartners: 保留旧配置的颜色/变量/装饰，并清掉卡面与称号", () => {
  const oldDeco = {
    owned: { avatarFrame: ["avatar_star"], cardBg: ["bg_warm"], title: ["旧称号"] },
    equipped: { avatarFrame: "avatar_star", cardBg: "bg_warm", title: "旧称号" },
  };
  const deco = {
    owned: { avatarFrame: ["avatar_star"] },
    equipped: { avatarFrame: "avatar_star" },
  };
  const customStatuses = [{ id: "custom-hanako", text: "脑内施工中", icon: "🧠", category: "整活" }];
  const statusAutonomy = { lastCheckedAt: "2026-08-31T10:00:00+08:00", nextCheckAt: "2026-08-31T11:30:00+08:00" };
  const unlockedStatuses = ["sorting-things", "brain-meeting"];
  const old = {
    hanako: { name: "小花", color: "#4CAF50", variables: { mood: 60 }, decorations: oldDeco, customStatuses, statusAutonomy, unlockedStatuses },
  };
  const scanned = {
    hanako: { name: "小花", color: "#999999", variables: { mood: 5 } },
  };
  const out = mergeRefreshedPartners(old, scanned);
  assert.equal(out.hanako.color, "#4CAF50", "旧颜色优先保留");
  assert.equal(out.hanako.variables.mood, 60, "旧变量优先保留");
  assert.deepEqual(out.hanako.decorations, deco, "装饰原样保留");
  assert.deepEqual(out.hanako.customStatuses, customStatuses, "专属状态原样保留");
  assert.deepEqual(out.hanako.statusAutonomy, statusAutonomy, "自主状态检查进度原样保留");
  assert.deepEqual(out.hanako.unlockedStatuses, unlockedStatuses, "高级状态解锁记录原样保留");
});

test("getPartnerIds: 隐藏助手不进入当前闲不住列表", () => {
  const data = {
    partnerConfig: {
      visible: { name: "可见" },
      hidden: { name: "测试探针", hidden: true },
    },
  };
  assert.deepEqual(getPartnerIds(data), ["visible"]);
  assert.deepEqual(Object.keys(getVisiblePartnerConfig(data)), ["visible"]);
});

test("mergeRefreshedPartners: 保留心意节奏设置", () => {
  const out = mergeRefreshedPartners(
    { helper: { name: "助手", heartRhythm: "quiet" } },
    { helper: { name: "助手", color: "#111", variables: {} } },
  );
  assert.equal(out.helper.heartRhythm, "quiet");
});

test("mergeRefreshedPartners: 无旧配置时用扫描结果，不报错", () => {
  const out = mergeRefreshedPartners(undefined, {
    newbie: { name: "新人", color: "#00BCD4", variables: { mood: 50 } },
  });
  assert.equal(out.newbie.name, "新人");
  assert.equal(out.newbie.hidden, undefined);
});

test("启动扫描：保留伙伴高级状态解锁记录", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-startup-unlock-"));
  try {
    const dataDir = path.join(temp, "data", "work-visit");
    const agentDir = path.join(temp, "agents", "hanako");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "name: 小花\n", "utf8");
    fs.writeFileSync(path.join(dataDir, "data.json"), JSON.stringify({
      days: {},
      lastResetDate: "2026-09-02",
      jar: 12909,
      partnerConfig: {
        hanako: {
          name: "小花",
          unlockedStatuses: ["sorting-things", "pretend-calm", "brain-meeting", "loading-failed"],
        },
      },
    }), "utf8");
    const script = `
      import fs from "node:fs";
      const { default: Plugin } = await import("./index.js");
      const plugin = new Plugin();
      await plugin.onload();
      await plugin.onunload();
      const data = JSON.parse(fs.readFileSync(process.env.HANA_HOME + "/data/work-visit/data.json", "utf8"));
      fs.writeFileSync(process.env.HANA_HOME + "/startup-result.json", JSON.stringify({
        unlocks: data.partnerConfig.hanako.unlockedStatuses,
        jar: data.jar,
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, HANA_HOME: temp },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(fs.readFileSync(path.join(temp, "startup-result.json"), "utf8"));
    assert.deepEqual(output.unlocks, ["sorting-things", "pretend-calm", "brain-meeting", "loading-failed"]);
    assert.equal(output.jar, 12909, "启动扫描不应改变光粒");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
