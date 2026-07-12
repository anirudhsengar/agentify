import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { AGENTIFY_MANAGED_MARKERS } from "../../src/core/artifact-exporters.ts";
import { DEFAULT_APPLY_POLICY } from "../../src/core/apply-policy.ts";
import { renderValidatedBrownfieldArtifacts } from "../../src/core/artifacts/renderers.ts";
import { renderGreenfieldArtifacts } from "../../src/core/greenfield-artifacts.ts";
import { readManifestAt } from "../../src/core/manifest.ts";
import type { CodebaseMap } from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { makeGreenfieldFormation } from "../fixtures/greenfield-formation.ts";
import {
  PARITY_STATE_DIR,
  applyBrownfieldFixture,
  makeParityTempDir,
  readGeneratedTree,
} from "./helpers/generated-tree.ts";

const FIXED_TIMESTAMP = "2026-07-12T00:00:00.000Z";
const SELECTED_CASE = process.env["AGENTIFY_PARITY_CASE"];
const USER_AGENTS = "# Developer-owned instructions\n\nKeep exactly.\n";
const USER_FEATURE_AGENT = "# User payments notes\n";

function skipUnless(caseName: string): boolean {
  return SELECTED_CASE !== undefined && SELECTED_CASE !== caseName;
}

function fixedCodebaseMap(): CodebaseMap {
  return makeValidCodebaseMap({
    generated_at: FIXED_TIMESTAMP,
    exploration_log: [
      {
        ts: FIXED_TIMESTAMP,
        action: "fixture",
        target: "src/",
        observation: "Synthetic map for the modernization parity baseline.",
      },
    ],
  });
}

function removeTree(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function seedUserOwnedFiles(cwd: string): void {
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), USER_AGENTS);
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agents", "payments.md"), USER_FEATURE_AGENT);
}

test(
  "brownfield and greenfield renderers preserve deterministic path inventories",
  { skip: skipUnless("render") },
  () => {
    const map = fixedCodebaseMap();
    const firstBrownfield = renderValidatedBrownfieldArtifacts(map);
    const secondBrownfield = renderValidatedBrownfieldArtifacts(map);
    assert.deepEqual(secondBrownfield, firstBrownfield);
    assert.deepEqual(firstBrownfield.validationErrors, []);
    assert.deepEqual(firstBrownfield.errors, []);
    assert.deepEqual(
      firstBrownfield.artifacts.map((artifact) => artifact.relativePath).sort(),
      [
        ".pi/agents/payments.md",
        ".pi/conditional_docs.md",
        ".pi/prompts/bug.md",
        ".pi/prompts/feature.md",
        ".pi/workflows/payments-plan-build-review-fix.json",
        "AGENTS.md",
        "ai_docs/README.md",
        "app_docs/README.md",
        "app_docs/agentic_kpis.md",
        "app_fix_reports/README.md",
        "app_review/README.md",
        "specs/README.md",
      ],
    );

    const formation = makeGreenfieldFormation();
    const firstGreenfield = renderGreenfieldArtifacts(formation);
    const secondGreenfield = renderGreenfieldArtifacts(formation);
    assert.deepEqual(secondGreenfield, firstGreenfield);
    assert.deepEqual(firstGreenfield.errors, []);
    assert.deepEqual(
      firstGreenfield.artifacts.map((artifact) => artifact.relativePath).sort(),
      [
        "CONTEXT.md",
        "GOALS.md",
        "docs/issues/001-import-invoices.md",
        "docs/plans/first.md",
        "docs/prds/first.md",
        "specs/feature-first.md",
      ],
    );
  },
);

test(
  "first apply preserves user-owned files and records deterministic alongside output",
  { skip: skipUnless("apply-user") },
  () => {
    const cwd = makeParityTempDir("agentify-parity-apply-user-");
    try {
      seedUserOwnedFiles(cwd);
      const result = applyBrownfieldFixture(cwd, fixedCodebaseMap(), "parity-run-one");
      assert.ok(result.applied?.manifest);
      assert.equal(result.applied.requiredConflictCount, 0);
      assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8"), USER_AGENTS);
      assert.equal(
        fs.readFileSync(path.join(cwd, ".pi", "agents", "payments.md"), "utf-8"),
        USER_FEATURE_AGENT,
      );
      assert.ok(result.applied.writes.some((write) =>
        write.action === "alongside" && write.path.endsWith("AGENTS.md")
      ));
      assert.ok(result.applied.writes.some((write) =>
        write.action === "alongside" && write.path.endsWith("payments.md")
      ));
      assert.ok(fs.existsSync(path.join(cwd, "AGENTS.agentify.md")));
      assert.ok(fs.existsSync(path.join(cwd, ".pi", "agents", "payments.agentify.md")));

      const manifest = readManifestAt(cwd, PARITY_STATE_DIR);
      assert.ok(manifest);
      assert.equal(manifest.state_dir, PARITY_STATE_DIR);
      assert.equal(manifest.run_id, "parity-run-one");
      assert.deepEqual(
        manifest.files.map((file) => file.path),
        manifest.files.map((file) => file.path).sort(),
      );
    } finally {
      removeTree(cwd);
    }
  },
);

