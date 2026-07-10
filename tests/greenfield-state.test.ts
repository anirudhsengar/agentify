import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderGreenfieldArtifacts,
  writeGreenfieldFormation,
} from "../src/core/greenfield-artifacts.ts";
import {
  GREENFIELD_STATE_RELATIVE_PATH,
  buildGreenfieldState,
  readGreenfieldState,
  validateGreenfieldArtifacts,
  writeGreenfieldState,
} from "../src/core/greenfield-state.ts";
import { makeGreenfieldFormation } from "./fixtures/greenfield-formation.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

function writeFile(cwd: string, relativePath: string, content = "# test\n"): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeRenderedGreenfieldFormation(cwd: string): void {
  const formation = makeGreenfieldFormation();
  const rendered = renderGreenfieldArtifacts(formation);
  assert.deepEqual(rendered.errors, []);
  writeGreenfieldFormation(cwd, formation);
  for (const artifact of rendered.artifacts) {
    writeFile(cwd, artifact.relativePath, artifact.content);
  }
}

function writeValidGreenfieldArtifacts(cwd: string): void {
  writeFile(cwd, "CONTEXT.md", [
    "# Context",
    "",
    "InvoiceFlow is a local-first invoice processing product with explicit invoice, payment attempt, idempotency key, and reconciliation report concepts.",
    "",
  ].join("\n"));
  writeFile(cwd, "GOALS.md", [
    "# InvoiceFlow Goals",
    "",
    "## Final system goal",
    "",
    "Build a local-first invoice processing CLI that can import invoices, execute idempotent payment attempts, and report reconciliation outcomes.",
    "",
    "# Phase 1 - Core Invoice Loop",
    "",
    "## Goal 1: Process invoices end to end",
    "",
    "### Objective",
    "",
    "Create the first complete invoice path from import through reconciliation.",
    "",
    "### Required artifacts",
    "",
    "- PRD, plan, issue breakdown, and one build spec.",
    "",
    "### Definition of done",
    "",
    "A user can run the CLI against a fixture invoice and see a deterministic reconciliation report.",
    "",
    "### Next action",
    "",
    "Review the first implementation spec and run `/implement` after approval.",
    "",
  ].join("\n"));
  writeFile(cwd, "specs/feature-first.md", [
    "# Feature Spec: Import invoices",
    "",
    "## Relevant Files",
    "",
    "- `src/cli.ts` - command entry.",
    "- `tests/import.test.ts` - fixture-level behavior.",
    "",
    "## Steps",
    "",
    "1. Add the fixture parser.",
    "2. Expose the parser through the CLI.",
    "3. Return a deterministic reconciliation summary for review.",
    "",
    "## Validation Commands",
    "",
    "- `npm test`",
    "",
  ].join("\n"));
}

function testBuildsTypedCheckpointState(): void {
  const cwd = tempDir("greenfield-state-build");
  try {
    writeFile(cwd, "CONTEXT.md");
    writeFile(cwd, "GOALS.md");
    writeFile(cwd, "docs/prds/first.md");
    writeFile(cwd, "docs/plans/first.md");

    const state = buildGreenfieldState(cwd, {
      turns: 3,
      costUsd: 0.25,
      aborted: false,
      nowIso: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(state.schema_version, "1");
    assert.equal(state.updated_at, "2026-07-06T00:00:00.000Z");
    assert.equal(state.checkpoint, "plan");
    assert.equal(state.checkpoints.goals, true);
    assert.equal(state.checkpoints.plan, true);
    assert.equal(state.checkpoints.spec, false);
    assert.ok(state.next_actions.some((action) => action.includes("/to-issues")));
    assert.equal(state.artifact_validation.ok, false);
    assert.equal(state.resume.source, "filesystem");
    assert.equal(state.resume.stop_at, null);
    assert.ok(state.resume.artifact_paths.includes("docs/plans/first.md"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRoundTripsAndRejectsInvalidState(): void {
  const cwd = tempDir("greenfield-state-roundtrip");
  try {
    writeFile(cwd, "CONTEXT.md");
    writeFile(cwd, "GOALS.md");
    writeFile(cwd, "specs/feature-first.md");
    const written = writeGreenfieldState(cwd, {
      turns: 4,
      costUsd: null,
      aborted: false,
      nowIso: "2026-07-06T00:00:00.000Z",
    });
    assert.equal(written.checkpoint, "spec");

    const read = readGreenfieldState(cwd);
    assert.deepEqual(read, written);

    fs.writeFileSync(path.join(cwd, GREENFIELD_STATE_RELATIVE_PATH), JSON.stringify({ checkpoint: "spec" }));
    assert.equal(readGreenfieldState(cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testArtifactValidationRejectsThinArtifacts(): void {
  const cwd = tempDir("greenfield-state-thin");
  try {
    writeFile(cwd, "CONTEXT.md", "# Context\n");
    writeFile(cwd, "GOALS.md", "# Goals\n");

    const validation = validateGreenfieldArtifacts(cwd);

    assert.equal(validation.ok, false);
    assert.ok(validation.reasons.some((reason) => reason.includes("CONTEXT.md")));
    assert.ok(validation.reasons.some((reason) => reason.includes("GOALS.md")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testArtifactValidationAcceptsSubstantiveCheckpoint(): void {
  const cwd = tempDir("greenfield-state-valid");
  try {
    writeValidGreenfieldArtifacts(cwd);

    const validation = validateGreenfieldArtifacts(cwd);
    const state = buildGreenfieldState(cwd, {
      turns: 2,
      costUsd: null,
      aborted: false,
      nowIso: "2026-07-06T00:00:00.000Z",
    });

    assert.deepEqual(validation, { ok: true, reasons: [] });
    assert.equal(state.artifact_validation.ok, true);
    assert.equal(state.checkpoint, "spec");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testFormationBackedResumeContext(): void {
  const cwd = tempDir("greenfield-state-resume");
  try {
    writeRenderedGreenfieldFormation(cwd);

    const state = buildGreenfieldState(cwd, {
      turns: 2,
      costUsd: null,
      aborted: false,
      nowIso: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(state.checkpoint, "spec");
    assert.equal(state.resume.source, "formation");
    assert.equal(state.resume.stop_at, "spec");
    assert.equal(state.resume.current_focus, "Process invoices end to end");
    assert.ok(state.resume.artifact_paths.includes("docs/issues/001-import-invoices.md"));
    assert.ok(state.resume.local_resume.includes("/implement"));
    assert.ok(state.resume.github_resume.includes("agent:queued"));
    assert.equal(state.github_handoff.action, "open_implementation_issue");
    assert.equal(state.github_handoff.title, "Implement Process invoices end to end");
    assert.deepEqual(state.github_handoff.labels, ["agent:queued", "agent:implement"]);
    assert.ok(state.github_handoff.artifact_paths.includes("specs/feature-first.md"));
    assert.ok(state.github_handoff.body.includes("specs/feature-first.md"));
    assert.ok(state.github_handoff.body.includes(".pi/agentify/greenfield-state.json"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

testBuildsTypedCheckpointState();
testRoundTripsAndRejectsInvalidState();
testArtifactValidationRejectsThinArtifacts();
testArtifactValidationAcceptsSubstantiveCheckpoint();
testFormationBackedResumeContext();

console.log("greenfield-state tests passed.");
