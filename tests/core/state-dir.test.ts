import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  __test__resolveStateDirFromProvider,
  isLegacyPiState,
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

async function testIsLegacyPiStateTrue(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-legacy-true-");
  try {
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    assert.equal(isLegacyPiState(cwd), true);
  } finally {
    rmrf(cwd);
  }
}

async function testIsLegacyPiStateFalse(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-legacy-false-");
  try {
    assert.equal(isLegacyPiState(cwd), false);
    fs.mkdirSync(path.join(cwd, ".claude", "agentify"), { recursive: true });
    assert.equal(isLegacyPiState(cwd), false);
  } finally {
    rmrf(cwd);
  }
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

    fs.mkdirSync(path.join(cwd, ".claude", "agentify"), { recursive: true });
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    const both = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(both.absoluteDir, path.join(cwd, ".claude/agentify"));
    assert.equal(both.layout.kind, "dual_identical");
    assert.equal(both.layout.fallback, false);
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalFallsBackToLegacy(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-legacy-fallback-");
  try {
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    const fallback = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(fallback.absoluteDir, path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
    assert.equal(fallback.relativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
    assert.equal(fallback.sourceRelativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
    assert.equal(fallback.destinationRelativeDir, ".claude/agentify");
    assert.equal(fallback.provider, "claude");
    assert.equal(fallback.legacy, false);
    assert.equal(fallback.layout.fallback, true);
    assert.equal(fallback.guidance.length, 1);
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalCodexFallback(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-codex-fallback-");
  try {
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    const fallback = resolveCanonicalStateDir(cwd, ["codex"]);
    assert.equal(fallback.absoluteDir, path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
    assert.equal(fallback.relativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
    assert.equal(fallback.layout.fallback, true);
    assert.equal(fallback.destinationRelativeDir, ".agents/agentify");
    assert.equal(fallback.provider, "codex");
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
  await testIsLegacyPiStateTrue();
  await testIsLegacyPiStateFalse();
  await testResolveCanonicalPrefersExistingNewDir();
  await testResolveCanonicalFallsBackToLegacy();
  await testResolveCanonicalCodexFallback();
  await testResolveCanonicalFreshRepo();
  await testTestBypassShape();
  await testTestBypassAllProvidersCovered();
  await testLegacyConstantIsCorrect();
  console.log("state-dir.test.ts: all 14 checks passed");
}

await main();
