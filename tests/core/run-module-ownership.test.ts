import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const coordinator = source("src/core/run-agentify.ts");
const context = source("src/core/runs/run-context.ts");
const brownfield = source("src/core/runs/brownfield-run.ts");
const greenfield = source("src/core/runs/greenfield-run.ts");
const reporter = source("src/core/runs/project-state-reporter.ts");
const revert = source("src/core/revert.ts");

assert.match(coordinator, /createRunContext/);
assert.match(coordinator, /runBrownfieldAudit/);
assert.match(coordinator, /runGreenfield/);
assert.match(coordinator, /export async function runAgentify/);
assert.doesNotMatch(coordinator, /beginStateTransaction/);
assert.doesNotMatch(coordinator, /staging generated bundle/);
assert.doesNotMatch(coordinator, /greenfield session complete/);
assert.ok(coordinator.split("\n").length < 80, "run-agentify.ts should remain a small stable coordinator");

assert.match(context, /export interface RunContext/);
assert.match(context, /export type RunArtifactSnapshot = AuditArtifactSnapshot/);
assert.match(context, /export function createRunContext/);

assert.match(brownfield, /export async function runBrownfieldAudit/);
assert.match(brownfield, /beginStateTransaction/);
assert.match(brownfield, /collectAuditArtifactSnapshot/);
assert.match(brownfield, /runSession/);
assert.match(brownfield, /renderValidatedBrownfieldArtifacts/);
assert.match(brownfield, /applyStagedBundle/);
assert.match(brownfield, /stateTransaction\.commit/);
assert.match(brownfield, /stateTransaction\.rollback/);

assert.match(greenfield, /export async function runGreenfield/);
assert.match(greenfield, /runGreenfield\(\{/);
assert.match(greenfield, /readGreenfieldFormationAt/);
assert.match(greenfield, /renderGreenfieldArtifacts/);
assert.match(greenfield, /validateGreenfieldArtifacts/);
assert.match(greenfield, /applyStagedBundle/);

assert.match(reporter, /export function reportGitHubReadiness/);
assert.match(reporter, /export function persistProjectState/);
assert.match(reporter, /writeProjectState/);

for (const [name, content] of [
  ["brownfield-run.ts", brownfield],
  ["greenfield-run.ts", greenfield],
  ["revert.ts", revert],
] as const) {
  assert.doesNotMatch(
    content,
    /as unknown as Record<string, \{ content: Buffer/,
    `${name} must use the shared snapshot type rather than an unknown cast`,
  );
}

for (const content of [coordinator, context, brownfield, greenfield, reporter]) {
  assert.doesNotMatch(content, /class .*Workflow|service locator|generic workflow engine/i);
}

console.log("run module ownership tests passed.");
