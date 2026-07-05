// tests/orchestrator/defense-domain-lock.test.ts — defense hook domain locking.
//
// Class 4 G4: when a sub-agent is created with a domain (via the
// orchestrator's AgentManager + Worker), the defense hook blocks
// `write` / `edit` / `write_file` / `multi_edit` calls whose target
// path is outside the domain globs. This test exercises that
// behavior directly against `makeDefenseHook({ agentDomain })`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeDefenseHook } from "../../src/core/audit/defense-hook.ts";
import { setAgentifySessionActive } from "../../src/core/audit/state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeEvent(toolName: string, input: Record<string, unknown>): {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  activeTools: readonly string[];
} {
  return {
    toolName,
    input,
    cwd: process.cwd(),
    activeTools: ["read", "write", "edit", "bash"],
  };
}

function activate(): void {
  setAgentifySessionActive(null, true);
}

function deactivate(): void {
  setAgentifySessionActive(null, false);
}

async function testNullDomainAllowsAllWrites(): Promise<void> {
  activate();
  const hook = makeDefenseHook({ agentDomain: null });
  const result = await hook(makeFakeEvent("write", { path: "/tmp/anywhere.ts", content: "x" }) as never);
  assert.equal(result, undefined, "null domain should allow writes");
  deactivate();
}

async function testEmptyDomainBlocksAllWrites(): Promise<void> {
  activate();
  const hook = makeDefenseHook({ agentDomain: [] });
  const result = await hook(makeFakeEvent("write", { path: "/tmp/anywhere.ts", content: "x" }) as never);
  assert.ok(result?.block, `empty domain (read-only) should block writes, got: ${JSON.stringify(result)}`);
  assert.match(result?.reason ?? "", /read-only/);
  deactivate();
}

async function testDomainAllowsMatchingPath(): Promise<void> {
  const cwd = tempDir("agentify-domain-allow-");
  try {
    activate();
    const hook = makeDefenseHook({ agentDomain: [`${cwd}/src/**`] });
    const target = path.join(cwd, "src", "foo.ts");
    const result = await hook(makeFakeEvent("write", { path: target, content: "x" }) as never);
    assert.equal(result, undefined, "matching path should be allowed");
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDomainBlocksNonMatchingPath(): Promise<void> {
  const cwd = tempDir("agentify-domain-block-");
  try {
    activate();
    const hook = makeDefenseHook({ agentDomain: [`${cwd}/src/**`] });
    const target = path.join(cwd, "tests", "foo.ts");
    const result = await hook(makeFakeEvent("write", { path: target, content: "x" }) as never);
    assert.ok(result?.block, "non-matching path should be blocked");
    assert.match(result?.reason ?? "", /domain-lock/);
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDomainBlocksEditToolToo(): Promise<void> {
  const cwd = tempDir("agentify-domain-edit-");
  try {
    activate();
    const hook = makeDefenseHook({ agentDomain: [`${cwd}/src/**`] });
    const target = path.join(cwd, "tests", "foo.ts");
    const result = await hook(makeFakeEvent("edit", { path: target, oldText: "a", newText: "b" }) as never);
    assert.ok(result?.block, "edit tool should also be blocked");
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDomainAllowsReadOutsideDomain(): Promise<void> {
  const cwd = tempDir("agentify-domain-read-");
  try {
    activate();
    const hook = makeDefenseHook({ agentDomain: [`${cwd}/src/**`] });
    const target = path.join(cwd, "tests", "foo.ts");
    // Reads are NOT blocked by domain lock (Layer E only fires on
    // write-like tools).
    const result = await hook(makeFakeEvent("read", { path: target }) as never);
    assert.equal(result, undefined, "read tool should not be domain-locked");
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testMultipleDomainsFirstMatchWins(): Promise<void> {
  const cwd = tempDir("agentify-domain-multi-");
  try {
    activate();
    const hook = makeDefenseHook({ agentDomain: [`${cwd}/src/**`, `${cwd}/tests/**`] });
    // src path
    let result = await hook(makeFakeEvent("write", { path: path.join(cwd, "src", "x.ts"), content: "x" }) as never);
    assert.equal(result, undefined);
    // tests path
    result = await hook(makeFakeEvent("write", { path: path.join(cwd, "tests", "y.ts"), content: "y" }) as never);
    assert.equal(result, undefined);
    // docs path (neither)
    result = await hook(makeFakeEvent("write", { path: path.join(cwd, "docs", "z.md"), content: "z" }) as never);
    assert.ok(result?.block);
    deactivate();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "nullDomainAllowsAllWrites", fn: testNullDomainAllowsAllWrites },
  { name: "emptyDomainBlocksAllWrites", fn: testEmptyDomainBlocksAllWrites },
  { name: "domainAllowsMatchingPath", fn: testDomainAllowsMatchingPath },
  { name: "domainBlocksNonMatchingPath", fn: testDomainBlocksNonMatchingPath },
  { name: "domainBlocksEditToolToo", fn: testDomainBlocksEditToolToo },
  { name: "domainAllowsReadOutsideDomain", fn: testDomainAllowsReadOutsideDomain },
  { name: "multipleDomainsFirstMatchWins", fn: testMultipleDomainsFirstMatchWins },
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
console.log(`Defense domain-lock tests passed (${passed}/${tests.length}).`);
