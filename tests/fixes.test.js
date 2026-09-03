// 闲不住 — 2026-08-02 工程审查修复的回归测试（node:test）
// 覆盖：.bak 备份时序、状态阈值统一（sense-state ↔ data.js）、
//       助手 ID 输入白名单、用户名清洗
// 运行：node --test tests/fixes.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── 共享临时 HANA_HOME：sense-state 内部 import 的无 query data.js 只加载一次，
//     目录在文件级固定，各测试串行写入不同数据，互不干扰 ───
const SHARED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-fix-"));
process.env.HANA_HOME = SHARED_HOME;
const SHARED_DATA_DIR = path.join(SHARED_HOME, "data", "work-visit");

// 北京时间今天的 YYYY-MM-DD（避免每日重置触发 mood 随机漂移干扰断言）
function bjToday() {
  return new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10);
}

function writeSharedData(partnerConfig) {
  fs.mkdirSync(SHARED_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SHARED_DATA_DIR, "data.json"),
    JSON.stringify({
      days: {},
      lastResetDate: bjToday(),
      partnerConfig,
    }),
    "utf-8",
  );
}

// ─── 辅助：临时 HANA_HOME 下动态加载模块（query 参数绕过 ESM 缓存） ───
async function freshDataModule(tmpHome) {
  const prev = process.env.HANA_HOME;
  process.env.HANA_HOME = tmpHome;
  try {
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    return await import("../lib/data.js?v=" + stamp);
  } finally {
    process.env.HANA_HOME = prev; // 异常也必须还原，避免污染后续测试
  }
}

// ════════════════════════════════════════════
//  1. .bak 备份时序（回归：曾先 rename 再 copy，导致 .bak == 当前内容）
// ════════════════════════════════════════════

test(".bak: 第二次写入后 .bak 保留上一次成功写入的内容", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-bak-"));
  const { saveData, loadData } = await freshDataModule(tmpHome);
  const dataFile = path.join(tmpHome, "data", "work-visit", "data.json");
  const bakFile = dataFile + ".bak";

  // 第一次写入：无旧文件，不产生 .bak
  saveData({ jar: 1, days: {}, partnerConfig: {} });
  assert.equal(loadData().jar, 1);
  assert.ok(!fs.existsSync(bakFile), "首次写入不应产生 .bak");

  // 第二次写入：.bak 应为第一次的内容（jar=1），当前文件为第二次（jar=2）
  saveData({ jar: 2, days: {}, partnerConfig: {} });
  assert.equal(loadData().jar, 2);
  assert.ok(fs.existsSync(bakFile), ".bak 应存在");
  const bak = JSON.parse(fs.readFileSync(bakFile, "utf-8"));
  assert.equal(bak.jar, 1, ".bak 必须是上一次成功写入的内容，而不是当前内容");

  // 第三次写入后 .bak 更新为 jar=2
  saveData({ jar: 3, days: {}, partnerConfig: {} });
  const bak2 = JSON.parse(fs.readFileSync(bakFile, "utf-8"));
  assert.equal(bak2.jar, 2);
});

test(".bak: 损坏时能回退读取 .bak", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-bak2-"));
  const { saveData, loadData } = await freshDataModule(tmpHome);
  const dataFile = path.join(tmpHome, "data", "work-visit", "data.json");

  saveData({ jar: 5, days: {}, partnerConfig: {} });
  saveData({ jar: 6, days: {}, partnerConfig: {} });
  // 故意写坏当前文件（非法 JSON）
  fs.writeFileSync(dataFile, "{ broken json !!!", "utf-8");
  const recovered = loadData();
  assert.equal(recovered.jar, 5, "损坏时应从 .bak 回退到上一次完好版本");
});

test("loadData: 旧卡面/称号装饰迁移时保留头像框、清掉已下架分类", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-deco-migrate-"));
  const { loadData } = await freshDataModule(tmpHome);
  const dataDir = path.join(tmpHome, "data", "work-visit");
  const dataFile = path.join(dataDir, "data.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    jar: 1000,
    lastResetDate: bjToday(),
    decorationItems: [
      { id: "avatar_star", type: "avatarFrame", name: "星光头像框", icon: "⭐", price: 500 },
      { id: "bg_warm", type: "cardBg", name: "暖白卡面", icon: "🌾", price: 500 },
      { id: "title", type: "title", name: "自定义称号", icon: "🏷️", price: 500 },
      { id: "title_edit", type: "titleEdit", name: "改称号卡", icon: "✏️", price: 300 },
    ],
    partnerConfig: {
      hanako: {
        name: "小花",
        decorations: {
          owned: { avatarFrame: ["avatar_star"], cardBg: ["bg_warm"], title: ["旧称号"] },
          equipped: { avatarFrame: "avatar_star", cardBg: "bg_warm", title: "旧称号" },
        },
      },
    },
  }), "utf-8");

  const data = loadData();
  assert.deepEqual(data.partnerConfig.hanako.decorations, {
    owned: { avatarFrame: ["avatar_star"] },
    equipped: { avatarFrame: "avatar_star" },
  });
  assert.ok(!data.decorationItems.some((item) => item.type === "cardBg" || item.type === "title" || item.type === "titleEdit" || item.id === "bg_warm"));
  const persisted = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
  assert.deepEqual(persisted.partnerConfig.hanako.decorations, data.partnerConfig.hanako.decorations);
  assert.ok(!persisted.decorationItems.some((item) => item.type === "cardBg" || item.type === "title" || item.type === "titleEdit"));
});

