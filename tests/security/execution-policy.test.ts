import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeDefenseHook } from "../../src/core/audit/defense-hook.ts";
import {
  assertRequestedToolsAllowed,
  createReadOnlyExecutionPolicy,
  createRepositoryWriteExecutionPolicy,
} from "../../src/core/security/execution-policy.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function event(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): never {
  return { toolName, input, cwd, activeTools: [toolName] } as never;
}

async function testReadOnlyToolAdmission(): Promise<void> {
  const cwd = tempDir("agentify-policy-readonly-");
  try {
    const policy = createReadOnlyExecutionPolicy({ cwd });
    assert.doesNotThrow(() => assertRequestedToolsAllowed(["read", "grep"], policy));
    assert.throws(
      () => assertRequestedToolsAllowed(["read", "bash"], policy),
      /does not allow tools: bash/,
    );
    assert.throws(
      () => createReadOnlyExecutionPolicy({ cwd, tools: ["read", "write"] }),
      /cannot grant: write/,
    );
    assert.throws(
      () => assertRequestedToolsAllowed(["read", "write_map"], policy),
      /does not allow tools: write_map/,
    );
    assert.doesNotThrow(() =>
      assertRequestedToolsAllowed(["read", "write_map"], policy, ["write_map"]),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testReadOnlyFilesystemAndShellBoundary(): Promise<void> {
  const cwd = tempDir("agentify-policy-boundary-");
  const outside = tempDir("agentify-policy-outside-");
  try {
    const policy = createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly" });
    const hook = makeDefenseHook({ executionPolicy: policy });
    assert.equal(await hook(event("read", { path: path.join(cwd, "README.md") }, cwd)), undefined);
    assert.ok((await hook(event("read", { path: path.join(outside, "secret.txt") }, cwd)))?.block);
    assert.ok((await hook(event("write", { path: path.join(cwd, "src.ts"), content: "x" }, cwd)))?.block);
    assert.ok((await hook(event("bash", { command: "npm test" }, cwd)))?.block);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

async function testWritePolicyConfinesAndProtects(): Promise<void> {
  const cwd = tempDir("agentify-policy-write-");
  const outside = tempDir("agentify-policy-write-outside-");
  try {
    const protectedFile = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(protectedFile, "user owned\n");
    const policy = createRepositoryWriteExecutionPolicy({
      cwd,
      tools: ["read", "write", "edit"],
      protectedPaths: [protectedFile],
    });
    const hook = makeDefenseHook({ executionPolicy: policy });
    assert.equal(
      await hook(event("write", { path: path.join(cwd, "NEW.md"), content: "x" }, cwd)),
      undefined,
    );
    assert.ok((await hook(event("write", { path: protectedFile, content: "x" }, cwd)))?.block);
    assert.ok((await hook(event("write", { path: path.join(outside, "escape.ts"), content: "x" }, cwd)))?.block);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

async function testSymlinkCannotEscapeReadableRoot(): Promise<void> {
  const cwd = tempDir("agentify-policy-symlink-");
  const outside = tempDir("agentify-policy-symlink-outside-");
  try {
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "secret\n");
    const link = path.join(cwd, "linked-secret.txt");
    fs.symlinkSync(outsideFile, link);
    const hook = makeDefenseHook({
      executionPolicy: createReadOnlyExecutionPolicy({ cwd }),
    });
    const result = await hook(event("read", { path: link }, cwd));
    assert.ok(result?.block, "symlink reads resolving outside the repository must be blocked");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

async function testLegacyShellEscapeCasesBlocked(): Promise<void> {
  const cwd = tempDir("agentify-policy-legacy-");
  try {
    const hook = makeDefenseHook({ repoJail: true });
    for (const command of [
      "cat ~/.agentify/auth.json",
      "cp package.json /tmp/copied-package.json",
      "rm package.json",
    ]) {
      const result = await hook(event("bash", { command }, cwd));
      assert.ok(result?.block, `legacy defense must block: ${command}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "readOnlyToolAdmission", fn: testReadOnlyToolAdmission },
  { name: "readOnlyFilesystemAndShellBoundary", fn: testReadOnlyFilesystemAndShellBoundary },
  { name: "writePolicyConfinesAndProtects", fn: testWritePolicyConfinesAndProtects },
  { name: "symlinkCannotEscapeReadableRoot", fn: testSymlinkCannotEscapeReadableRoot },
  { name: "legacyShellEscapeCasesBlocked", fn: testLegacyShellEscapeCasesBlocked },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}
console.log(`execution-policy tests passed (${passed}/${tests.length}).`);
