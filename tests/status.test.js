// 闲不住伙伴状态衣柜测试
// 覆盖：公共状态池、伙伴专属状态、当前状态切换、有效期与输入收敛。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_STATUSES,
  PAID_PUBLIC_STATUS_IDS,
  STATUS_UNLOCK_COST,
  defaultData,
  getCurrentStatus,
  getPublicStatusCollection,
  getStatusCatalog,
  getStatusUpdateContext,
  normalizeDecorationState,
  setPartnerStatus,
  todayStr,
  unlockPublicStatus,
} from "../lib/data.js";

function fixture() {
  const data = defaultData();
  data.partnerConfig = { hanako: { name: "小花" } };
  return data;
}

function dateKeyOffset(offset) {
  const base = new Date(`${todayStr()}T12:00:00+08:00`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

test("状态衣柜：默认提供公共状态池，伙伴专属架从空开始", () => {
  const catalog = getStatusCatalog(fixture(), "hanako");
  assert.equal(catalog.publicStatuses.length, DEFAULT_PUBLIC_STATUSES.length);
  assert.ok(catalog.publicStatuses.some((item) => item.id === "brain-meeting"));
  assert.deepEqual(catalog.publicStatuses.find((item) => item.id === "leisurely").text, "悠哉哉");
  assert.deepEqual(catalog.customStatuses, []);
});

test("状态词池：公共状态收敛为短标签，旧定义跟随新文案并带语义色调", () => {
  const data = fixture();
  data.statusLibrary = {
    public: [
      { id: "quiet-work", text: "安静做事中", icon: "🌿", category: "日常" },
      { id: "brain-meeting", text: "脑内会议已失控", icon: "🧠", category: "整活" },
    ],
  };
  const catalog = getStatusCatalog(data, "hanako");
  const quiet = catalog.publicStatuses.find((item) => item.id === "quiet-work");
  const available = catalog.publicStatuses.find((item) => item.id === "available");
  const brain = catalog.publicStatuses.find((item) => item.id === "brain-meeting");
  assert.equal(quiet.text, "专注");
  assert.equal(quiet.tone, "focus");
  assert.equal(available.text, "有空");
  assert.equal(available.tone, "mint");
  assert.equal(brain.text, "脑内开会");
  assert.equal(brain.tone, "rose");
  assert.ok(catalog.publicStatuses.every((item) => item.text.length <= 4));
});

test("状态读取：已挂着的旧公共状态即时显示新版短标签", () => {
  const data = fixture();
  data.days[todayStr()] = {
    date: todayStr(),
    partners: {
      hanako: {
        status: {
          id: "quiet-work",
          text: "安静做事中",
          icon: "🌿",
          category: "日常",
          scope: "public",
          duration: "today",
          setAt: new Date().toISOString(),
          expiresAt: null,
        },
      },
    },
  };
  const current = getCurrentStatus(data, "hanako");
  assert.equal(current.text, "专注");
  assert.equal(current.tone, "focus");
  assert.equal(current.category, "做事");
});

test("状态收藏：高级状态按伙伴分别解锁，不能共享购买资格", () => {
  const data = fixture();
  data.partnerConfig.helper = { name: "伙伴" };
  const collection = getPublicStatusCollection(data, "hanako").filter((item) => item.unlockCost > 0);
  assert.deepEqual(collection.map((item) => item.id), PAID_PUBLIC_STATUS_IDS);
  assert.ok(collection.every((item) => item.unlockCost === STATUS_UNLOCK_COST));
  assert.ok(collection.every((item) => item.unlocked === false));

  data.jar = STATUS_UNLOCK_COST;
  const first = unlockPublicStatus(data, "hanako", PAID_PUBLIC_STATUS_IDS[0], 1770000000000);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyOwned, false);
  assert.equal(data.jar, 0);
  assert.equal(
    getPublicStatusCollection(data, "hanako").find((item) => item.id === PAID_PUBLIC_STATUS_IDS[0]).unlocked,
    true,
  );
  assert.equal(
    getPublicStatusCollection(data, "helper").find((item) => item.id === PAID_PUBLIC_STATUS_IDS[0]).unlocked,
    false,
    "小花的购买不能解锁其他伙伴",
  );
  assert.equal(
    getPublicStatusCollection(data).find((item) => item.id === PAID_PUBLIC_STATUS_IDS[0]).unlocked,
    false,
    "公共状态定义不能被改成全局已解锁",
  );

  const otherPartner = setPartnerStatus(data, "helper", { statusId: PAID_PUBLIC_STATUS_IDS[0] });
  assert.equal(otherPartner.ok, false, "其他伙伴仍需单独购买");
  const hanakoUse = setPartnerStatus(data, "hanako", { statusId: PAID_PUBLIC_STATUS_IDS[0] });
  assert.equal(hanakoUse.ok, true, "已购买伙伴可以换上自己的高级状态");

  const repeat = unlockPublicStatus(data, "hanako", PAID_PUBLIC_STATUS_IDS[0]);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.alreadyOwned, true);
  assert.equal(data.jar, 0, "重复解锁不应再次扣光粒");

  data.jar = STATUS_UNLOCK_COST * (PAID_PUBLIC_STATUS_IDS.length - 1);
  for (const statusId of PAID_PUBLIC_STATUS_IDS.slice(1)) unlockPublicStatus(data, "hanako", statusId);
  const completedCollection = getPublicStatusCollection(data, "hanako").filter((item) => item.unlockCost > 0);
  assert.equal(completedCollection.length, PAID_PUBLIC_STATUS_IDS.length, "全部解锁后仍应保留完整收藏列表");
  assert.ok(completedCollection.every((item) => item.unlocked === true));
  assert.ok(
    getPublicStatusCollection(data, "helper").filter((item) => item.unlockCost > 0).every((item) => item.unlocked === false),
    "其他伙伴的高级状态应全部保持未解锁",
  );
});

