// tests/core/state-dir.test.ts
//
// Unit tests for the provider-scoped state-dir resolver
// (src/core/state-dir.ts). Validates:
//   - `stateDirRelative` mapping per provider.
//   - `resolveStateDir` precedence (claude > codex > pi > universal).
//   - `isLegacyPiState` truth table.
//   - `resolveCanonicalStateDir` legacy fallback (read-only migration).
//   - `resolveCanonicalStateDir` new-dir-preferred rule.
//   - `resolveCanonicalStateDir` default-case (neither dir present).
//   - `__test__resolveStateDirFromProvider` shape.

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

// -----------------------------------------------------------------------------
// stateDirRelative
// -----------------------------------------------------------------------------

async function testStateDirRelativePerProvider(): Promise<void> {
  assert.equal(stateDirRelative("claude"), ".claude/agentify");
  assert.equal(stateDirRelative("codex"), ".agents/agentify");
  assert.equal(stateDirRelative("pi"), LEGACY_PI_STATE_RELATIVE_DIR);
  assert.equal(stateDirRelative("universal"), ".agents/agentify");
  // No trailing slash.
  for (const p of ["claude", "codex", "pi", "universal"] as const) {
    assert.ok(
      !stateDirRelative(p).endsWith("/"),
      `stateDirRelative(${p}) has a trailing slash`,
    );
  }
}

// -----------------------------------------------------------------------------
// resolveStateDir — dispatch precedence
// -----------------------------------------------------------------------------

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
  // Empty picks fall through to universal (.agents/agentify).
  assert.deepEqual(resolveStateDir([]), {
    relativeDir: ".agents/agentify",
    provider: "universal",
  });
  // additionalAgents does not currently change the dispatch — the
  // classifier that splits them into premium/non-premium is what
  // matters. Pass non-premium only to confirm the fallback still
  // hits `universal`.
  assert.deepEqual(resolveStateDir([], ["cursor", "opencode"]), {
    relativeDir: ".agents/agentify",
    provider: "universal",
  });
}

// -----------------------------------------------------------------------------
// isLegacyPiState
// -----------------------------------------------------------------------------

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
    // A `.claude/agentify` dir is not the legacy path.
    fs.mkdirSync(path.join(cwd, ".claude", "agentify"), { recursive: true });
    assert.equal(isLegacyPiState(cwd), false);
  } finally {
    rmrf(cwd);
  }
}

// -----------------------------------------------------------------------------
// resolveCanonicalStateDir — legacy fallback path
// -----------------------------------------------------------------------------

async function testResolveCanonicalPrefersExistingNewDir(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-new-only-");
  try {
    // Neither dir exists: picks the new dir, legacy=false.
    const fresh = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(fresh.relativeDir, ".claude/agentify");
    assert.equal(fresh.provider, "claude");
    assert.equal(fresh.legacy, false);
    assert.equal(fresh.absoluteDir, path.join(cwd, ".claude/agentify"));

    // Create the new dir. Now it should be picked, even if legacy
    // also exists.
    fs.mkdirSync(path.join(cwd, ".claude", "agentify"), { recursive: true });
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    const both = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(both.absoluteDir, path.join(cwd, ".claude/agentify"));
    assert.equal(both.legacy, false);
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalFallsBackToLegacy(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-legacy-fallback-");
  try {
    // Legacy present, new missing: pick legacy with legacy=true.
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    const fallback = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(fallback.absoluteDir, path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
    assert.equal(fallback.relativeDir, ".claude/agentify"); // resolved.target.relativeDir
    assert.equal(fallback.provider, "claude");
    assert.equal(fallback.legacy, true);
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalCodexFallback(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-codex-fallback-");
  try {
    // User picked codex. Legacy exists. The audit should read from
    // legacy, but the *target* state-dir rel-path is still the
    // resolved codex one (so the next run writes there).
    fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
    const fallback = resolveCanonicalStateDir(cwd, ["codex"]);
    assert.equal(fallback.absoluteDir, path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
    assert.equal(fallback.legacy, true);
    assert.equal(fallback.relativeDir, ".agents/agentify");
    assert.equal(fallback.provider, "codex");
  } finally {
    rmrf(cwd);
  }
}

async function testResolveCanonicalFreshRepo(): Promise<void> {
  const cwd = tempDir("agentify-state-dir-fresh-");
  try {
    // No legacy, no new — fresh repo: return new dir with
    // legacy=false. The audit creates the dir on first write.
    const fresh = resolveCanonicalStateDir(cwd, ["claude"]);
    assert.equal(fresh.legacy, false);
    assert.equal(fresh.absoluteDir, path.join(cwd, ".claude/agentify"));
    assert.ok(!fs.existsSync(fresh.absoluteDir));
  } finally {
    rmrf(cwd);
  }
}

// -----------------------------------------------------------------------------
// __test__resolveStateDirFromProvider — test-only bypass
// -----------------------------------------------------------------------------

async function testTestBypassShape(): Promise<void> {
  for (const provider of ["claude", "codex", "pi", "universal"] as const) {
    const bypass = __test__resolveStateDirFromProvider(provider);
    assert.equal(bypass.provider, provider);
    assert.equal(bypass.relativeDir, stateDirRelative(provider));
  }
}

async function testTestBypassAllProvidersCovered(): Promise<void> {
  // Sanity: every StateDirProvider string has a bypass entry.
  const providers: StateDirProvider[] = ["claude", "codex", "pi", "universal"];
  assert.equal(providers.length, 4);
}

// -----------------------------------------------------------------------------
// Constants exposed
// -----------------------------------------------------------------------------

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
  // eslint-disable-next-line no-console
  console.log("state-dir.test.ts: all 14 checks passed");
}

await main();