// ════════════════════════════════════════════
//  2. 状态阈值统一（回归：sense-state 曾用 60/41/21，与 data.js 的 65/40/25 不一致）
// ════════════════════════════════════════════

test("sense-state: 心情阈值与 describeMood 一致（64 是平稳档，65 是不错档）", async () => {
  writeSharedData({
    hanako: { name: "小花", variables: { mood: 64, energy: 41, affection: 30 } },
  });

  const { execute } = await import("../tools/sense-state.js?v=" + Date.now());
  const res = await execute({}, { agentId: "hanako" });
  const text = JSON.parse(res.content[0].text).state;

  // mood=64 → "说不上特别好，但也还行"（40 档）；若仍用 60 阈值会错误进入"心情还不错"
  assert.ok(
    text.includes("说不上特别好"),
    "mood=64 应落在平稳档（40≤mood<65），实际输出: " + text,
  );
  assert.ok(!text.includes("心情还不错"), "mood=64 不应判成不错档");
  // energy=41 → 统一后 41≥40 仍是"不算太累"（旧阈值 41 恰好卡边界，验证不破坏）
  assert.ok(text.includes("不算太累"), "energy=41 应为还行档，实际输出: " + text);
});

test("sense-state: mood=65 进入不错档，energy=39 进入疲惫档", async () => {
  writeSharedData({
    hanako: { name: "小花", variables: { mood: 65, energy: 39, affection: 30 } },
  });

  const { execute } = await import("../tools/sense-state.js?v=" + Date.now());
  const res = await execute({}, { agentId: "hanako" });
  const text = JSON.parse(res.content[0].text).state;
  assert.ok(text.includes("心情还不错"), "mood=65 应为不错档，实际输出: " + text);
  assert.ok(text.includes("有一点疲惫感"), "energy=39 应为疲惫档，实际输出: " + text);
});

// ════════════════════════════════════════════
//  3. 助手 ID 输入白名单（回归：to/partner 曾只查类型和长度）
// ════════════════════════════════════════════

test("isValidAgentId: 正常助手 ID 通过", async () => {
  const { isValidAgentId } = await import(
    "../lib/validate.js?v=" + Date.now()
  );
  assert.equal(isValidAgentId("hanako"), true);
  assert.equal(isValidAgentId("helperA"), true);
  assert.equal(isValidAgentId("a-b_c1"), true);
});

test("isValidAgentId: 路径穿越/原型污染/脏输入被拒绝", async () => {
  const { isValidAgentId } = await import(
    "../lib/validate.js?v=" + Date.now()
  );
  assert.equal(isValidAgentId("../etc/passwd"), false);
  assert.equal(isValidAgentId(".."), false);
  assert.equal(isValidAgentId("__proto__"), false);
  assert.equal(isValidAgentId("constructor"), false);
  assert.equal(isValidAgentId("prototype"), false);
  assert.equal(isValidAgentId("a b"), false);
  assert.equal(isValidAgentId("中文"), false);
  assert.equal(isValidAgentId(""), false);
  assert.equal(isValidAgentId("a".repeat(101)), false);
  assert.equal(isValidAgentId(null), false);
  assert.equal(isValidAgentId(123), false);
});

// ════════════════════════════════════════════
//  4. 用户名清洗（限长 + 去控制字符）
// ════════════════════════════════════════════

test("sanitizeUserName: 限长 30 + 去控制字符 + 空值兜底", async () => {
  const { sanitizeUserName } = await import(
    "../lib/llm.js?v=" + Date.now()
  );
  assert.equal(sanitizeUserName("x".repeat(50)), "x".repeat(30));
  assert.equal(sanitizeUserName("ab\u0000\u0007cd"), "abcd");
  assert.equal(sanitizeUserName("   "), "未知用户");
  assert.equal(sanitizeUserName(""), "未知用户");
  assert.equal(sanitizeUserName(null), "未知用户");
  assert.equal(sanitizeUserName("  张三  "), "张三");
});

// ════════════════════════════════════════════
//  5. 装饰接口原型污染防护（回归：target="__proto__" 曾可污染 Object.prototype）
// ════════════════════════════════════════════