test("状态收藏：余额不足时不扣款，手动换锁定状态会被拒绝", () => {
  const data = fixture();
  data.jar = STATUS_UNLOCK_COST - 1;
  const unlock = unlockPublicStatus(data, "hanako", "brain-meeting");
  assert.equal(unlock.ok, false);
  assert.equal(data.jar, STATUS_UNLOCK_COST - 1);

  const manual = setPartnerStatus(data, "hanako", { statusId: "brain-meeting" });
  assert.equal(manual.ok, false);
  assert.match(manual.error, /装饰商店/);
});

test("状态收藏：自动临时状态不被付费锁拦住", () => {
  const data = fixture();
  const result = setPartnerStatus(data, "hanako", {
    statusId: "brain-meeting",
    source: "autonomous",
    persist: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.current.id, "brain-meeting");
});

test("卡面/称号装饰迁移：保留头像框，移除旧 cardBg 与称号字段", () => {
  assert.deepEqual(
    normalizeDecorationState({
      owned: { avatarFrame: ["avatar_star"], cardBg: ["bg_warm"], title: ["旧称号"] },
      equipped: { avatarFrame: "avatar_star", cardBg: "bg_warm", title: "旧称号" },
    }),
    {
      owned: { avatarFrame: ["avatar_star"] },
      equipped: { avatarFrame: "avatar_star" },
    },
  );
});

test("状态切换：可以换上公共状态，不把它误记成正在工作", () => {
  const data = fixture();
  const result = setPartnerStatus(data, "hanako", {
    statusId: "inspiration",
    duration: "until_changed",
  });
  assert.equal(result.ok, true);
  assert.equal(result.current.text, "灵感");
  assert.equal(result.current.scope, "public");
  assert.equal(result.current.duration, "until_changed");
  assert.equal(data.days[todayStr()].partners.hanako.contributed, false);
});

test("专属状态：第一次配入衣柜，之后按 ID 换上不会重复创建", () => {
  const data = fixture();
  const first = setPartnerStatus(data, "hanako", {
    text: "脑内施工中",
    icon: "🧠",
    category: "整活",
  });
  assert.equal(first.ok, true);
  const custom = getStatusCatalog(data, "hanako").customStatuses;
  assert.equal(custom.length, 1);
  assert.equal(custom[0].text, "脑内施工中");
  assert.equal(custom[0].scope, "custom");

  const second = setPartnerStatus(data, "hanako", {
    statusId: custom[0].id,
  });
  assert.equal(second.ok, true);
  assert.equal(second.current.id, custom[0].id);
  assert.equal(getStatusCatalog(data, "hanako").customStatuses.length, 1);
});

test("自动临时状态：不加入衣柜，衣柜已满时仍可展示", () => {
  const data = fixture();
  data.partnerConfig.hanako.customStatuses = Array.from({ length: 30 }, (_, index) => ({
    id: `custom-${index}`,
    text: `旧状态${index}`,
    icon: "✨",
    category: "自定义",
    scope: "custom",
  }));
  const result = setPartnerStatus(data, "hanako", {
    text: "根据当前活动临时挂着",
    icon: "📝",
    category: "做事",
    source: "autonomous",
    persist: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.current.source, "autonomous");
  assert.equal(data.partnerConfig.hanako.customStatuses.length, 30);
});

test("状态输入：换行被收敛，过期状态不再对外显示", () => {
  const data = fixture();
  const result = setPartnerStatus(data, "hanako", {
    text: `  第一行
第二行  `,
    icon: "✨",
  });
  assert.equal(result.ok, true);
  assert.equal(result.current.text, "第一行 第二行");

  data.days[todayStr()].partners.hanako.status.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(getCurrentStatus(data, "hanako"), null);
});

test("状态清除：只移除当前挂着的状态，专属状态仍保留在衣柜", () => {
  const data = fixture();
  setPartnerStatus(data, "hanako", { text: "暂时离开一下", icon: "🫧" });
  const result = setPartnerStatus(data, "hanako", { clear: true });
  assert.equal(result.ok, true);
  assert.equal(result.current, null);
  assert.equal(getStatusCatalog(data, "hanako").customStatuses.length, 1);
});

test("状态寿命：小时/直到换掉跨日沿用，今天状态不继承；新日无状态显示中性占位", () => {
  const data = fixture();
  const today = todayStr();
  const yesterday = dateKeyOffset(-1);
  const now = Date.parse(`${today}T06:00:00+08:00`);
  data.days[yesterday] = {
    date: yesterday,
    partners: {
      hanako: {
        status: {
          id: "inspiration",
          text: "昨天留下的灵感",
          icon: "💡",
          category: "心情",
          scope: "public",
          duration: "until_changed",
          setAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          expiresAt: null,
        },
      },
    },
  };

  const inherited = getCurrentStatus(data, "hanako", now);
  assert.equal(inherited.text, "灵感");
  assert.equal(inherited.duration, "until_changed");

  data.days[yesterday].partners.hanako.status = {
    id: "inspiration",
    text: "跨午夜的短状态",
    icon: "💡",
    category: "心情",
    scope: "public",
    duration: "four_hours",
    setAt: new Date(now - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  };
  assert.equal(getCurrentStatus(data, "hanako", now).text, "灵感");

  data.days[yesterday].partners.hanako.status.duration = "today";
  const baseline = getCurrentStatus(data, "hanako", now);
  assert.equal(baseline.id, "stay-a-while");
  assert.equal(baseline.source, "baseline");

  const contextData = fixture();
  const inheritedSetAt = new Date(now - 30 * 60 * 1000).toISOString();
  contextData.days[yesterday] = {
    date: yesterday,
    partners: {
      hanako: {
        status: {
          id: "inspiration",
          text: "冷却中的状态",
          icon: "💡",
          category: "心情",
          scope: "public",
          duration: "until_changed",
          setAt: inheritedSetAt,
          expiresAt: null,
        },
      },
    },
  };
  const inheritedContext = getStatusUpdateContext(contextData, "hanako", { now });
  assert.equal(inheritedContext.current.text, "灵感");
  assert.equal(inheritedContext.changesToday, 0);
  assert.equal(inheritedContext.reason, "cooldown");

  data.days[yesterday].partners.hanako.status = {
    id: "inspiration",
    text: "刚过期的短状态",
    icon: "💡",
    category: "心情",
    scope: "public",
    duration: "hour",
    setAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now - 60 * 60 * 1000).toISOString(),
  };
  assert.equal(getCurrentStatus(data, "hanako", now).source, "baseline");
});

test("状态寿命：手动清除会压住当天的默认占位和跨日继承", () => {
  const data = fixture();
  const now = Date.now();
  const result = setPartnerStatus(data, "hanako", { clear: true, now });
  assert.equal(result.ok, true);
  assert.equal(result.current, null);
  assert.equal(getCurrentStatus(data, "hanako", now), null);
  assert.equal(typeof data.days[todayStr()].partners.hanako.statusClearedAt, "string");
});

test("状态读取：显式空状态不会让更早的跨日状态复活", () => {
  const data = fixture();
  const yesterday = dateKeyOffset(-1);
  data.days[yesterday] = {
    date: yesterday,
    partners: {
      hanako: {
        status: {
          id: "inspiration",
          text: "旧状态",
          icon: "💡",
          category: "心情",
          scope: "public",
          duration: "until_changed",
          setAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          expiresAt: null,
        },
      },
    },
  };
  data.days[todayStr()] = {
    date: todayStr(),
    partners: { hanako: { status: null } },
  };
  assert.equal(getCurrentStatus(data, "hanako"), null);
});

test("状态联动：参考心情/精力/事件，并按 90 分钟与每日上限节流", () => {
  const data = fixture();
  data.partnerConfig.hanako.variables = { energy: 82, mood: 78, affection: 60 };
  const now = Date.now();
  const first = getStatusUpdateContext(data, "hanako", { now });
  assert.equal(first.canUpdate, true);
  assert.equal(first.reason, "new-day");
  assert.equal(first.moodText, "心情不错");
  assert.equal(first.energyText, "精力充沛");

  const set = setPartnerStatus(data, "hanako", {
    statusId: "inspiration",
    source: "partner",
    trigger: "conversation",
    now,
  });
  assert.equal(set.ok, true);
  assert.equal(data.days[todayStr()].partners.hanako.statusHistory.length, 1);

  const tooSoon = getStatusUpdateContext(data, "hanako", {
    now: now + 30 * 60 * 1000,
    conversationMeaningful: true,
  });
  assert.equal(tooSoon.canUpdate, false);
  assert.equal(tooSoon.reason, "cooldown");

  const routineTooSoon = getStatusUpdateContext(data, "hanako", {
    now: now + 2 * 60 * 60 * 1000,
  });
  assert.equal(routineTooSoon.canUpdate, false);
  assert.equal(routineTooSoon.reason, "not-due");

  const activityDue = getStatusUpdateContext(data, "hanako", {
    now: now + 2 * 60 * 60 * 1000,
    activityChanged: true,
  });
  assert.equal(activityDue.canUpdate, true);
  assert.equal(activityDue.reason, "activity-change");

  data.days[todayStr()].partners.hanako.events = [{
    type: "gift",
    itemName: "咖啡",
    ts: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  }];
  const eventDue = getStatusUpdateContext(data, "hanako", {
    now: now + 2 * 60 * 60 * 1000,
  });
  assert.equal(eventDue.canUpdate, true);
  assert.equal(eventDue.reason, "event");

  const softData = fixture();
  const softDay = softData.days[todayStr()] = { partners: {} };
  softDay.partners.hanako = {
    contributed: false,
    narrative: "",
    effortLP: 0,
    statusHistory: [0, 1, 2].map((index) => ({
      id: "inspiration",
      text: "灵感冒头",
      setAt: new Date(now - (index + 2) * 2 * 60 * 60 * 1000).toISOString(),
      moodBand: "steady",
      energyBand: "normal",
    })),
  };
  const soft = getStatusUpdateContext(softData, "hanako", { now });
  assert.equal(soft.canUpdate, false);
  assert.equal(soft.reason, "soft-limit");
  const strong = getStatusUpdateContext(softData, "hanako", {
    now,
    conversationMeaningful: true,
  });
  assert.equal(strong.canUpdate, true);

  softDay.partners.hanako.statusHistory.push(
    { id: "quiet-work", text: "安静做事中", setAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
    { id: "stay-a-while", text: "想静静待一会", setAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
  );
  const hard = getStatusUpdateContext(softData, "hanako", {
    now,
    conversationMeaningful: true,
  });
  assert.equal(hard.canUpdate, false);
  assert.equal(hard.reason, "daily-limit");
});
