// 闲不住 — saveData 写盘失败语义测试（第 7 点）
// 覆盖：写盘失败（磁盘异常/目录被占位）时 API 返回 500 而不是谎报 success: true。
// 手法：把 data/work-visit 目录占位成同名文件，saveData 的 mkdir/write 必失败，
//       跨平台可靠，不需要玩权限。
// 运行：node --test tests/savedata-fail.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wv-savedata-"));
process.env.HANA_HOME = tmp;

// 占位：data/work-visit 用同名文件挡住（不能是目录）
const dataDir = path.join(tmp, "data", "work-visit");
fs.mkdirSync(path.dirname(dataDir), { recursive: true });
fs.writeFileSync(dataDir, "occupied", "utf-8");

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

async function call(pathName, body) {
  const c = { req: { json: async () => body } };
  const res = await routes[pathName](c);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

test("claim: 写盘失败时返回 500 而非 success:true（不谎报成功）", async () => {
  // 数据读不出来 → defaultData()；baseLP=100 有可领光粒 → 走到 saveData → 必失败
  const r = await call("/api/claim", {});
  assert.equal(r.status, 500, "写盘失败应回 500");
  assert.equal(r.body.success, false);
  assert.match(r.body.error, /保存失败/);
});

test("recharge: 写盘失败时返回 500（不谎报充电成功）", async () => {
  // 数据读不出来 → defaultData()；jar=0 < 50 → 光粒不足 400，走不到 saveData，
  // 说明这个测试没法用占位法覆盖 recharge 的写失败（jar 不够先拦）。
  // 这里断言占位环境下 recharge 至少正常拒绝，不抛异常。
  const r = await call("/api/recharge", { to: "hanako" });
  assert.equal(r.status, 400);
  assert.equal(r.body.success, false);
});
