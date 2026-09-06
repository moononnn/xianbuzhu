// 主动心意自动偏好：只从助手设定推断，不提供逐项用户选择
import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePreferredItems, deriveHeartPreferences } from "../lib/preferences.js";

test("deriveHeartPreferences: 明确设定线索优先加入对应心意类型", () => {
  const preferences = deriveHeartPreferences({
    description: "喜欢咖啡、花和安静的夜晚，偶尔会画便签。",
    temperamentTag: "温柔",
  });
  assert.ok(preferences.giftIds.includes("coffee"));
  assert.ok(preferences.giftIds.includes("flower"));
  assert.deepEqual(preferences.sceneIds, ["contextual-moment"]);
});

test("deriveHeartPreferences: 没有明确线索时由气质提供有限默认倾向", () => {
  const preferences = deriveHeartPreferences({ temperamentTag: "冷淡" });
  assert.deepEqual(preferences.giftIds, ["tea", "moon"]);
  assert.deepEqual(preferences.sceneIds, ["contextual-moment"]);
});

test("choosePreferredItems: 偏好是软倾向，最近出现的类型先冷却", () => {
  const items = [
    { id: "coffee", name: "咖啡" },
    { id: "tea", name: "热茶" },
    { id: "flower", name: "一枝花" },
  ];
  assert.deepEqual(
    choosePreferredItems(items, ["flower"], []).map((item) => item.id),
    ["flower"],
  );
  assert.deepEqual(
    choosePreferredItems(items, ["flower"], ["flower"]).map((item) => item.id),
    ["coffee", "tea"],
  );
});
