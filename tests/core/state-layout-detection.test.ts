import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  StateLayoutError,
  assertStateLayoutUsable,
  classifyStateLayout,
  discoverExistingStateDir,
  resolveCanonicalStateDir,
} from "../../src/core/state-dir.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(cwd: string, relativePath: string, value: unknown): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMap(cwd: string, stateDir: string, marker: string): void {
  writeJson(cwd, path.join(stateDir, "codebase_map.json"), { marker });
}

function writeManifest(cwd: string, stateDir: string, recordedStateDir?: string): void {
  writeJson(cwd, path.join(stateDir, "manifest.json"), {
    schema_version: "2",
    agentify_version: "test",
    generated_at: "2026-07-13T00:00:00.000Z",
    mode: "brownfield",
    run_id: "run-test",
    ...(recordedStateDir === undefined ? {} : { state_dir: recordedStateDir }),
    files: [],
  });
}

function withRepo(name: string, run: (cwd: string) => void): void {
  const cwd = tempDir(`agentify-layout-${name}-`);
  try {
    run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

withRepo("empty", (cwd) => {
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "empty");
  assert.equal(layout.fallback, false);
});

withRepo("legacy-only", (cwd) => {
  writeMap(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "legacy");
  const resolved = resolveCanonicalStateDir(cwd, ["claude"]);
  assert.equal(resolved.relativeDir, ".claude/agentify");
  assert.equal(resolved.sourceRelativeDir, ".claude/agentify");
  assert.equal(resolved.destinationRelativeDir, ".claude/agentify");
  assert.equal(resolved.layout.kind, "dual_identical");
  assert.equal(resolved.layout.fallback, false);
  assert.ok(resolved.migrationRunId);
  assert.equal(resolved.guidance.length, 2);
  assert.match(resolved.guidance[0]!, /migrating retained legacy state/);
  assert.match(resolved.guidance[1]!, /legacy state remains/);
});

withRepo("canonical-only", (cwd) => {
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "canonical_only");
  assert.equal(layout.sourceRelativeDir, ".claude/agentify");
});

withRepo("dual-identical", (cwd) => {
  writeMap(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "same");
  writeMap(cwd, ".claude/agentify", "same");
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "dual_identical");
  assert.doesNotThrow(() => assertStateLayoutUsable(layout));
});


withRepo("explicit-canonical-authority-retains-stale-legacy", (cwd) => {
  writeMap(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "retained legacy");
  writeMap(cwd, ".claude/agentify", "new canonical");
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "canonical_only");
  assert.equal(layout.sourceRelativeDir, ".claude/agentify");
  assert.doesNotThrow(() => assertStateLayoutUsable(layout));
  const discovered = discoverExistingStateDir(cwd);
  assert.equal(discovered?.relativeDir, ".claude/agentify");
  assert.equal(discovered?.duplicateLegacyDir, LEGACY_PI_STATE_RELATIVE_DIR);
});

withRepo("dual-divergent", (cwd) => {
  writeMap(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "legacy");
  writeMap(cwd, ".claude/agentify", "canonical");
  const sentinel = path.join(cwd, "sentinel.txt");
  fs.writeFileSync(sentinel, "unchanged\n");
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "dual_divergent");
  assert.throws(
    () => assertStateLayoutUsable(layout),
    (error: unknown) => error instanceof StateLayoutError
      && error.code === "dual_divergent"
      && /no files were changed/.test(error.message),
  );
  assert.equal(fs.readFileSync(sentinel, "utf-8"), "unchanged\n");
});

withRepo("partial", (cwd) => {
  fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "partial");
  assert.equal(layout.fallback, true);
});

withRepo("user-owned", (cwd) => {
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "agentify"), "user file\n");
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "user_owned");
  assert.throws(() => assertStateLayoutUsable(layout), /unsafe state path/);
});

withRepo("symlink", (cwd) => {
  fs.mkdirSync(path.join(cwd, "outside"), { recursive: true });
  fs.symlinkSync(path.join(cwd, "outside"), path.join(cwd, ".claude"), "dir");
  const layout = classifyStateLayout(cwd, ".claude/agentify");
  assert.equal(layout.kind, "symlink_unsafe");
  assert.throws(() => assertStateLayoutUsable(layout), /is a symlink/);
});

withRepo("unreadable", (cwd) => {
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  const overlongRelativeDir = `.claude/${"x".repeat(300)}`;
  const layout = classifyStateLayout(cwd, overlongRelativeDir);
  assert.equal(layout.kind, "unreadable");
  assert.throws(() => assertStateLayoutUsable(layout), /unsafe state path/);
});

if (process.platform !== "win32") {
  withRepo("permission-denied", (cwd) => {
    writeMap(cwd, ".claude/agentify", "protected");
    const statePath = path.join(cwd, ".claude/agentify");
    fs.chmodSync(statePath, 0o000);
    try {
      let permissionEnforced = false;
      try {
        fs.readdirSync(statePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        permissionEnforced = code === "EACCES" || code === "EPERM";
      }
      if (permissionEnforced) {
        const layout = classifyStateLayout(cwd, ".claude/agentify");
        assert.equal(layout.kind, "permission_denied");
        assert.throws(() => assertStateLayoutUsable(layout), /no files were changed/);
      }
    } finally {
      fs.chmodSync(statePath, 0o700);
    }
  });
}

withRepo("pi-canonical", (cwd) => {
  writeManifest(cwd, LEGACY_PI_STATE_RELATIVE_DIR, LEGACY_PI_STATE_RELATIVE_DIR);
  const pi = resolveCanonicalStateDir(cwd, ["pi"]);
  assert.equal(pi.layout.kind, "canonical_only");
  assert.equal(pi.layout.fallback, false);
  assert.equal(pi.relativeDir, LEGACY_PI_STATE_RELATIVE_DIR);

  assert.throws(
    () => resolveCanonicalStateDir(cwd, ["claude"]),
    /existing provider state is present|manifest state_dir .* does not match physical state directory|unsafe state path/,
  );
});


withRepo("explicit-provider-switches", (cwd) => {
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  writeMap(cwd, ".claude/agentify", "claude");
  const switched = resolveCanonicalStateDir(
    cwd, ["codex"], [], { allowProviderSwitchMigration: true },
  );
  assert.equal(switched.relativeDir, ".agents/agentify");
  assert.equal(switched.layout.kind, "canonical_only");
  assert.ok(switched.migrationRunId);
  assert.ok(fs.existsSync(path.join(cwd, ".claude/agentify/manifest.json")));
  const installed = JSON.parse(
    fs.readFileSync(path.join(cwd, ".agents/agentify/manifest.json"), "utf-8"),
  ) as { state_dir?: string };
  assert.equal(installed.state_dir, ".agents/agentify");
});

withRepo("provider-switches", (cwd) => {
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  assert.throws(
    () => resolveCanonicalStateDir(cwd, ["codex"]),
    /existing provider state is present/,
  );

  fs.rmSync(path.join(cwd, ".claude"), { recursive: true, force: true });
  writeManifest(cwd, ".agents/agentify", ".agents/agentify");
  assert.throws(
    () => resolveCanonicalStateDir(cwd, ["pi"]),
    /existing provider state is present/,
  );

  const shared = resolveCanonicalStateDir(cwd, [], ["cursor"]);
  assert.equal(shared.relativeDir, ".agents/agentify");
  assert.equal(shared.guidance.length, 0);
});

withRepo("discovery", (cwd) => {
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  const discovered = discoverExistingStateDir(cwd);
  assert.equal(discovered?.relativeDir, ".claude/agentify");
});

console.log("Phase B state layout detection tests passed.");
