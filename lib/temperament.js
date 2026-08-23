// lib/temperament.js — 双层性格与渐进披露
// 这里故意只放纯函数和内置气质参数：不读盘、不调模型、不碰 UI，方便回归测试。

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESETS = Object.freeze({
  大方: Object.freeze({
    forgetDays: 2,
    frequencyWeight: 1.15,
    replyWarmth: 0.72,
    replyGain: 1,
    style: "随口接话",
  }),
  敏感: Object.freeze({
    forgetDays: 5,
    frequencyWeight: 0.78,
    replyWarmth: 0.86,
    replyGain: 2,
    style: "会把话放在心里",
  }),
  冷淡: Object.freeze({
    forgetDays: 3,
    frequencyWeight: 0.72,
    replyWarmth: 0.44,
    replyGain: 1,
    style: "话少克制",
  }),
  温柔: Object.freeze({
    forgetDays: 3,
    frequencyWeight: 1,
    replyWarmth: 0.82,
    replyGain: 1,
    style: "细腻自然",
  }),
  热情: Object.freeze({
    forgetDays: 2,
    frequencyWeight: 1.2,
    replyWarmth: 0.95,
    replyGain: 1,
    style: "热络直接",
  }),
  "边界感强": Object.freeze({
    forgetDays: 4,
    frequencyWeight: 0.8,
    replyWarmth: 0.64,
    replyGain: 1,
    style: "亲近但有分寸",
  }),
});

const OPTION_DESCRIPTIONS = Object.freeze({
  大方: "看起来好相处，心里装得下很多事",
  敏感: "表面平静，细小的事也会放在心上",
  冷淡: "初见话少，熟悉以后才慢慢松开",
  温柔: "说话有分寸，愿意把心意放得轻一点",
  热情: "一见面就热络，想到什么会直接说",
  "边界感强": "愿意亲近，但总保留自己的分寸",
});

const HEART_RHYTHM_OPTIONS = Object.freeze({
  auto: Object.freeze({
    label: "随她自己",
    description: "按她的设定和相处状态自然变化",
  }),
  quiet: Object.freeze({
    label: "安静一点",
    description: "更少打扰，心意更轻，表达更克制",
  }),
  open: Object.freeze({
    label: "更容易想起你",
    description: "更常留下心意，表达也会更打开",
  }),
});

const HEART_RHYTHM_ADJUSTMENTS = Object.freeze({
  auto: Object.freeze({
    frequencyMultiplier: 1,
    warmthDelta: 0,
    sceneChanceDelta: 0,
    hint: "按自己的性子留下这份心意。",
  }),
  quiet: Object.freeze({
    frequencyMultiplier: 0.86,
    warmthDelta: -0.06,
    sceneChanceDelta: 0.1,
    hint: "表达轻一点，少说几句，留下一个具体的小痕迹。",
  }),
  open: Object.freeze({
    frequencyMultiplier: 1.14,
    warmthDelta: 0.07,
    sceneChanceDelta: -0.05,
    hint: "可以更主动、更直接一点，但不要催促对方回应。",
  }),
});

export const TEMPERAMENT_TAGS = Object.freeze(Object.keys(PRESETS));
export const HEART_RHYTHM_TAGS = Object.freeze(Object.keys(HEART_RHYTHM_OPTIONS));

export function normalizeHeartRhythm(value) {
  return HEART_RHYTHM_TAGS.includes(value) ? value : "auto";
}

export function getHeartRhythmOptions() {
  return HEART_RHYTHM_TAGS.map((id) => ({ id, ...HEART_RHYTHM_OPTIONS[id] }));
}
export const DISCLOSURE_MIN_AFFECTION = -20;
export const DISCLOSURE_MAX_AFFECTION = 100;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function getTemperamentPreset(tag) {
  return PRESETS[TEMPERAMENT_TAGS.includes(tag) ? tag : "温柔"];
}

export function getTemperamentOptions() {
  return TEMPERAMENT_TAGS.map((tag) => ({
    tag,
    description: OPTION_DESCRIPTIONS[tag],
  }));
}

export function normalizeLayer(layer, fallbackTag = "温柔") {
  const safeFallback = TEMPERAMENT_TAGS.includes(fallbackTag) ? fallbackTag : "温柔";
  const tag = TEMPERAMENT_TAGS.includes(layer?.tag) ? layer.tag : safeFallback;
  const preset = getTemperamentPreset(tag);
  const params = layer?.params && typeof layer.params === "object" ? layer.params : {};
  return {
    tag,
    params: {
      forgetDays: clamp(finiteOr(params.forgetDays, preset.forgetDays), 1, 14),
      frequencyWeight: clamp(
        finiteOr(params.frequencyWeight, preset.frequencyWeight),
        0.4,
        1.8,
      ),
      replyWarmth: clamp(finiteOr(params.replyWarmth, preset.replyWarmth), 0, 1),
      replyGain: clamp(Math.round(finiteOr(params.replyGain, preset.replyGain)), 1, 3),
      style: typeof params.style === "string" && params.style.trim()
        ? params.style.trim().slice(0, 40)
        : preset.style,
    },
  };
}

