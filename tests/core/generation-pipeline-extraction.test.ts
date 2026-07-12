import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_APPLY_POLICY } from "../../src/core/apply-policy.ts";
import type { RenderedArtifact } from "../../src/core/artifacts/renderers.ts";
import {
  manifestFileFromContent,
  manifestRelativePath,
  type ManagedManifestFile,
} from "../../src/core/manifest.ts";
import {
  applyStagedBundle,
  collectAuditArtifactSnapshot,
  writeRenderedArtifactsToStaging,
} from "../../src/core/run-agentify.ts";

const STATE_DIR = ".pi/agentify";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-generation-extraction-"));
}

function testSnapshotOwnershipContentAndModes(): void {
  const cwd = tempDir();
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# user owned\n", { mode: 0o600 });
    fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "specs/README.md"),
      "<!-- agentify:managed -->\n# Managed specs\n",
      { mode: 0o640 },
    );
    fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
    fs.writeFileSync(path.join(cwd, STATE_DIR, "codebase_map.json"), "{}\n", { mode: 0o600 });

    const snapshot = collectAuditArtifactSnapshot(cwd);
    assert.equal(snapshot.get("AGENTS.md")?.ownership, "unmanaged");
    assert.equal(snapshot.get("AGENTS.md")?.content.toString("utf8"), "# user owned\n");
    assert.equal(snapshot.get("AGENTS.md")?.mode, 0o600);
    assert.equal(snapshot.get("specs/README.md")?.ownership, "managed");
    assert.equal(snapshot.get("specs/README.md")?.mode, 0o640);
    assert.equal(snapshot.get(`${STATE_DIR}/codebase_map.json`)?.ownership, "managed");
    assert.equal(snapshot.get(`${STATE_DIR}/codebase_map.json`)?.mode, 0o600);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRenderedArtifactStagingMetadata(): void {
  const stagingRoot = tempDir();
  try {
    const artifact: RenderedArtifact = {
      relativePath: "specs/README.md",
      content: "<!-- agentify:managed -->\n# Specs\n",
      marker: "<!-- agentify:managed -->",
      kind: "audit",
      required: false,
      source: "characterization-test",
    };
    const metadata = new Map<string, ManagedManifestFile>();

    writeRenderedArtifactsToStaging(stagingRoot, [artifact], metadata);

    const stagedPath = path.join(stagingRoot, artifact.relativePath);
    assert.equal(fs.readFileSync(stagedPath, "utf8"), artifact.content);
    assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o644);
    assert.deepEqual(
      metadata.get(artifact.relativePath),
      manifestFileFromContent({
        relativePath: artifact.relativePath,
        content: artifact.content,
        kind: artifact.kind,
        required: artifact.required,
        marker: artifact.marker,
        source: artifact.source,
      }),
    );
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function testRequiredConflictPreflightWritesNothing(): void {
  const cwd = tempDir();
  const stagingRoot = tempDir();
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# user owned\n");
    const metadata = new Map<string, ManagedManifestFile>();
    const artifacts: RenderedArtifact[] = [
      {
        relativePath: "AGENTS.md",
        content: "<!-- agentify:managed -->\n# Generated\n",
        marker: "<!-- agentify:managed -->",
        kind: "audit",
        required: true,
        source: "characterization-test",
      },
      {
        relativePath: "specs/README.md",
        content: "<!-- agentify:managed -->\n# Specs\n",
        marker: "<!-- agentify:managed -->",
        kind: "audit",
        required: false,
        source: "characterization-test",
      },
    ];
    writeRenderedArtifactsToStaging(stagingRoot, artifacts, metadata);

    const result = applyStagedBundle({
      cwd,
      stagingRoot,
      snapshot: collectAuditArtifactSnapshot(cwd),
      metadata,
      agentifyVersion: "test",
      mode: "brownfield",
      policy: { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" },
      runId: "characterization",
      stateDir: STATE_DIR,
    });

    assert.equal(result.requiredConflictCount, 1);
    assert.equal(result.manifest, null);
    assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), "# user owned\n");
    assert.equal(fs.existsSync(path.join(cwd, "specs/README.md")), false);
    assert.equal(fs.existsSync(path.join(cwd, manifestRelativePath(STATE_DIR))), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

testSnapshotOwnershipContentAndModes();
testRenderedArtifactStagingMetadata();
testRequiredConflictPreflightWritesNothing();
console.log("generation pipeline extraction characterization tests passed.");
