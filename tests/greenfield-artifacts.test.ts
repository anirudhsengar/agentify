import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENTIFY_MANAGED_MARKERS } from "../src/core/artifact-exporters.ts";
import {
  createWriteGreenfieldArtifactsTool,
  greenfieldFormationRelativePath,
  readGreenfieldFormationAt,
  renderGreenfieldArtifacts,
} from "../src/core/greenfield-artifacts.ts";
import { validateGreenfieldArtifacts } from "../src/core/greenfield-state.ts";
import { makeGreenfieldFormation } from "./fixtures/greenfield-formation.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

function writeRendered(cwd: string, artifacts: ReturnType<typeof renderGreenfieldArtifacts>["artifacts"]): void {
  for (const artifact of artifacts) {
    const filePath = path.join(cwd, artifact.relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, artifact.content);
  }
}

function textFrom(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

function testRendersManagedValidatedArtifacts(): void {
  const cwd = tempDir("greenfield-artifacts-render");
  try {
    const result = renderGreenfieldArtifacts(makeGreenfieldFormation());
    const paths = result.artifacts.map((artifact) => artifact.relativePath).sort();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(paths, [
      "CONTEXT.md",
      "GOALS.md",
      "docs/issues/001-import-invoices.md",
      "docs/plans/first.md",
      "docs/prds/first.md",
      "specs/feature-first.md",
    ]);
    assert.ok(result.artifacts.every((artifact) => artifact.content.includes(AGENTIFY_MANAGED_MARKERS.markdown)));

    writeRendered(cwd, result.artifacts);
    assert.deepEqual(validateGreenfieldArtifacts(cwd), { ok: true, reasons: [] });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRendersOnlyApprovedMilestone(): void {
  const cwd = tempDir("greenfield-artifacts-goals");
  try {
    const formation = makeGreenfieldFormation();
    formation.stop_at = "goals";
    delete formation.prds;
    delete formation.plans;
    delete formation.issues;
    delete formation.specs;

    const result = renderGreenfieldArtifacts(formation);
    const paths = result.artifacts.map((artifact) => artifact.relativePath).sort();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(paths, ["CONTEXT.md", "GOALS.md"]);
    writeRendered(cwd, result.artifacts);
    assert.deepEqual(validateGreenfieldArtifacts(cwd), { ok: true, reasons: [] });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsArtifactsBeyondStopGate(): void {
  const formation = makeGreenfieldFormation();
  formation.stop_at = "goals";

  const result = renderGreenfieldArtifacts(formation);

  assert.equal(result.artifacts.length, 0);
  assert.ok(result.errors.some((error) => error.includes("stop_at=goals")));
  assert.ok(result.errors.some((error) => error.includes("cannot include prds")));
}

function testRejectsMissingRequiredMilestoneArtifact(): void {
  const formation = makeGreenfieldFormation();
  formation.stop_at = "plan";
  delete formation.plans;
  delete formation.issues;
  delete formation.specs;

  const result = renderGreenfieldArtifacts(formation);

  assert.equal(result.artifacts.length, 0);
  assert.ok(result.errors.some((error) => error.includes("stop_at=plan requires at least one plans")));
}

function testRejectsDuplicateRenderedPaths(): void {
  const formation = makeGreenfieldFormation();
  formation.prds = [
    ...(formation.prds ?? []),
    {
      ...formation.prds![0]!,
      title: "Duplicate PRD",
    },
  ];

  const result = renderGreenfieldArtifacts(formation);

  assert.equal(result.artifacts.length, 0);
  assert.ok(result.errors.some((error) => error.includes("docs/prds/first.md")));
}

async function testWriteToolPersistsStructuredFormation(): Promise<void> {
  const cwd = tempDir("greenfield-artifacts-tool");
  try {
    const stateDir = ".pi/agentify";
    const tool = createWriteGreenfieldArtifactsTool({ stateDir });
    const result = await tool.execute(
      "test-greenfield-artifacts",
      makeGreenfieldFormation() as never,
      undefined,
      undefined,
      { cwd } as never,
    );

    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.match(textFrom(result), /Accepted greenfield formation/i);
    assert.ok(fs.existsSync(path.join(cwd, greenfieldFormationRelativePath(stateDir))));
    assert.equal(readGreenfieldFormationAt(cwd, stateDir)?.project_name, "InvoiceFlow");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

testRendersManagedValidatedArtifacts();
testRendersOnlyApprovedMilestone();
testRejectsArtifactsBeyondStopGate();
testRejectsMissingRequiredMilestoneArtifact();
testRejectsDuplicateRenderedPaths();
await testWriteToolPersistsStructuredFormation();

console.log("greenfield-artifacts tests passed.");