export function createTemperamentConfig(surfaceTag = "温柔", innerTag = "温柔", source = "fallback") {
  return {
    surfaceLayer: normalizeLayer({ tag: surfaceTag }),
    innerLayer: normalizeLayer({ tag: innerTag }),
    temperamentSource: source,
    temperamentAnalyzedAt: null,
    heartRhythm: "auto",
  };
}

export function inferTemperamentTags(description = "") {
  const text = String(description || "").toLowerCase();
  let surface = "温柔";
  let inner = "温柔";

  if (/冷淡|冷静|理性|克制|安静|傲娇/.test(text)) surface = "冷淡";
  else if (/热情|活泼|开朗|外向|爽快/.test(text)) surface = "热情";
  else if (/大方|随和|直率/.test(text)) surface = "大方";

  if (/敏感|细腻|在意|心思重|容易受伤/.test(text)) inner = "敏感";
  else if (/边界|分寸|原则|界限/.test(text)) inner = "边界感强";
  else if (/冷淡|理性|克制/.test(text)) inner = "温柔";
  else if (/热情|黏人|直球/.test(text)) inner = "热情";

  return { surface, inner };
}

export function normalizeTemperamentConfig(config, description = "") {
  const inferred = inferTemperamentTags(description);
  const out = config && typeof config === "object" ? config : {};
  const surfaceFallback = TEMPERAMENT_TAGS.includes(out.surfaceLayer?.tag)
    ? out.surfaceLayer.tag
    : inferred.surface;
  const innerFallback = TEMPERAMENT_TAGS.includes(out.innerLayer?.tag)
    ? out.innerLayer.tag
    : inferred.inner;
  return {
    surfaceLayer: normalizeLayer(out.surfaceLayer, surfaceFallback),
    innerLayer: normalizeLayer(out.innerLayer, innerFallback),
    temperamentSource: ["fallback", "llm", "user"].includes(out.temperamentSource)
      ? out.temperamentSource
      : "fallback",
    temperamentAnalyzedAt: out.temperamentAnalyzedAt || null,
    heartRhythm: normalizeHeartRhythm(out.heartRhythm),
  };
}

// 好感度 → 披露比例。smoothstep 让边界不突兀，且永远落在 0~1。
export function disclosureRatio(affection) {
  const raw = (finiteOr(affection, 0) - DISCLOSURE_MIN_AFFECTION)
    / (DISCLOSURE_MAX_AFFECTION - DISCLOSURE_MIN_AFFECTION);
  const t = clamp(raw, 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function effectiveTemperament(config, affection) {
  const normalized = normalizeTemperamentConfig(config);
  const surface = normalized.surfaceLayer;
  const inner = normalized.innerLayer;
  const disclosure = disclosureRatio(affection);
  const rhythm = normalizeHeartRhythm(normalized.heartRhythm);
  const rhythmAdjustment = HEART_RHYTHM_ADJUSTMENTS[rhythm];
  const baseFrequencyWeight = lerp(
    surface.params.frequencyWeight,
    inner.params.frequencyWeight,
    disclosure,
  );
  const baseReplyWarmth = lerp(
    surface.params.replyWarmth,
    inner.params.replyWarmth,
    disclosure,
  );
  return {
    disclosure,
    surfaceTag: surface.tag,
    innerTag: inner.tag,
    tag: disclosure < 0.5 ? surface.tag : inner.tag,
    forgetDays: lerp(surface.params.forgetDays, inner.params.forgetDays, disclosure),
    frequencyWeight: clamp(baseFrequencyWeight * rhythmAdjustment.frequencyMultiplier, 0.4, 1.8),
    replyWarmth: clamp(baseReplyWarmth + rhythmAdjustment.warmthDelta, 0, 1),
    replyGain: Math.max(
      1,
      Math.round(lerp(surface.params.replyGain, inner.params.replyGain, disclosure)),
    ),
    style: disclosure < 0.5 ? surface.params.style : inner.params.style,
    rhythm,
    rhythmLabel: HEART_RHYTHM_OPTIONS[rhythm].label,
    rhythmHint: rhythmAdjustment.hint,
    sceneChance: clamp(0.3 + rhythmAdjustment.sceneChanceDelta, 0.15, 0.5),
  };
}

export function calculateHeartExpiry(createdAt, temperament, now = Date.now()) {
  const start = new Date(createdAt).getTime();
  const base = Number.isFinite(start) ? start : now;
  const days = clamp(finiteOr(temperament?.forgetDays, 3), 1, 14);
  return new Date(base + days * DAY_MS).toISOString();
}

export function isExpiredAt(expiresAt, now = Date.now()) {
  const ts = new Date(expiresAt).getTime();
  return Number.isFinite(ts) && ts <= now;
}

export function frequencyProfile(frequency) {
  if (frequency === "high") {
    return { dailyChance: 0.95, maxPerPartner: 2, label: "多一点" };
  }
  if (frequency === "medium") {
    return { dailyChance: 0.58, maxPerPartner: 1, label: "刚刚好" };
  }
  return { dailyChance: 0.24, maxPerPartner: 1, label: "偶尔" };
}

export function clampChance(value) {
  return clamp(finiteOr(value, 0), 0, 1);
}

export function dayMs() {
  return DAY_MS;
}
