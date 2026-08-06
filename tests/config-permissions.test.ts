// The agentify config dir holds credentials, so it (not just the files)
// must be private.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveAgentifyConfig, configPath, authPath } from "../src/core/agentify-config.ts";

function tempParent(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-perm-"));
}

async function testConfigDirIs0700(): Promise<void> {
  const parent = tempParent();
  const configDir = path.join(parent, "state");
  saveAgentifyConfig(configDir, {
    schemaVersion: 1,
    provider: "openai",
    thinkingLevel: "high",
    models: {},
  });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700, "config dir must be 0700");
    assert.equal(fs.statSync(configPath(configDir)).mode & 0o777, 0o600, "config.json must be 0600");
  }
  fs.writeFileSync(authPath(configDir), "{}\n", { mode: 0o600 });
  fs.rmSync(parent, { recursive: true, force: true });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "configDirIs0700", fn: testConfigDirIs0700 },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    process.exit(1);
  }
}
console.log(`config-permissions tests passed (${passed}/${tests.length}).`);
