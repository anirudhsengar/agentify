import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readManifestAt,
  sha256,
  writeManifestAt,
  type ManagedManifest,
  type ManagedManifestFile,
} from "../src/core/manifest.ts";
import { newRunId, persistRunArtifacts, revertLastRun } from "../src/core/revert.ts";
import { LEGACY_PI_STATE_RELATIVE_DIR } from "../src/core/state-dir.ts";
import type { AgentifyUi } from "../src/core/types.ts";

class TestUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  status(m: string) { this.statuses.push(m); }
  info(m: string) { this.infos.push(m); }
  error(m: string) { this.errors.push(m); }
  async promptSelect(_msg: string, _choices: ReadonlyArray<{ label: string; value: string }>): Promise<string> {
    throw new Error("no prompt");
  }
  async promptMultiSelect(_msg: string, _choices: ReadonlyArray<{ label: string; value: string; hint?: string }>): Promise<ReadonlyArray<string>> {
    throw new Error("no prompt");
  }
  async promptSecret(_msg: string): Promise<string> {
    throw new Error("no prompt");
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testRevertAlongsideRemovesAgentifyVersion(): Promise<void> {
  const cwd = tempDir("agentify-revert-alongside-");
  const stateDir = LEGACY_PI_STATE_RELATIVE_DIR;
  const userContent = "# User-authored\n";
  const agentifyContent = "<!-- agentify:managed -->\n# Agentified\n";
  const runId = "test-run-1";
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), userContent);
    fs.writeFileSync(path.join(cwd, "AGENTS.agentify.md"), agentifyContent);

    persistRunArtifacts({
      cwd, stateDir, runId,
      snapshot: {
        "AGENTS.md": {
          content: Buffer.from(userContent),
          mode: 0o644,
          ownership: "unmanaged",
        },
      },
      previousManifest: null,
    });

    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: runId,
      files: [{
        path: "AGENTS.md",
        kind: "audit",
        required: true,
        marker: "<!-- agentify:managed -->",
        sha256: sha256(agentifyContent),
        source: "managed-bundle",
        alongsidePath: "AGENTS.agentify.md",
        preservedSha256: sha256(userContent),
      } satisfies ManagedManifestFile],
    };
    writeManifestAt(cwd, manifest, stateDir);

    const result = await revertLastRun({
      cwd, stateDir, ui: new TestUi(),
    });

    assert.equal(result.alongsideRemoved.length, 1);
    assert.equal(result.alongsideRemoved[0], "AGENTS.agentify.md");
    assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.agentify.md")),
      "alongside file must be removed");
    assert.equal(
      fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8"),
      userContent,
      "user's canonical file must be unchanged",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRevertRestoresUserFileFromSnapshot(): Promise<void> {
  const cwd = tempDir("agentify-revert-snapshot-");
  const stateDir = LEGACY_PI_STATE_RELATIVE_DIR;
  const userContent = "# User-authored\n";
  const agentifyContent = "<!-- agentify:managed -->\n# Agentified\n";
  const runId = "test-run-2";
  try {
    // Pre-existing user file that agentify would have overwritten.
    fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "specs", "README.md"), userContent);
    // Write the agentified content (simulating the post-apply state).
    fs.writeFileSync(path.join(cwd, "specs", "README.md"), agentifyContent);

    // Persist the snapshot with the user's original content.
    persistRunArtifacts({
      cwd, stateDir, runId,
      snapshot: {
        "specs/README.md": {
          content: Buffer.from(userContent),
          mode: 0o644,
          ownership: "unmanaged",
        },
      },
      previousManifest: null,
    });

    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: runId,
      files: [{
        path: "specs/README.md",
        kind: "audit",
        required: true,
        marker: "<!-- agentify:managed -->",
        sha256: sha256(agentifyContent),
        source: "managed-bundle",
      }],
    };
    writeManifestAt(cwd, manifest, stateDir);

    const result = await revertLastRun({
      cwd, stateDir, ui: new TestUi(),
    });

    assert.equal(result.userRestored.length, 1);
    assert.equal(result.userRestored[0], "specs/README.md");
    assert.equal(
      fs.readFileSync(path.join(cwd, "specs", "README.md"), "utf-8"),
      userContent,
      "user's original content must be restored from snapshot",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRevertRemovesCreatedFile(): Promise<void> {
  const cwd = tempDir("agentify-revert-created-");
  const stateDir = LEGACY_PI_STATE_RELATIVE_DIR;
  const runId = "test-run-3";
  try {
    const agentifyContent = "<!-- agentify:managed -->\n# Created\n";
    fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "specs", "new-file.md"), agentifyContent);

    persistRunArtifacts({
      cwd, stateDir, runId,
      snapshot: {}, // no pre-existing files
      previousManifest: null,
    });

    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: runId,
      files: [{
        path: "specs/new-file.md",
        kind: "audit",
        required: true,
        marker: "<!-- agentify:managed -->",
        sha256: sha256(agentifyContent),
        source: "managed-bundle",
      }],
    };
    writeManifestAt(cwd, manifest, stateDir);

    const result = await revertLastRun({
      cwd, stateDir, ui: new TestUi(),
    });

    assert.equal(result.createdRemoved.length, 1);
    assert.equal(result.createdRemoved[0], "specs/new-file.md");
    assert.ok(!fs.existsSync(path.join(cwd, "specs", "new-file.md")),
      "agentify-created file must be removed");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRevertV1ManifestErrors(): Promise<void> {
  const cwd = tempDir("agentify-revert-v1-");
  const stateDir = LEGACY_PI_STATE_RELATIVE_DIR;
  try {
    // Hand-write a v1 manifest (no run_id).
    const v1: ManagedManifest = {
      schema_version: "1",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      files: [],
    };
    fs.mkdirSync(path.join(cwd, stateDir), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, stateDir, "manifest.json"),
      JSON.stringify(v1),
    );

    const ui = new TestUi();
    const result = await revertLastRun({ cwd, stateDir, ui });
    assert.ok(result.errors.includes("v1 manifest"));
    assert.ok(ui.errors.some((m) => m.includes("v1")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRevertRestoresPreviousManifest(): Promise<void> {
  const cwd = tempDir("agentify-revert-prev-manifest-");
  const stateDir = LEGACY_PI_STATE_RELATIVE_DIR;
  const runId = "test-run-prev";
  try {
    const previous: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-06-01T00:00:00.000Z",
      mode: "brownfield",
      run_id: "previous-run",
      files: [{
        path: "AGENTS.md",
        kind: "audit",
        required: true,
        marker: "<!-- agentify:managed -->",
        sha256: sha256("old content"),
        source: "managed-bundle",
      }],
    };
    const current: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: runId,
      files: [],
    };

    persistRunArtifacts({
      cwd, stateDir, runId,
      snapshot: {},
      previousManifest: previous,
    });
    writeManifestAt(cwd, current, stateDir);

    await revertLastRun({ cwd, stateDir, ui: new TestUi() });

    const restored = readManifestAt(cwd, stateDir);
    assert.ok(restored);
    assert.equal(restored.run_id, "previous-run",
      "previous manifest should be restored, not the current one");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRevertKeepAlongsideFlag(): Promise<void> {
  const cwd = tempDir("agentify-revert-keep-");
  const stateDir = LEGACY_PI_STATE_RELATIVE_DIR;
  const userContent = "# User\n";
  const agentifyContent = "<!-- agentify:managed -->\n# Agentified\n";
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), userContent);
    fs.writeFileSync(path.join(cwd, "AGENTS.agentify.md"), agentifyContent);

    persistRunArtifacts({
      cwd, stateDir, runId: "test-run-keep",
      snapshot: {
        "AGENTS.md": {
          content: Buffer.from(userContent),
          mode: 0o644,
          ownership: "unmanaged",
        },
      },
      previousManifest: null,
    });

    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: "test-run-keep",
      files: [{
        path: "AGENTS.md",
        kind: "audit",
        required: true,
        marker: "<!-- agentify:managed -->",
        sha256: sha256(agentifyContent),
        source: "managed-bundle",
        alongsidePath: "AGENTS.agentify.md",
        preservedSha256: sha256(userContent),
      }],
    };
    writeManifestAt(cwd, manifest, stateDir);

    const result = await revertLastRun({
      cwd, stateDir, ui: new TestUi(), includeAlongside: false,
    });

    assert.equal(result.kept.length, 1);
    assert.ok(fs.existsSync(path.join(cwd, "AGENTS.agentify.md")),
      "alongside file must be kept when includeAlongside=false");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "revertAlongsideRemovesAgentifyVersion", fn: testRevertAlongsideRemovesAgentifyVersion },
  { name: "revertRestoresUserFileFromSnapshot", fn: testRevertRestoresUserFileFromSnapshot },
  { name: "revertRemovesCreatedFile", fn: testRevertRemovesCreatedFile },
  { name: "revertV1ManifestErrors", fn: testRevertV1ManifestErrors },
  { name: "revertRestoresPreviousManifest", fn: testRevertRestoresPreviousManifest },
  { name: "revertKeepAlongsideFlag", fn: testRevertKeepAlongsideFlag },
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
console.log(`revert tests passed (${passed}/${tests.length}).`);
