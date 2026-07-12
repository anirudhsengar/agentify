import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectAuditArtifactSnapshot as collectFromOwner,
} from "../../src/core/generation/artifact-snapshot.ts";
import {
  applyStagedBundle as applyFromOwner,
} from "../../src/core/generation/apply-bundle.ts";
import { formatApplyReport } from "../../src/core/generation/apply-report.ts";
import {
  captureSessionAgentFiles,
  cleanupSessionAgentSnapshot,
  mirrorSessionOutputToStaging,
} from "../../src/core/generation/session-agent-snapshot.ts";
import {
  writeRenderedArtifactsToStaging as writeFromOwner,
} from "../../src/core/generation/staging-bundle.ts";
import {
  applyStagedBundle as applyFromCompatibility,
  collectAuditArtifactSnapshot as collectFromCompatibility,
  writeRenderedArtifactsToStaging as writeFromCompatibility,
} from "../../src/core/run-agentify.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-generation-owner-"));
}

function testCompatibilityExportsForwardToCanonicalOwners(): void {
  assert.equal(collectFromCompatibility, collectFromOwner);
  assert.equal(writeFromCompatibility, writeFromOwner);
  assert.equal(applyFromCompatibility, applyFromOwner);
}

function testApplyReportTextAndOrdering(): void {
  const cwd = tempDir();
  try {
    assert.deepEqual(
      formatApplyReport([
        { path: path.join(cwd, "created.md"), action: "written" },
        { path: path.join(cwd, "kept.md"), action: "skipped" },
        {
          path: path.join(cwd, "AGENTS.md"),
          action: "alongside",
          alongsidePath: "AGENTS.agentify.md",
        },
        {
          path: path.join(cwd, "blocked.md"),
          action: "conflict",
          reason: "blocked",
        },
      ], cwd),
      [
        "agentify: apply report: 1 created, 1 kept-user, 1 saved-alongside, 1 conflict(s).",
        "agentify: agentify's versions saved alongside (suffix .agentify.<ext>):",
        "agentify:   - AGENTS.md -> AGENTS.agentify.md",
        "agentify: conflicts (not written; requiredAction=abort in rc file):",
        "agentify:   - blocked.md: blocked",
      ],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testSessionAgentCaptureAndMirroring(): void {
  const cwd = tempDir();
  const stagingRoot = tempDir();
  let snapshotDir: string | null = null;
  try {
    fs.mkdirSync(path.join(cwd, ".pi/agents"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi/agents/payments.md"), "# Payments\n");
    fs.writeFileSync(path.join(cwd, ".pi/agents/scout.md"), "# Reserved\n");
    fs.writeFileSync(path.join(cwd, ".pi/agents/ignore.txt"), "ignored\n");

    snapshotDir = captureSessionAgentFiles(cwd);
    mirrorSessionOutputToStaging(snapshotDir, stagingRoot);

    const mirrored = path.join(stagingRoot, ".pi/agents/payments.md");
    assert.equal(fs.existsSync(mirrored), true);
    assert.equal(
      fs.readFileSync(mirrored, "utf8"),
      "<!-- agentify:managed -->\n# Payments\n",
    );
    assert.equal(fs.statSync(mirrored).mode & 0o777, 0o644);
    assert.equal(fs.existsSync(path.join(stagingRoot, ".pi/agents/scout.md")), false);
    assert.equal(fs.existsSync(path.join(stagingRoot, ".pi/agents/ignore.txt")), false);
  } finally {
    if (snapshotDir) cleanupSessionAgentSnapshot(snapshotDir);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

testCompatibilityExportsForwardToCanonicalOwners();
testApplyReportTextAndOrdering();
testSessionAgentCaptureAndMirroring();
console.log("generation module ownership tests passed.");
