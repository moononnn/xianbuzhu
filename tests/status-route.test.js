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

  const initialSettings = await routes["/api/status-settings"]({ req: {} });
  const initialBody = await initialSettings.json();
  assert.equal(initialBody.settings.autonomousEnabled, true);

  const initialHeartSettings = await routes["/api/heart-settings"]({ req: {} });
  const initialHeartBody = await initialHeartSettings.json();
  assert.equal(initialHeartBody.settings.enabled, true);
  assert.equal(initialHeartBody.settings.frequency, "low");

  const heartDisabled = await posts["/api/heart-settings"]({ req: { json: async () => ({ enabled: false }) } });
  const heartDisabledBody = await heartDisabled.json();
  assert.equal(heartDisabled.status, 200);
  assert.equal(heartDisabledBody.settings.enabled, false);

  const heartInvalid = await posts["/api/heart-settings"]({ req: { json: async () => ({ enabled: "false" }) } });
  assert.equal(heartInvalid.status, 400);
  assert.equal((await heartInvalid.json()).success, false);

  const disabled = await posts["/api/status-settings"]({ req: { json: async () => ({ enabled: false }) } });
  const disabledBody = await disabled.json();
  assert.equal(disabled.status, 200);
  assert.equal(disabledBody.settings.autonomousEnabled, false);

  const invalid = await posts["/api/status-settings"]({ req: { json: async () => ({ enabled: "false" }) } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).success, false);

  const dataResponseOff = await routes["/api/data"]({ req: {} });
  const dataBodyOff = JSON.parse(await dataResponseOff.text());
  assert.equal(dataBodyOff.statusSettings.autonomousEnabled, false);
  assert.equal(dataBodyOff.heartSettings.enabled, false);

  const heartEnabled = await posts["/api/heart-settings"]({ req: { json: async () => ({ enabled: true }) } });
  const heartEnabledBody = await heartEnabled.json();
  assert.equal(heartEnabled.status, 200);
  assert.equal(heartEnabledBody.settings.enabled, true);

  const enabled = await posts["/api/status-settings"]({ req: { json: async () => ({ enabled: true }) } });
  const enabledBody = await enabled.json();
  assert.equal(enabled.status, 200);
  assert.equal(enabledBody.settings.autonomousEnabled, true);

  const dataResponse = await routes["/api/data"]({ req: {} });
  const dataBody = JSON.parse(await dataResponse.text());
  assert.equal(dataBody.statusSettings.autonomousEnabled, true);
  assert.equal(dataBody.heartSettings.enabled, true, "状态开关不应改动主动心意开关");

  const pageResponse = await routes["/page"]({ req: { url: "http://localhost/page?token=check" } });
  const html = await pageResponse.text();
  const scripts = html.split("<script>").slice(1).map((part) => part.split("</script>")[0]);
  const appScript = scripts.find((script) => !script.trim().startsWith("window.__TOKEN"));
  assert.ok(appScript);
  assert.doesNotThrow(() => new Function(appScript));
  for (const marker of ["_tbChooseStatus", "_tbCreateStatus", "_tbClearStatus", "_tbSaveStatus", "_tbSetStatusDuration", "status-create", "status-duration"]) {
    assert.equal(html.includes(marker), false, `页面残留手动状态入口：${marker}`);
  }
  assert.match(html, /伙伴自主状态/);
  assert.match(html, /_tbToggleStatusAutonomy/);
  assert.match(html, /主动心意/);
  assert.match(html, /_tbToggleHeartAutonomy/);
  assert.match(html, /data-heart-autonomy-toggle/);
  assert.match(html, /heartAutonomyEnabled \? '' : ' disabled'/);
  assert.match(html, /data-heart-frequency-disabled-hint/);
  assert.match(html, /Array\.isArray\(partner\.statusCollection\) \? partner\.statusCollection : \[\]/);
  assert.doesNotMatch(html, /partner\.statusCollection\) \|\| state\.statusCollection/);
  assert.doesNotMatch(html, /state\.statusCollection \|\| \[\]/);
  assert.match(html, /heartSettingChanged/);
});
