// tests/agentify-config-migration.test.ts — one-shot migration of legacy
// `modelsByRole.scoring` key to `modelsByRole.lite`. Verifies:
//   1. legacy config gets rewritten transparently on first read
//   2. the rewritten file contains `lite` and no longer contains `scoring`
//   3. a subsequent read is a no-op (no second rewrite, mtime unchanged)
//   4. when both `scoring` and `lite` are present, `lite` wins
//   5. a fresh config (no `modelsByRole`) is left alone

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configPath,
  loadAgentifyConfig,
} from "../src/core/agentify-config.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readConfig(configDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath(configDir), "utf-8")) as Record<string, unknown>;
}

async function migrateLegacyScoringKeyToLite(): Promise<void> {
  const configDir = tempDir("agentify-migrate-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Hand-write a pre-rename config with a `scoring` slot key.
    fs.writeFileSync(
      configPath(configDir),
      JSON.stringify(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          modelsByRole: {
            primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
            scoring: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          },
        },
        null,
        2,
      ),
    );
    const loaded = loadAgentifyConfig(configDir);
    // The migration transparently renamed `scoring` -> `lite`.
    assert.deepEqual(
      loaded.modelsByRole?.lite,
      { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    );
    // On disk: `lite` is present and `scoring` is gone.
    const onDisk = readConfig(configDir);
    const slotBlock = onDisk.modelsByRole as Record<string, unknown>;
    assert.ok(slotBlock.lite, "on-disk config must contain `lite` after migration");
    assert.equal(slotBlock.scoring, undefined, "on-disk config must not contain `scoring` after migration");
    // Primary is preserved unchanged.
    assert.deepEqual(
      slotBlock.primary,
      { provider: "anthropic", model: "claude-sonnet-4-6" },
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function migrateIsIdempotent(): Promise<void> {
  const configDir = tempDir("agentify-migrate-idem-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      configPath(configDir),
      JSON.stringify({
        modelsByRole: {
          primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
          scoring: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
      }),
    );
    // First read triggers migration + persist.
    loadAgentifyConfig(configDir);
    const mtimeAfterFirstRead = fs.statSync(configPath(configDir)).mtimeMs;
    // Sleep at least 10ms so a second write would observably bump mtime.
    await new Promise((r) => setTimeout(r, 20));
    // Second read: already migrated, must not re-write.
    loadAgentifyConfig(configDir);
    const mtimeAfterSecondRead = fs.statSync(configPath(configDir)).mtimeMs;
    assert.equal(
      mtimeAfterFirstRead,
      mtimeAfterSecondRead,
      "second loadAgentifyConfig must not re-write the file (migration is idempotent)",
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function migrateBothKeysPresentPrefersLite(): Promise<void> {
  const configDir = tempDir("agentify-migrate-both-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      configPath(configDir),
      JSON.stringify({
        modelsByRole: {
          primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
          // Both keys present (defensive — shouldn't happen in practice).
          scoring: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          lite: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
      }),
    );
    const loaded = loadAgentifyConfig(configDir);
    assert.deepEqual(
      loaded.modelsByRole?.lite,
      { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    );
    const onDisk = readConfig(configDir);
    const slotBlock = onDisk.modelsByRole as Record<string, unknown>;
    assert.equal(slotBlock.scoring, undefined, "`scoring` must be dropped when both are present");
    assert.ok(slotBlock.lite, "`lite` must survive when both are present");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function freshConfigIsNotMigrated(): Promise<void> {
  const configDir = tempDir("agentify-migrate-fresh-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // No file at all — fresh install. readJsonObject returns {} and the
    // migration is a no-op.
    const loaded = loadAgentifyConfig(configDir);
    assert.equal(loaded.modelsByRole, undefined);
    // No file should be created by the migration (no save call).
    assert.equal(fs.existsSync(configPath(configDir)), false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "migrateLegacyScoringKeyToLite", fn: migrateLegacyScoringKeyToLite },
  { name: "migrateIsIdempotent", fn: migrateIsIdempotent },
  { name: "migrateBothKeysPresentPrefersLite", fn: migrateBothKeysPresentPrefersLite },
  { name: "freshConfigIsNotMigrated", fn: freshConfigIsNotMigrated },
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
console.log(`agentify-config-migration tests passed (${passed}/${tests.length}).`);