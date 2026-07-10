import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfigDir } from "../src/core/agentify-config.ts";
import {
  AGENTIFYRC_FILENAME,
  loadAgentifyRc,
  resolveApplyPolicy,
} from "../src/core/agentifyrc.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = tempDir("agentify-rc-home-");
  const previous = process.env.HOME;
  process.env.HOME = home;
  return fn(home).finally(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

async function testReturnsUndefinedWhenNoRcExists(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-empty-");
    try {
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.equal(rc, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testLoadsStateDirScopedRc(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-state-");
    try {
      const stateDir = path.join(cwd, ".pi", "agentify");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, AGENTIFYRC_FILENAME),
        JSON.stringify({
          schema_version: "1",
          apply: {
            defaultAction: "keep",
            requiredAction: "abort",
            paths: [{ pattern: "specs/**", action: "abort" }],
          },
        }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.ok(rc);
      assert.equal(rc!.apply?.defaultAction, "keep");
      assert.equal(rc!.apply?.requiredAction, "abort");
      assert.deepEqual(rc!.apply?.paths, [
        { pattern: "specs/**", action: "abort" },
      ]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testFallsBackToCwdRootRc(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-root-");
    try {
      fs.writeFileSync(
        path.join(cwd, ".agentifyrc"),
        JSON.stringify({
          schema_version: "1",
          apply: { defaultAction: "abort" },
        }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.ok(rc);
      assert.equal(rc!.apply?.defaultAction, "abort");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testFallsBackToUserGlobalRc(): Promise<void> {
  await withTempHome(async (home) => {
    const cwd = tempDir("agentify-rc-global-");
    try {
      const globalDir = defaultConfigDir();
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(
        path.join(globalDir, AGENTIFYRC_FILENAME),
        JSON.stringify({
          schema_version: "1",
          apply: { defaultAction: "abort" },
        }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.ok(rc);
      assert.equal(rc!.apply?.defaultAction, "abort");
      // Silence the unused-var warning for `home`.
      void home;
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testStateDirWinsOverCwdRoot(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-precedence-");
    try {
      const stateDir = path.join(cwd, ".pi", "agentify");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, AGENTIFYRC_FILENAME),
        JSON.stringify({
          schema_version: "1",
          apply: { defaultAction: "keep" },
        }),
      );
      fs.writeFileSync(
        path.join(cwd, ".agentifyrc"),
        JSON.stringify({
          schema_version: "1",
          apply: { defaultAction: "abort" },
        }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.equal(rc?.apply?.defaultAction, "keep",
        "state-dir-scoped rc should win over cwd-root rc");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testTolerantReadDropsUnknownFields(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-tolerant-");
    try {
      fs.writeFileSync(
        path.join(cwd, ".agentifyrc"),
        JSON.stringify({
          schema_version: "1",
          apply: {
            defaultAction: "keep",
            future_field: "ignored",
            paths: [{ pattern: "**", action: "abort" }, { pattern: 42, action: "nope" }],
          },
          top_level_garbage: true,
        }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.ok(rc);
      assert.equal(rc!.apply?.defaultAction, "keep");
      // Only the well-formed path override survives; the bad
      // pattern (number) is silently dropped.
      assert.deepEqual(rc!.apply?.paths, [
        { pattern: "**", action: "abort" },
      ]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testMalformedJsonReturnsUndefined(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-bad-");
    try {
      fs.writeFileSync(path.join(cwd, ".agentifyrc"), "{ not valid json");
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.equal(rc, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testMalformedJsonFallsThroughToNextCandidate(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-fallthrough-");
    try {
      // Malformed at the cwd-root; valid at the state-dir.
      fs.writeFileSync(path.join(cwd, ".agentifyrc"), "{ broken");
      const stateDir = path.join(cwd, ".pi", "agentify");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, AGENTIFYRC_FILENAME),
        JSON.stringify({ schema_version: "1", apply: { defaultAction: "abort" } }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.equal(rc?.apply?.defaultAction, "abort",
        "malformed cwd-root rc should not shadow valid state-dir rc");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testUnknownSchemaVersionReturnsUndefined(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-version-");
    try {
      fs.writeFileSync(
        path.join(cwd, ".agentifyrc"),
        JSON.stringify({ schema_version: "2", apply: { defaultAction: "abort" } }),
      );
      const rc = loadAgentifyRc(cwd, ".pi/agentify");
      assert.equal(rc, undefined,
        "unknown schema_version should be treated as absent");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testResolveApplyPolicyDefaults(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-resolve-defaults-");
    try {
      const policy = resolveApplyPolicy(cwd, ".pi/agentify");
      assert.equal(policy.defaultAction, "alongside");
      assert.equal(policy.requiredAction, "alongside");
      assert.deepEqual(policy.paths, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testResolveApplyPolicyMergesRc(): Promise<void> {
  await withTempHome(async () => {
    const cwd = tempDir("agentify-rc-resolve-merge-");
    try {
      fs.writeFileSync(
        path.join(cwd, ".agentifyrc"),
        JSON.stringify({
          schema_version: "1",
          apply: {
            requiredAction: "abort",
            paths: [{ pattern: "specs/**", action: "keep" }],
          },
        }),
      );
      const policy = resolveApplyPolicy(cwd, ".pi/agentify");
      assert.equal(policy.defaultAction, "alongside",
        "rc that omits defaultAction falls back to the default");
      assert.equal(policy.requiredAction, "abort",
        "rc's requiredAction overrides the default");
      assert.equal(policy.paths[0]?.pattern, "specs/**",
        "rc patterns are placed first so they win on match");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "returnsUndefinedWhenNoRcExists", fn: testReturnsUndefinedWhenNoRcExists },
  { name: "loadsStateDirScopedRc", fn: testLoadsStateDirScopedRc },
  { name: "fallsBackToCwdRootRc", fn: testFallsBackToCwdRootRc },
  { name: "fallsBackToUserGlobalRc", fn: testFallsBackToUserGlobalRc },
  { name: "stateDirWinsOverCwdRoot", fn: testStateDirWinsOverCwdRoot },
  { name: "tolerantReadDropsUnknownFields", fn: testTolerantReadDropsUnknownFields },
  { name: "malformedJsonReturnsUndefined", fn: testMalformedJsonReturnsUndefined },
  { name: "malformedJsonFallsThroughToNextCandidate", fn: testMalformedJsonFallsThroughToNextCandidate },
  { name: "unknownSchemaVersionReturnsUndefined", fn: testUnknownSchemaVersionReturnsUndefined },
  { name: "resolveApplyPolicyDefaults", fn: testResolveApplyPolicyDefaults },
  { name: "resolveApplyPolicyMergesRc", fn: testResolveApplyPolicyMergesRc },
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
console.log(`agentifyrc tests passed (${passed}/${tests.length}).`);
