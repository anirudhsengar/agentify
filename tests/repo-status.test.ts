import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectAgentifyRepoState } from "../src/core/repo-status.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(relativePath: string, cwd: string): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x\n");
}

async function testReadyBrownfield(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-brownfield-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    for (const relativePath of [
      "AGENTS.md",
      "specs/README.md",
      "ai_docs/README.md",
      "SETUP.md",
      ".github/workflows/agent-implement.yml",
      ".pi/agents/payments.md",
    ]) {
      write(relativePath, cwd);
    }
    const state = inspectAgentifyRepoState(cwd, configDir);
    assert.equal(state.mode, "brownfield");
    assert.equal(state.status, "ready");
    assert.equal(state.featureAgentCount, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testPartialGreenfield(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-greenfield-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    write("GOALS.md", cwd);
    write("CONTEXT.md", cwd);
    const state = inspectAgentifyRepoState(cwd, configDir);
    assert.equal(state.mode, "greenfield");
    assert.equal(state.status, "partial");
    assert.deepEqual(state.missing.sort(), [
      ".github/workflows/agent-implement.yml",
      "SETUP.md",
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testUninitializedRepo(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-empty-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    const state = inspectAgentifyRepoState(cwd, configDir);
    assert.equal(state.mode, "unknown");
    assert.equal(state.status, "uninitialized");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "readyBrownfield", fn: testReadyBrownfield },
  { name: "partialGreenfield", fn: testPartialGreenfield },
  { name: "uninitializedRepo", fn: testUninitializedRepo },
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
console.log(`repo-status tests passed (${passed}/${tests.length}).`);
