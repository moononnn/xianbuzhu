// 双层性格与渐进披露纯函数测试
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateHeartExpiry,
  createTemperamentConfig,
  disclosureRatio,
  getHeartRhythmOptions,
  effectiveTemperament,
  getTemperamentOptions,
  isExpiredAt,
  normalizeHeartRhythm,
  normalizeTemperamentConfig,
} from "../lib/temperament.js";

test("disclosureRatio: 好感越深披露越多，边界稳定", () => {
  assert.equal(disclosureRatio(-20), 0);
  assert.equal(disclosureRatio(100), 1);
  assert.ok(disclosureRatio(20) > disclosureRatio(0));
  assert.ok(disclosureRatio(80) > disclosureRatio(20));
  assert.ok(disclosureRatio(50) > 0 && disclosureRatio(50) < 1);
});

test("effectiveTemperament: 参数在表层和里层之间平滑插值", () => {
  const cfg = createTemperamentConfig("冷淡", "热情", "user");
  const surface = effectiveTemperament(cfg, -20);
  const inner = effectiveTemperament(cfg, 100);
  const middle = effectiveTemperament(cfg, 40);
  assert.equal(surface.tag, "冷淡");
  assert.equal(inner.tag, "热情");
  assert.ok(middle.replyWarmth > surface.replyWarmth);
  assert.ok(middle.replyWarmth < inner.replyWarmth);
  assert.ok(middle.forgetDays > 0);
});

test("normalizeTemperamentConfig: 旧数据和脏标签回到可用默认值", () => {
  const normalized = normalizeTemperamentConfig({
    surfaceLayer: { tag: "不存在" },
    innerLayer: { tag: "敏感" },
  });
  assert.equal(normalized.surfaceLayer.tag, "温柔");
  assert.equal(normalized.innerLayer.tag, "敏感");
  assert.ok(normalized.surfaceLayer.params.forgetDays > 0);
});

test("calculateHeartExpiry/isExpiredAt: 过期时间按当前披露层计算", () => {
  const created = "2026-08-18T00:00:00.000Z";
  const expiry = calculateHeartExpiry(created, { forgetDays: 3 });
  assert.equal(expiry, "2026-08-21T00:00:00.000Z");
  assert.equal(isExpiredAt(expiry, Date.parse("2026-08-20T23:59:59.000Z")), false);
  assert.equal(isExpiredAt(expiry, Date.parse("2026-08-21T00:00:00.000Z")), true);
});

test("getTemperamentOptions: 只暴露人话标签，不暴露参数组", () => {
  const options = getTemperamentOptions();
  assert.ok(options.length >= 4);
  assert.ok(options.every((item) => item.tag && item.description));
  assert.ok(options.every((item) => !Object.hasOwn(item, "forgetDays")));
});

test("心意节奏: 默认随助手自己，用户微调同时改变频率和表达温度", () => {
  const auto = effectiveTemperament(createTemperamentConfig("温柔", "温柔"), 20);
  const quietConfig = createTemperamentConfig("温柔", "温柔");
  quietConfig.heartRhythm = "quiet";
  const openConfig = createTemperamentConfig("温柔", "温柔");
  openConfig.heartRhythm = "open";
  const quiet = effectiveTemperament(quietConfig, 20);
  const open = effectiveTemperament(openConfig, 20);
  assert.equal(auto.rhythm, "auto");
  assert.equal(normalizeHeartRhythm("bad"), "auto");
  assert.ok(quiet.frequencyWeight < auto.frequencyWeight);
  assert.ok(open.frequencyWeight > auto.frequencyWeight);
  assert.ok(quiet.replyWarmth < auto.replyWarmth);
  assert.ok(open.replyWarmth > auto.replyWarmth);
  assert.equal(getHeartRhythmOptions().length, 3);
});
