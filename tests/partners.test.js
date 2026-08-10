// 闲不住 — 伙伴列表编辑逻辑测试
// 覆盖：刷新找回（清除 hidden + 保留装饰/颜色/变量）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRefreshedPartners } from "../lib/config.js";

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

test("mergeRefreshedPartners: 保留旧配置的颜色/变量/装饰", () => {
  const deco = {
    owned: { avatarFrame: ["avatar_star"], cardBg: [], title: [] },
    equipped: { avatarFrame: "avatar_star", cardBg: null, title: null },
  };
  const old = {
    hanako: { name: "小花", color: "#4CAF50", variables: { mood: 60 }, decorations: deco },
  };
  const scanned = {
    hanako: { name: "小花", color: "#999999", variables: { mood: 5 } },
  };
  const out = mergeRefreshedPartners(old, scanned);
  assert.equal(out.hanako.color, "#4CAF50", "旧颜色优先保留");
  assert.equal(out.hanako.variables.mood, 60, "旧变量优先保留");
  assert.deepEqual(out.hanako.decorations, deco, "装饰原样保留");
});

test("mergeRefreshedPartners: 无旧配置时用扫描结果，不报错", () => {
  const out = mergeRefreshedPartners(undefined, {
    newbie: { name: "新人", color: "#00BCD4", variables: { mood: 50 } },
  });
  assert.equal(out.newbie.name, "新人");
  assert.equal(out.newbie.hidden, undefined);
});
