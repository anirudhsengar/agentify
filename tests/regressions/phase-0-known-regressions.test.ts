import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  expectKnownRegression,
  regressionStillPresent,
} from "../helpers/known-regression.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

function jobHasTagOnlyGuard(workflow: string, jobName: string, endMarker?: string): boolean {
  const startMarker = `\n  ${jobName}:`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing release job: ${jobName}`);
  const end = endMarker ? workflow.indexOf(endMarker, start + startMarker.length) : workflow.length;
  assert.ok(end > start, `could not isolate release job: ${jobName}`);
  const block = workflow.slice(start, end);
  const jobIf = block.match(/\n    if:\s*([^\n]+)/)?.[1] ?? "";
  return /github\.event_name/.test(jobIf) && /refs\/tags\/v/.test(jobIf);
}

function assertManualReleaseCannotPublish(): void {
  const workflow = readSource(".github/workflows/release-publish.yml");
  const jobs: ReadonlyArray<readonly [string, string?]> = [
    ["publish-npm", "\n  github-release:"],
    ["github-release"],
  ];
  const unguardedJobs = jobs
    .filter(([jobName, endMarker]) => !jobHasTagOnlyGuard(workflow, jobName, endMarker))
    .map(([jobName]) => jobName);
  if (unguardedJobs.length > 0) {
    regressionStillPresent(`manual dispatch can reach unguarded jobs: ${unguardedJobs.join(", ")}`);
  }
}

const regressions: Array<{ name: string; invariant: () => void | Promise<void> }> = [
  {
    name: "manual release dispatch cannot reach publication jobs",
    invariant: assertManualReleaseCannotPublish,
  },
];

let passed = 0;
for (const regression of regressions) {
  try {
    await expectKnownRegression(regression.name, regression.invariant);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${regression.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}

console.log(`phase-0 known regressions recorded (${passed}/${regressions.length}).`);
