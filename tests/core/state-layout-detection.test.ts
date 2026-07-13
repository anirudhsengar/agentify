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
  assert.equal(resolved.relativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
  assert.equal(resolved.sourceRelativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
  assert.equal(resolved.destinationRelativeDir, ".claude/agentify");
  assert.equal(resolved.layout.kind, "legacy_only");
  assert.equal(resolved.layout.fallback, true);
  assert.equal(resolved.guidance.length, 1);
  assert.match(resolved.guidance[0]!, /no state was moved or deleted/);
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

  const switchToClaude = resolveCanonicalStateDir(cwd, ["claude"]);
  assert.equal(switchToClaude.layout.fallback, false);
  assert.equal(switchToClaude.relativeDir, ".claude/agentify");
  assert.deepEqual(switchToClaude.layout.otherProviderStateDirs, [LEGACY_PI_STATE_RELATIVE_DIR]);
});

withRepo("provider-switches", (cwd) => {
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  const claudeToCodex = resolveCanonicalStateDir(cwd, ["codex"]);
  assert.equal(claudeToCodex.relativeDir, ".agents/agentify");
  assert.deepEqual(claudeToCodex.layout.otherProviderStateDirs, [".claude/agentify"]);

  fs.rmSync(path.join(cwd, ".claude"), { recursive: true, force: true });
  writeManifest(cwd, ".agents/agentify", ".agents/agentify");
  const codexToPi = resolveCanonicalStateDir(cwd, ["pi"]);
  assert.equal(codexToPi.relativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
  assert.deepEqual(codexToPi.layout.otherProviderStateDirs, [".agents/agentify"]);

  const shared = resolveCanonicalStateDir(cwd, [], ["cursor"]);
  assert.equal(shared.relativeDir, ".agents/agentify");
  assert.equal(shared.guidance.length, 0);
});

withRepo("discovery", (cwd) => {
  writeManifest(cwd, ".claude/agentify", ".claude/agentify");
  const discovered = discoverExistingStateDir(cwd);
  assert.equal(discovered?.relativeDir, ".claude/agentify");
});

console.log("Phase A state layout detection tests passed.");
