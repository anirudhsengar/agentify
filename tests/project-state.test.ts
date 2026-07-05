import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectStatePath, readProjectState, writeProjectState } from "../src/core/project-state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testRoundTrip(): Promise<void> {
  const cwd = tempDir("agentify-project-state-cwd-");
  const configDir = tempDir("agentify-project-state-config-");
  try {
    writeProjectState(configDir, {
      cwd,
      lastRunAt: "2026-07-05T00:00:00Z",
      projectKind: "brownfield",
      runStatus: "success",
      repoMode: "brownfield",
      repoStatus: "ready",
      featureAgentCount: 2,
      latestLogPath: "/tmp/log.jsonl",
      github: {
        hasGitDirectory: true,
        hasGitHubRemote: true,
        ghCliAvailable: true,
        originUrl: "git@github.com:owner/repo.git",
      },
    });
    const loaded = readProjectState(configDir, cwd);
    assert.equal(loaded?.runStatus, "success");
    assert.equal(loaded?.featureAgentCount, 2);
    assert.equal(fs.statSync(projectStatePath(configDir, cwd)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testMissingState(): Promise<void> {
  const cwd = tempDir("agentify-project-state-missing-cwd-");
  const configDir = tempDir("agentify-project-state-missing-config-");
  try {
    assert.equal(readProjectState(configDir, cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "roundTrip", fn: testRoundTrip },
  { name: "missingState", fn: testMissingState },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`project-state tests passed (${passed}/${tests.length}).`);
