import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const PACKAGE_NAME = "@anirudhsengar/agentify";

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

async function testPackageIdentityIsScopedWithoutRenamingCli(): Promise<void> {
  const packageJson = JSON.parse(read("package.json")) as {
    name: string;
    version: string;
    bin?: Record<string, string>;
  };
  const packageLock = JSON.parse(read("package-lock.json")) as {
    name: string;
    version: string;
    packages?: Record<string, { name?: string; version?: string }>;
  };

  assert.equal(packageJson.name, PACKAGE_NAME);
  assert.equal(packageJson.version, "0.2.1");
  assert.deepEqual(packageJson.bin, { agentify: "./bin/agentify.js" });
  assert.equal(packageLock.name, PACKAGE_NAME);
  assert.equal(packageLock.packages?.[""]?.name, PACKAGE_NAME);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages?.[""]?.version, packageJson.version);

  const readme = read("README.md");
  assert.match(readme, /npm install -g @anirudhsengar\/agentify/);
  assert.match(readme, /npx @anirudhsengar\/agentify/);
  assert.match(readme, /npmjs\.com\/package\/@anirudhsengar\/agentify/);
  assert.doesNotMatch(readme, /npm install -g agentify(?:@|\s|$)/);
  assert.doesNotMatch(readme, /\bnpx agentify(?:\s|$)/);

  const releaseDrafter = read(".github/release-drafter.yml");
  assert.match(releaseDrafter, /npm install -g @anirudhsengar\/agentify@\$RESOLVED_VERSION/);
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
  assert.match(verify, /id: pack/);
  assert.match(verify, /npm pack --json --ignore-scripts > pack-result\.json/);
  assert.match(verify, /JSON\.parse\(fs\.readFileSync\("pack-result\.json"/);
  assert.match(verify, /results\.length !== 1/);
  assert.match(verify, /non-empty filename/);
  assert.match(verify, /\[\[ ! -f "\$filename" \]\]/);
  assert.match(verify, /printf 'filename=%s\\n' "\$filename" >> "\$GITHUB_OUTPUT"/);
  assert.match(verify, /actions\/upload-artifact@v4/);
  assert.match(verify, /path: \$\{\{ steps\.pack\.outputs\.filename \}\}/);

  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /shell: bash/);
  assert.match(publish, /shopt -s nullglob/);
  assert.match(publish, /tarballs=\(\.\/release-artifact\/\*\.tgz\)/);
  assert.match(publish, /\$\{#tarballs\[@\]\} != 1/);
  assert.match(publish, /Expected exactly one release tarball/);
  assert.match(publish, /npm publish "\$\{tarballs\[0\]\}" --provenance --access public/);
  assert.doesNotMatch(
    publish,
    /npm publish\s+["']?release-artifact\//,
    "npm publish must receive the resolved explicit local tarball path",
  );
  assert.doesNotMatch(publish, /npm\s+(?:pack|run\s+build)/, "publish job must not rebuild the verified artifact");

  assert.match(release, /actions\/download-artifact@v4/);
  assert.match(release, /id: release-artifact/);
  assert.match(release, /tarballs=\(\.\/release-artifact\/\*\.tgz\)/);
  assert.match(release, /\$\{#tarballs\[@\]\} != 1/);
  assert.match(release, /printf 'filename=%s\\n' "\$\{tarballs\[0\]\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(release, /files: \$\{\{ steps\.release-artifact\.outputs\.filename \}\}/);
  assert.match(release, /fail_on_unmatched_files: true/);
  assert.doesNotMatch(release, /npm\s+(?:pack|run\s+build)/, "GitHub release job must not rebuild the verified artifact");

  assert.match(workflow, /url: https:\/\/www\.npmjs\.com\/package\/@anirudhsengar\/agentify/);
  assert.doesNotMatch(workflow, /agentify-\*\.tgz/, "release workflow must not assume an unscoped tarball filename");
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
  assert.match(packageJson.scripts?.["test:maintenance"] ?? "", /tests\/release-safety\.test\.ts/);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "packageIdentityIsScopedWithoutRenamingCli", fn: testPackageIdentityIsScopedWithoutRenamingCli },
  { name: "releaseJobsAreTagOnly", fn: testReleaseJobsAreTagOnly },
  { name: "exactVerifiedArtifactIsPublished", fn: testExactVerifiedArtifactIsPublished },
  { name: "tagVersionValidation", fn: testTagVersionValidation },
  { name: "ciSeparatesConcernsAndCoversEngines", fn: testCiSeparatesConcernsAndCoversEngines },
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
