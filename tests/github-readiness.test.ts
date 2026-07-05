import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatGitHubReadiness,
  inspectGitHubReadiness,
} from "../src/core/github-readiness.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeGitConfig(cwd: string, content: string): void {
  const gitDir = path.join(cwd, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "config"), content);
}

async function testReadyRepo(): Promise<void> {
  const cwd = tempDir("agentify-github-ready-");
  try {
    writeGitConfig(cwd, `[remote "origin"]\n  url = git@github.com:owner/repo.git\n`);
    const readiness = inspectGitHubReadiness({ cwd, ghCliAvailable: true });
    assert.equal(readiness.hasGitDirectory, true);
    assert.equal(readiness.hasGitHubRemote, true);
    assert.equal(readiness.ghCliAvailable, true);
    assert.match(formatGitHubReadiness(readiness)[0]!, /ready/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testMissingRemote(): Promise<void> {
  const cwd = tempDir("agentify-github-remote-");
  try {
    writeGitConfig(cwd, `[remote "origin"]\n  url = git@gitlab.com:owner/repo.git\n`);
    const readiness = inspectGitHubReadiness({ cwd, ghCliAvailable: true });
    assert.equal(readiness.hasGitDirectory, true);
    assert.equal(readiness.hasGitHubRemote, false);
    assert.match(readiness.guidance.join(" "), /GitHub `origin` remote/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testMissingGitAndGh(): Promise<void> {
  const cwd = tempDir("agentify-github-missing-");
  try {
    const readiness = inspectGitHubReadiness({ cwd, ghCliAvailable: false });
    assert.equal(readiness.hasGitDirectory, false);
    assert.equal(readiness.hasGitHubRemote, false);
    assert.equal(readiness.ghCliAvailable, false);
    const formatted = formatGitHubReadiness(readiness).join(" ");
    assert.match(formatted, /needs attention/);
    assert.match(formatted, /Initialize a git repository/);
    assert.match(formatted, /Install GitHub CLI/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "readyRepo", fn: testReadyRepo },
  { name: "missingRemote", fn: testMissingRemote },
  { name: "missingGitAndGh", fn: testMissingGitAndGh },
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
console.log(`github-readiness tests passed (${passed}/${tests.length}).`);