test(
  "repeated identical apply preserves normalized repository bytes",
  { skip: skipUnless("apply-repeat") },
  () => {
    const cwd = makeParityTempDir("agentify-parity-apply-repeat-");
    try {
      seedUserOwnedFiles(cwd);
      const map = fixedCodebaseMap();
      const first = applyBrownfieldFixture(cwd, map, "parity-run-one");
      assert.ok(first.applied?.manifest);
      const firstStableTree = readGeneratedTree(cwd, {
        normalizeVolatileManifestFields: true,
      });

      const second = applyBrownfieldFixture(cwd, map, "parity-run-two");
      assert.ok(second.applied?.manifest);
      assert.ok(second.applied.writes.some((write) => write.action === "skipped"));
      assert.deepEqual(
        readGeneratedTree(cwd, { normalizeVolatileManifestFields: true }),
        firstStableTree,
      );
      assert.equal(readManifestAt(cwd, PARITY_STATE_DIR)?.run_id, "parity-run-two");
    } finally {
      removeTree(cwd);
    }
  },
);

test(
  "managed files update at their canonical path",
  { skip: skipUnless("apply-managed") },
  () => {
    const cwd = makeParityTempDir("agentify-parity-apply-managed-");
    try {
      const map = fixedCodebaseMap();
      const first = applyBrownfieldFixture(cwd, map, "parity-managed-first");
      assert.ok(first.applied?.manifest);
      const managedPath = path.join(cwd, "specs", "README.md");
      const staleManagedContent = `${AGENTIFY_MANAGED_MARKERS.markdown}\n# stale managed content\n`;
      fs.writeFileSync(managedPath, staleManagedContent);

      const update = applyBrownfieldFixture(cwd, map, "parity-managed-update");
      assert.ok(update.applied?.manifest);
      assert.notEqual(fs.readFileSync(managedPath, "utf-8"), staleManagedContent);
      assert.ok(update.applied.writes.some((write) =>
        write.action === "written" && write.path === managedPath
      ));
    } finally {
      removeTree(cwd);
    }
  },
);

test(
  "required conflicts abort the complete bundle with zero writes",
  { skip: skipUnless("conflict") },
  () => {
    const cwd = makeParityTempDir("agentify-parity-required-conflict-");
    try {
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# user owned\n");
      const before = readGeneratedTree(cwd);
      const result = applyBrownfieldFixture(
        cwd,
        fixedCodebaseMap(),
        "parity-required-conflict",
        { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" },
      );
      assert.equal(result.applied?.manifest, null);
      assert.equal(result.applied?.requiredConflictCount, 1);
      assert.deepEqual(readGeneratedTree(cwd), before);
    } finally {
      removeTree(cwd);
    }
  },
);

test(
  "symlink destinations and ancestors cannot escape the repository",
  { skip: process.platform === "win32" || skipUnless("symlink") },
  () => {
    const cwd = makeParityTempDir("agentify-parity-symlink-cwd-");
    const outside = makeParityTempDir("agentify-parity-symlink-outside-");
    try {
      const outsideAgents = path.join(outside, "AGENTS.md");
      fs.writeFileSync(outsideAgents, "outside agents\n");
      fs.symlinkSync(outsideAgents, path.join(cwd, "AGENTS.md"));

      const destinationResult = applyBrownfieldFixture(
        cwd,
        fixedCodebaseMap(),
        "parity-symlink-destination",
        { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" },
      );
      assert.equal(destinationResult.applied?.manifest, null);
      assert.equal(destinationResult.applied?.requiredConflictCount, 1);
      assert.equal(fs.readFileSync(outsideAgents, "utf-8"), "outside agents\n");

      fs.rmSync(path.join(cwd, "AGENTS.md"));
      const outsideSpecs = path.join(outside, "specs");
      fs.mkdirSync(outsideSpecs);
      const outsideReadme = path.join(outsideSpecs, "README.md");
      fs.writeFileSync(outsideReadme, "outside specs\n");
      fs.symlinkSync(outsideSpecs, path.join(cwd, "specs"));

      const ancestorResult = applyBrownfieldFixture(
        cwd,
        fixedCodebaseMap(),
        "parity-symlink-ancestor",
        { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" },
      );
      assert.equal(ancestorResult.applied?.manifest, null);
      assert.equal(ancestorResult.applied?.requiredConflictCount, 1);
      assert.equal(fs.readFileSync(outsideReadme, "utf-8"), "outside specs\n");
    } finally {
      removeTree(cwd);
      removeTree(outside);
    }
  },
);
