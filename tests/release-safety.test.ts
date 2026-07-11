import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

function jobBlock(workflow: string, jobName: string, nextJob?: string): string {
  const startMarker = `\n  ${jobName}:`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing workflow job: ${jobName}`);
  const end = nextJob
    ? workflow.indexOf(`\n  ${nextJob}:`, start + startMarker.length)
    : workflow.length;
  assert.ok(end > start, `could not isolate workflow job: ${jobName}`);
  return workflow.slice(start, end);
}

function runTagCheck(tag: string) {
  return spawnSync(process.execPath, [".github/scripts/verify-release-tag.mjs", tag], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

async function testReleaseJobsAreTagOnly(): Promise<void> {
  const workflow = read(".github/workflows/release-publish.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read/);

  const publish = jobBlock(workflow, "publish-npm", "github-release");
  const release = jobBlock(workflow, "github-release");
  for (const [name, block] of [["publish-npm", publish], ["github-release", release]] as const) {
    const condition = block.match(/\n    if:\s*([^\n]+)/)?.[1] ?? "";
    assert.match(condition, /github\.event_name == 'push'/, `${name} must reject manual dispatch`);
    assert.match(condition, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, `${name} must require a version tag`);
  }
}

async function testExactVerifiedArtifactIsPublished(): Promise<void> {
  const workflow = read(".github/workflows/release-publish.yml");
  const verify = jobBlock(workflow, "verify", "publish-npm");
  const publish = jobBlock(workflow, "publish-npm", "github-release");
  const release = jobBlock(workflow, "github-release");

  assert.match(verify, /npm run test:package/);
  assert.match(verify, /npm pack --ignore-scripts/);
  assert.match(verify, /actions\/upload-artifact@v4/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /npm publish release-artifact\/agentify-\*\.tgz/);
  assert.match(release, /actions\/download-artifact@v4/);
  assert.match(release, /files: release-artifact\/agentify-\*\.tgz/);
  assert.doesNotMatch(publish, /npm publish --provenance/);
}

async function testTagVersionValidation(): Promise<void> {
  const packageJson = JSON.parse(read("package.json")) as { version: string };
  const valid = runTagCheck(`v${packageJson.version}`);
  assert.equal(valid.status, 0, valid.stderr);

  const mismatch = runTagCheck("v99.99.99");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match package\.json version/);

  const malformed = runTagCheck("main");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /valid semver prefixed with v/);
}

async function testCiSeparatesConcernsAndCoversEngines(): Promise<void> {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /typecheck:/);
  assert.match(workflow, /tests:/);
  assert.match(workflow, /dependency-audit:/);
  assert.match(workflow, /package-smoke:/);
  assert.match(workflow, /node: \["22\.19\.0", "24"\]/);
  assert.match(workflow, /npm run test:all/);
  assert.match(workflow, /npm run test:package/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);

  const packageJson = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.["test:package"], "node tests/package/installed-cli-smoke.mjs");
  assert.match(packageJson.scripts?.["release:check"] ?? "", /test:package/);
}

async function testDependencyReviewIsHighSeverityGate(): Promise<void> {
  const workflow = read(".github/workflows/dependency-review.yml");
  assert.match(workflow, /actions\/dependency-review-action@v4/);
  assert.match(workflow, /fail-on-severity: high/);
  assert.match(workflow, /permissions:\n  contents: read/);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "releaseJobsAreTagOnly", fn: testReleaseJobsAreTagOnly },
  { name: "exactVerifiedArtifactIsPublished", fn: testExactVerifiedArtifactIsPublished },
  { name: "tagVersionValidation", fn: testTagVersionValidation },
  { name: "ciSeparatesConcernsAndCoversEngines", fn: testCiSeparatesConcernsAndCoversEngines },
  { name: "dependencyReviewIsHighSeverityGate", fn: testDependencyReviewIsHighSeverityGate },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}
console.log(`release-safety tests passed (${passed}/${tests.length}).`);
