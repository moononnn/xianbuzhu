// 闲不住展板活动刷新回归测试
// 直接从页面源码取出活动指纹函数，锁住“空闲随机文案不触发重绘、真实活动变化要刷新”的契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appSource = fs.readFileSync(
  path.join(process.cwd(), "public", "app.js"),
  "utf8",
);

function loadActivityComparator(initialPartners) {
  const start = appSource.indexOf("  function partnerActivitiesChanged");
  const end = appSource.indexOf("\n  function applyPolledBoardData", start);
  assert.ok(start >= 0 && end > start, "页面源码应包含活动比较函数");
  return new Function("initialPartners", `
    var state = { partners: initialPartners };
    ${appSource.slice(start, end)}
    return { partnerActivitiesChanged: partnerActivitiesChanged };
  `)(initialPartners);
}

test("活动指纹：空闲随机文案变化不触发重绘", () => {
  const comparator = loadActivityComparator([
    { id: "hanako", active: false, doing: "摸鱼中" },
  ]);
  assert.equal(
    comparator.partnerActivitiesChanged([
      { id: "hanako", active: false, doing: "换个姿势继续摸鱼" },
    ]),
    false,
  );
});

test("活动指纹：忙闲切换或忙碌话题变化会触发重绘", () => {
  const comparator = loadActivityComparator([
    { id: "hanako", active: true, doing: "正在和我讨论第一件事" },
  ]);
  assert.equal(
    comparator.partnerActivitiesChanged([
      { id: "hanako", active: true, doing: "正在和我讨论第二件事" },
    ]),
    true,
  );
  assert.equal(
    comparator.partnerActivitiesChanged([
      { id: "hanako", active: false, doing: "摸鱼中" },
    ]),
    true,
  );
});

test("页面刷新契约：打开/切回页面会请求强制活动刷新并暂停不可见轮询", () => {
  assert.match(appSource, /\/api\/data\?refreshActivity=1/);
  assert.match(appSource, /\/api\/current-agent\?refresh=1/);
  assert.match(appSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(appSource, /if \(document\.hidden \|\| lightPollInFlight\) return;/);
});
