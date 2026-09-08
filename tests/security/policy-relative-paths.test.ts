import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { makeDefenseHook } from "../../src/core/audit/defense-hook.ts";
import { createReadOnlyExecutionPolicy, createRepositoryWriteExecutionPolicy } from "../../src/core/security/execution-policy.ts";

test("SDK-style relative reads use the trusted policy root, not the host working directory or event data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-relative-read-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-relative-outside-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/entry.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(outside, "escape.ts"), "outside\n");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    assert.notEqual(root, process.cwd(), "fixture must exercise an SDK session outside the host cwd");
    const hook = makeDefenseHook({ executionPolicy: createReadOnlyExecutionPolicy({ cwd: root }) });
    for (const toolName of ["read", "grep", "find", "ls"]) {
      for (const extra of [{}, { cwd: outside }]) {
        const allowed = await hook({ type: "tool_call", toolName, toolCallId: "relative",
          input: { path: "src/entry.ts" }, ...extra } as never);
        assert.equal(allowed, undefined, `${toolName}: SDK events need no invented cwd property`);
        for (const target of [path.join(outside, "escape.ts"), "escape/escape.ts", "../escape.ts", ".env"]) {
          const denied = await hook({ type: "tool_call", toolName, toolCallId: "outside",
            input: { path: target }, ...extra } as never);
          assert.ok(denied?.block, `${toolName} must still reject ${target}`);
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("relative writes still honor narrower writable roots and protected paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-relative-write-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    const protectedFile = path.join(root, "src/owned.ts");
    fs.writeFileSync(protectedFile, "user-owned\n");
    const hook = makeDefenseHook({ executionPolicy: createRepositoryWriteExecutionPolicy({ cwd: root,
      tools: ["write", "edit"], writableRoots: [path.join(root, "src")], protectedPaths: [protectedFile] }) });
    for (const toolName of ["write", "edit"]) {
      assert.equal(await hook({ type: "tool_call", toolName, toolCallId: "allowed",
        input: { path: "src/new.ts" } } as never), undefined);
      for (const target of ["src/owned.ts", "README.md", "../outside.ts"]) {
        assert.ok((await hook({ type: "tool_call", toolName, toolCallId: "denied", input: { path: target } } as never))?.block);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
