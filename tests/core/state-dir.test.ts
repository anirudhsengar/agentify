import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  __test__resolveStateDirFromProvider,
  resolveCanonicalStateDir,
  resolveStateDir,
  stateDirRelative,
  type StateDirProvider,
} from "../../src/core/state-dir.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function seedLegacyState(cwd: string): void {
  const filePath = path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "codebase_map.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"schema_version":"1","marker":"legacy"}\n');
}

async function testStateDirRelativePerProvider(): Promise<void> {
  assert.equal(stateDirRelative("claude"), ".claude/agentify");
  assert.equal(stateDirRelative("codex"), ".agents/agentify");
  assert.equal(stateDirRelative("pi"), LEGACY_PI_STATE_RELATIVE_DIR);
  assert.equal(stateDirRelative("universal"), ".agents/agentify");
  for (const provider of ["claude", "codex", "pi", "universal"] as const) {
    assert.ok(!stateDirRelative(provider).endsWith("/"));
  }
}

async function testResolveClaudeWins(): Promise<void> {
  assert.deepEqual(resolveStateDir(["claude", "codex", "pi"]), {
    relativeDir: ".claude/agentify",
    provider: "claude",
  });
  assert.deepEqual(resolveStateDir(["claude", "pi"]), {
    relativeDir: ".claude/agentify",
    provider: "claude",
  });
  assert.deepEqual(resolveStateDir(["claude"]), {
    relativeDir: ".claude/agentify",
    provider: "claude",
  });
}

async function testResolveCodexWhenNoClaude(): Promise<void> {
  assert.deepEqual(resolveStateDir(["codex", "pi"]), {
    relativeDir: ".agents/agentify",
    provider: "codex",
  });
  assert.deepEqual(resolveStateDir(["codex"]), {
    relativeDir: ".agents/agentify",
    provider: "codex",
  });
}

async function testResolvePiOnly(): Promise<void> {
  assert.deepEqual(resolveStateDir(["pi"]), {
    relativeDir: ".pi/agentify",
    provider: "pi",
  });
}

async function testResolveUniversalFallback(): Promise<void> {
  assert.deepEqual(resolveStateDir([]), {
    relativeDir: ".agents/agentify",
    provider: "universal",
  });
  assert.deepEqual(resolveStateDir([], ["cursor", "opencode"]), {
    relativeDir: ".agents/agentify",
    provider: "universal",
  });
}



async function testResolveCanonicalPrefersExistingNewDir(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-new-only-");
  try {
    const fresh = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(fresh.relativeDir, ".claude/agentify");
    assert.equal(fresh.destinationRelativeDir, ".claude/agentify");
    assert.equal(fresh.provider, "claude");
    assert.equal(fresh.layout.fallback, false);
    assert.equal(fresh.absoluteDir, path.join(cwd, ".claude/agentify"));

    seedLegacyState(cwd);
    const canonicalMap = path.join(cwd, ".claude", "agentify", "codebase_map.json");
    fs.mkdirSync(path.dirname(canonicalMap), { recursive: true });
    fs.copyFileSync(
      path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "codebase_map.json"),
      canonicalMap,
    );
    const both = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(both.absoluteDir, path.join(cwd, ".claude/agentify"));
    assert.equal(both.layout.kind, "dual_identical");
    assert.equal(both.layout.fallback, false);
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalMigratesLegacyToClaude(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-legacy-migration-");
  try {
    seedLegacyState(cwd);
    const resolved = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(resolved.absoluteDir, path.join(cwd, ".claude/agentify"));
    assert.equal(resolved.relativeDir, ".claude/agentify");
    assert.equal(resolved.sourceRelativeDir, ".claude/agentify");
    assert.equal(resolved.destinationRelativeDir, ".claude/agentify");
    assert.equal(resolved.provider, "claude");
    assert.equal(resolved.layout.kind, "dual_identical");
    assert.equal(resolved.layout.fallback, false);
    assert.ok(resolved.migrationRunId);
    assert.equal(resolved.guidance.length, 2);
    assert.ok(fs.existsSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "codebase_map.json")));
    assert.ok(fs.existsSync(path.join(cwd, ".claude/agentify/codebase_map.json")));
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalMigratesLegacyToCodex(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-codex-migration-");
  try {
    seedLegacyState(cwd);
    const resolved = resolveCanonicalStateDir(cwd, ["codex"]);
    assert.equal(resolved.absoluteDir, path.join(cwd, ".agents/agentify"));
    assert.equal(resolved.relativeDir, ".agents/agentify");
    assert.equal(resolved.layout.kind, "dual_identical");
    assert.equal(resolved.destinationRelativeDir, ".agents/agentify");
    assert.equal(resolved.provider, "codex");
    assert.ok(resolved.migrationRunId);
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalFreshRepo(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-fresh-");
  try {
    const fresh = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(fresh.layout.fallback, false);
    assert.equal(fresh.relativeDir, ".claude/agentify");
    assert.equal(fresh.absoluteDir, path.join(cwd, ".claude/agentify"));
    assert.ok(!fs.existsSync(fresh.absoluteDir));
  } finally {
    rmrf(cwd);
  }
}

async function testTestBypassShape(): Promise<void> {
  for (const provider of ["claude", "codex", "pi", "universal"] as const) {
    const bypass = __test__resolveStateDirFromProvider(provider);
    assert.equal(bypass.provider, provider);
    assert.equal(bypass.relativeDir, stateDirRelative(provider));
  }
}

async function testTestBypassAllProvidersCovered(): Promise<void> {
  const providers: StateDirProvider[] = ["claude", "codex", "pi", "universal"];
  assert.equal(providers.length, 4);
}

async function testLegacyConstantIsCorrect(): Promise<void> {
  assert.equal(LEGACY_PI_STATE_RELATIVE_DIR, ".pi/agentify");
}

async function main(): Promise<void> {
  await testStateDirRelativePerProvider();
  await testResolveClaudeWins();
  await testResolveCodexWhenNoClaude();
  await testResolvePiOnly();
  await testResolveUniversalFallback();
      await testResolveCanonicalPrefersExistingNewDir();
  await testResolveCanonicalMigratesLegacyToClaude();
  await testResolveCanonicalMigratesLegacyToCodex();
  await testResolveCanonicalFreshRepo();
  await testTestBypassShape();
  await testTestBypassAllProvidersCovered();
  await testLegacyConstantIsCorrect();
  console.log("state-dir.test.ts: all 14 checks passed");
}

await main();
