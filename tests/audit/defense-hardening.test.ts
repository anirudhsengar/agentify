// Tests for the hardened defense hook: interpreter one-liner blacklist,
// credential-store protection, repository jail, and user-owned file
// protection.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeDefenseHook } from "../../src/core/audit/defense-hook.ts";
import { setAgentifySessionActive } from "../../src/core/audit/state.ts";
import { BLACKLIST } from "../../src/core/audit/defense/blacklist.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function evt(toolName: string, input: Record<string, unknown>, cwd = process.cwd()) {
  return { toolName, input, cwd, activeTools: ["read", "write", "edit", "bash"] } as never;
}

function activate(): void { setAgentifySessionActive(null, true); }
function deactivate(): void { setAgentifySessionActive(null, false); }

function blacklistBlocks(command: string): boolean {
  return BLACKLIST.some((e) => e.pattern.test(command));
}

async function testInterpreterOneLinersBlocked(): Promise<void> {
  const blocked = [
    "python3 -c 'import os; print(os.environ)'",
    "python -c 'x=1'",
    "node -e 'require(\"fs\")'",
    "node --eval 'process.exit()'",
    "node -p 'process.env'",
    "ruby -e 'puts 1'",
    "perl -e 'print 1'",
    "php -e 'echo 1;'",
    "bash -c 'cat /etc/passwd'",
    "sh -c 'echo hi'",
    "deno eval 'console.log(1)'",
    "bun -e 'console.log(1)'",
  ];
  for (const cmd of blocked) {
    assert.ok(blacklistBlocks(cmd), `expected blacklist to block: ${cmd}`);
  }
  // A normal command is not blocked.
  assert.ok(!blacklistBlocks("npm test"), "npm test should not be blocked");
  assert.ok(!blacklistBlocks("node dist/index.js"), "running a file should not be blocked");
}

async function testInterpreterOneLinerBlockedViaHook(): Promise<void> {
  activate();
  const hook = makeDefenseHook({ repoJail: true });
  const result = await hook(evt("bash", { command: "python3 -c 'print(1)'" }));
  assert.ok(result?.block, "hook should block python -c");
  deactivate();
}

async function testCredentialStoreBlocked(): Promise<void> {
  activate();
  const hook = makeDefenseHook({ repoJail: true });
  const target = path.join(os.homedir(), ".agentify", "auth.json");
  const read = await hook(evt("read", { path: target }));
  assert.ok(read?.block, "reading the agentify credential store must be blocked");
  const write = await hook(evt("write", { path: target, content: "x" }));
  assert.ok(write?.block, "writing the agentify credential store must be blocked");
  deactivate();
}

async function testRepoJailBlocksOutsideWrite(): Promise<void> {
  const cwd = tempDir("agentify-jail-");
  try {
    activate();
    const hook = makeDefenseHook({ repoJail: true });
    const inside = await hook(evt("write", { path: path.join(cwd, "src", "a.ts"), content: "x" }, cwd));
    assert.equal(inside, undefined, "writes inside the repo are allowed");
    const outside = await hook(evt("write", { path: "/tmp/evil.ts", content: "x" }, cwd));
    assert.ok(outside?.block, "writes outside the repo must be blocked");
    assert.match(outside?.reason ?? "", /repo-jail/);
    const traversal = await hook(evt("write", { path: path.join(cwd, "..", "escape.ts"), content: "x" }, cwd));
    assert.ok(traversal?.block, "path traversal out of the repo must be blocked");
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testProtectedPathsBlockOverwrite(): Promise<void> {
  const cwd = tempDir("agentify-protected-");
  try {
    activate();
    const userFile = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(userFile, "# user owned\n");
    const hook = makeDefenseHook({ repoJail: true, protectedPaths: [userFile] });
    const result = await hook(evt("write", { path: userFile, content: "clobber" }, cwd));
    assert.ok(result?.block, "a user-owned file must not be overwritten");
    assert.match(result?.reason ?? "", /user-owned/);
    // A different file in the repo is fine.
    const other = await hook(evt("write", { path: path.join(cwd, "NEW.md"), content: "x" }, cwd));
    assert.equal(other, undefined);
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testReadsOutsideRepoStillAllowed(): Promise<void> {
  const cwd = tempDir("agentify-readjail-");
  try {
    activate();
    const hook = makeDefenseHook({ repoJail: true });
    // Reads are not confined by the repo jail (only writes are), except
    // for the zero-access/credential rules.
    const result = await hook(evt("read", { path: "/tmp/somewhere.txt" }, cwd));
    assert.equal(result, undefined, "reads outside the repo are not jailed");
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "interpreterOneLinersBlocked", fn: testInterpreterOneLinersBlocked },
  { name: "interpreterOneLinerBlockedViaHook", fn: testInterpreterOneLinerBlockedViaHook },
  { name: "credentialStoreBlocked", fn: testCredentialStoreBlocked },
  { name: "repoJailBlocksOutsideWrite", fn: testRepoJailBlocksOutsideWrite },
  { name: "protectedPathsBlockOverwrite", fn: testProtectedPathsBlockOverwrite },
  { name: "readsOutsideRepoStillAllowed", fn: testReadsOutsideRepoStillAllowed },
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
console.log(`defense-hardening tests passed (${passed}/${tests.length}).`);
