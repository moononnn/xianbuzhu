// lib/preferences.js — 助手主动心意的自动偏好
// 偏好只由助手设定与气质推断，不提供用户逐项选择；结果只影响抽样，不暴露参数。
// 具体现场已改为开放情境，sceneIds 只保留兼容契约，不再指向固定物件。
const CONTEXTUAL_SCENE_ID = "contextual-moment";
const TAG_DEFAULTS = Object.freeze({
  大方: Object.freeze({ gifts: ["coffee", "bouquet"], scenes: [CONTEXTUAL_SCENE_ID] }),
  敏感: Object.freeze({ gifts: ["flower", "moon"], scenes: [CONTEXTUAL_SCENE_ID] }),
  冷淡: Object.freeze({ gifts: ["tea", "moon"], scenes: [CONTEXTUAL_SCENE_ID] }),
  温柔: Object.freeze({ gifts: ["tea", "flower"], scenes: [CONTEXTUAL_SCENE_ID] }),
  热情: Object.freeze({ gifts: ["coffee", "cookies", "bouquet"], scenes: [CONTEXTUAL_SCENE_ID] }),
  "边界感强": Object.freeze({ gifts: ["tea", "star"], scenes: [CONTEXTUAL_SCENE_ID] }),
});

function appendUnique(target, values, limit) {
  for (const value of values || []) {
    if (!target.includes(value)) target.push(value);
    if (target.length >= limit) break;
  }
}

export function deriveHeartPreferences({ description = "", temperamentTag = "" } = {}) {
  const text = String(description || "").toLowerCase();
  const gifts = [];
  const scenes = [];

  // 只认明确线索；没有线索时由气质提供很轻的默认倾向。
  if (/咖啡|咖啡豆|提神|熬夜/.test(text)) appendUnique(gifts, ["coffee"], 4);
  if (/茶|热茶|饮品|喝水/.test(text)) appendUnique(gifts, ["tea"], 4);
  if (/饼干|曲奇|零食|甜食|吃东西/.test(text)) appendUnique(gifts, ["cookie", "cookies"], 4);
  if (/花|植物|茉莉|园艺|花瓶/.test(text)) appendUnique(gifts, ["flower", "bouquet"], 4);
  if (/星星|月亮|灯|光|夜/.test(text)) appendUnique(gifts, ["star", "moon"], 4);
  const defaults = TAG_DEFAULTS[temperamentTag];
  if (defaults) {
    appendUnique(gifts, defaults.gifts, 4);
    appendUnique(scenes, defaults.scenes, 3);
  }

  return { giftIds: gifts, sceneIds: scenes };
}

export function choosePreferredItems(items, preferredIds = [], recentIds = []) {
  const valid = (items || []).filter((item) => item?.id && item?.name);
  if (!valid.length) return [];

  const recent = new Set(Array.isArray(recentIds) ? recentIds : []);
  const fresh = valid.filter((item) => !recent.has(item.id));
  const base = fresh.length ? fresh : valid;
  const preferred = new Set(Array.isArray(preferredIds) ? preferredIds : []);
  const preferredFresh = base.filter((item) => preferred.has(item.id));
  return preferredFresh.length ? preferredFresh : base;
}