test("buy-decoration: target=__proto__ 被白名单拦截，Object.prototype 不被污染", async () => {
  // 显式写入带 jar 的数据：保证越过光粒检查，真正走到 partnerCfg 写入路径，
  // 否则光粒不足会先拦截，测试变成假阳性（删掉校验也能过）
  fs.mkdirSync(SHARED_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SHARED_DATA_DIR, "data.json"),
    JSON.stringify({
      days: {},
      lastResetDate: bjToday(),
      jar: 1000,
      partnerConfig: {
        hanako: { name: "小花", variables: { mood: 60, energy: 60, affection: 10 } },
      },
    }),
    "utf-8",
  );

  // 注册路由并模拟一次恶意请求
  const routes = {};
  const app = {
    get: (p, h) => {
      routes[p] = h;
    },
    post: (p, h) => {
      routes[p] = h;
    },
  };
  const { register } = await import("../routes/api.js?v=" + Date.now());
  await register(app, {});

  const c = {
    req: {
      json: async () => ({
        decorationId: "avatar_flower",
        target: "__proto__",
      }),
    },
  };
  const res = await routes["/api/buy-decoration"](c);
  const body = JSON.parse(await res.text());
  assert.equal(body.success, false, "__proto__ 应被拒绝");
  assert.equal(
    Object.prototype.decorations,
    undefined,
    "Object.prototype 不应被污染",
  );
});

test("unlock-status: 高级状态按伙伴分别购买，重复请求幂等", async () => {
  fs.writeFileSync(
    path.join(SHARED_DATA_DIR, "data.json"),
    JSON.stringify({
      days: {},
      lastResetDate: bjToday(),
      jar: 800,
      partnerConfig: {
        hanako: { name: "小花", variables: { mood: 60, energy: 60, affection: 10 } },
        helper: { name: "伙伴", variables: { mood: 60, energy: 60, affection: 10 } },
      },
    }),
    "utf-8",
  );
  const routes = {};
  const getRoutes = {};
  const app = {
    get: (p, h) => { getRoutes[p] = h; },
    post: (p, h) => { routes[p] = h; },
  };
  const { register } = await import("../routes/api.js?v=" + Date.now());
  await register(app, {});

  const request = { req: { json: async () => ({ partnerId: "hanako", statusId: "sorting-things" }) } };
  const first = JSON.parse(await (await routes["/api/unlock-status"](request)).text());
  assert.equal(first.success, true);
  assert.equal(first.jar, 0);
  assert.equal(first.status.unlocked, true);
  const other = JSON.parse(await (await getRoutes["/api/statuses"]({ req: { query: () => "helper" } })).text());
  assert.equal(other.publicStatuses.find((item) => item.id === "sorting-things").unlocked, false);

  const second = JSON.parse(await (await routes["/api/unlock-status"](request)).text());
  assert.equal(second.success, true);
  assert.equal(second.alreadyOwned, true);
  assert.equal(second.jar, 0, "重复请求不能再次扣款");
});

test("unlock-status: 写盘失败时不把扣款和解锁留在内存或磁盘", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-unlock-fail-"));
  try {
    const dataDir = path.join(temp, "data", "work-visit");
    const dataFile = path.join(dataDir, "data.json");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify({
      days: {},
      lastResetDate: bjToday(),
      jar: 800,
      partnerConfig: { hanako: { name: "小花" } },
    }), "utf-8");
    // saveData 的临时目标被目录占用，模拟写盘失败；原 data.json 仍可读。
    fs.mkdirSync(dataFile + ".tmp");
    const script = `
      const routes = {};
      const app = { get(p, h) { routes[p] = h; }, post(p, h) { routes[p] = h; } };
      const { default: register } = await import('./routes/api.js');
      await register(app, {});
      const response = await routes['/api/unlock-status']({ req: { json: async () => ({ partnerId: 'hanako', statusId: 'sorting-things' }) } });
      const body = JSON.parse(await response.text());
      const buyResponse = await routes['/api/buy-decoration']({ req: { json: async () => ({ decorationId: 'avatar_star', target: 'hanako' }) } });
      const buyBody = JSON.parse(await buyResponse.text());
      const { loadData } = await import('./lib/data.js');
      const after = loadData();
      const status = after.statusLibrary.public.find((item) => item.id === 'sorting-things');
      console.log(JSON.stringify({ body, buyBody, jar: after.jar, unlocked: status.unlocked, partnerUnlocks: after.partnerConfig.hanako.unlockedStatuses, decorations: after.partnerConfig.hanako.decorations }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, HANA_HOME: temp },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(output.body.success, false);
    assert.equal(output.body.error, "状态收藏保存失败，请重试");
    assert.equal(output.buyBody.success, false, "装饰写盘失败也不能谎报成功");
    assert.equal(output.jar, 800, "写盘失败不能扣掉磁盘上的光粒");
    assert.equal(output.unlocked, false, "写盘失败不能留下全局解锁状态");
    // 磁盘数据经 loadData 迁移后可能补了空数组，但绝不能带上解锁记录。
    assert.ok(Array.isArray(output.partnerUnlocks) ? output.partnerUnlocks.length === 0 : output.partnerUnlocks === undefined,
      "写盘失败不能留下伙伴解锁结果");
    assert.equal(output.decorations, undefined, "装饰写盘失败不能留下购买结果");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
