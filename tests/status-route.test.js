// 闲不住状态路由测试：用户端只查看状态，不能替伙伴手动改状态。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wv-status-route-"));
const previousHome = process.env.HANA_HOME;
process.env.HANA_HOME = home;
const { default: register } = await import(`../routes/api.js?status-route=${Date.now()}-${Math.random()}`);
if (previousHome === undefined) delete process.env.HANA_HOME;
else process.env.HANA_HOME = previousHome;

after(() => fs.rmSync(home, { recursive: true, force: true }));

test("状态路由：用户不能手动替伙伴换状态", async () => {
  const posts = {};
  const routes = {};
  const app = {
    get(pathname, handler) { routes[pathname] = handler; },
    post(pathname, handler) { posts[pathname] = handler; },
  };
  await register(app, { pluginDir: path.resolve(".") });

  const response = await posts["/api/statuses"]({ req: {} });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.match(body.error, /伙伴自己决定/);

  const pageResponse = await routes["/page"]({ req: { url: "http://localhost/page?token=check" } });
  const html = await pageResponse.text();
  const scripts = html.split("<script>").slice(1).map((part) => part.split("</script>")[0]);
  const appScript = scripts.find((script) => !script.trim().startsWith("window.__TOKEN"));
  assert.ok(appScript);
  assert.doesNotThrow(() => new Function(appScript));
  for (const marker of ["_tbChooseStatus", "_tbCreateStatus", "_tbClearStatus", "_tbSaveStatus", "_tbSetStatusDuration", "status-create", "status-duration"]) {
    assert.equal(html.includes(marker), false, `页面残留手动状态入口：${marker}`);
  }
});
