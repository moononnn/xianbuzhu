// 闲不住 update-status 工具集成测试
// 使用隔离 HANA_HOME，确认清除状态不会误清正在做什么的旧 narrative。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("update-status：清除状态时保留旧 narrative", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "work-visit-status-tool-test-"));
  try {
    const script = `
      import { defaultData, saveData, loadData, todayStr } from "./lib/data.js";
      const seed = defaultData();
      seed.partnerConfig = {};
      seed.days[todayStr()] = {
        partners: {
          hanako: {
            contributed: true,
            narrative: "正在理顺旧工作",
            effortLP: 0,
            status: {
              id: "inspiration",
              text: "灵感冒头",
              icon: "💡",
              category: "心情",
              scope: "public",
              duration: "until_changed",
              setAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
              expiresAt: null,
            },
          },
        },
      };
      saveData(seed);
      const { execute } = await import("./tools/update-status.js");
      const customResult = await execute({ status: "自己配的状态", icon: "🫧" }, { agentId: "hanako" });
      const customPayload = JSON.parse(customResult.content[0].text);
      if (!customPayload.success || customPayload.status?.text !== "自己配的状态") throw new Error(JSON.stringify(customPayload));
      const blocked = await execute({ status: "替别人配的状态", partner: "other" }, { agentId: "hanako" });
      const blockedPayload = JSON.parse(blocked.content[0].text);
      if (blockedPayload.success || !blockedPayload.error) throw new Error(JSON.stringify(blockedPayload));
      const result = await execute({ clear: true }, { agentId: "hanako" });
      const payload = JSON.parse(result.content[0].text);
      const partner = loadData().days[todayStr()].partners.hanako;
      if (!payload.success || payload.status !== null || partner.status || partner.narrative !== "正在理顺旧工作" || partner.contributed !== true) {
        throw new Error(JSON.stringify({ payload, partner }));
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, HANA_HOME: temp },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
