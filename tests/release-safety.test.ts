import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8").replaceAll("\r\n", "\n");
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

async function testScopedPackageIdentityIsStable(): Promise<void> {
  const packageJson = JSON.parse(read("package.json")) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
    repository?: { type?: string; url?: string };
  };
  const packageLock = JSON.parse(read("package-lock.json")) as {
    name?: string;
    version?: string;
    packages?: Record<string, { name?: string; version?: string }>;
  };

  assert.equal(packageJson.name, "@anirudhsengar/agentify");
  assert.equal(packageJson.version, "1.1.0");
  assert.deepEqual(packageJson.bin, { agentify: "./bin/agentify.js" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "https://github.com/anirudhsengar/agentify",
  });
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages?.[""]?.name, packageJson.name);
  assert.equal(packageLock.packages?.[""]?.version, packageJson.version);
}

async function testExactVerifiedArtifactIsPublished(): Promise<void> {
  const workflow = read(".github/workflows/release-publish.yml");
  const verify = jobBlock(workflow, "verify", "publish-npm");
  const publish = jobBlock(workflow, "publish-npm", "github-release");
  const release = jobBlock(workflow, "github-release");

  assert.match(verify, /outputs:\n\s+tarball-filename: \$\{\{ steps\.pack\.outputs\.filename \}\}/);
  assert.match(verify, /npm run verify:release/);
  assert.doesNotMatch(verify, /run: npm test\n/);
  assert.match(verify, /id: pack/);
  assert.match(verify, /npm install --global npm@11\.19\.0/);
  assert.match(verify, /pack_result_path="\$\{RUNNER_TEMP\}\/pack-result\.json"/);
  assert.match(verify, /npm run --silent pack:release > "\$pack_result_path"/);
  assert.match(verify, /PACK_RESULT_PATH="\$pack_result_path" node --input-type=module --eval/);
  assert.match(verify, /JSON\.parse\(fs\.readFileSync\(process\.env\.PACK_RESULT_PATH, "utf8"\)\)/);
  assert.doesNotMatch(verify, /> pack-result\.json/, "pack metadata must not dirty the repository checkout");
  assert.doesNotMatch(verify, /<<['"]?NODE/, "pack metadata parsing must not depend on YAML-sensitive heredoc indentation");
  assert.match(verify, /non-empty filename/);
  assert.match(verify, /\[\[ ! -f "\$filename" \]\]/);
  assert.match(verify, /filename=%s\\n/);
  assert.match(verify, /path: \$\{\{ steps\.pack\.outputs\.filename \}\}/);
  assert.match(verify, /name: npm-package-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(verify, /name: npm-package-\$\{\{ github\.ref_name \}\}/);
  assert.doesNotMatch(verify, /agentify-\*\.tgz/);

  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /node-version: "24"/);
  assert.match(publish, /npm install --global npm@11\.19\.0/);
  assert.doesNotMatch(publish, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(publish, /name: npm-package-\$\{\{ github\.run_id \}\}/);
  assert.match(publish, /shopt -s nullglob/);
  assert.match(publish, /tarballs=\(\.\/release-artifact\/\*\.tgz\)/);
  assert.match(publish, /\$\{#tarballs\[@\]\} != 1/);
  assert.match(publish, /npm publish "\$\{tarballs\[0\]\}" --provenance --access public/);
  assert.match(publish, /grep -E ' \(verbose\|silly\) oidc '/);
  assert.doesNotMatch(publish, /cat .*debug/);
  assert.doesNotMatch(publish, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.doesNotMatch(publish, /npm\s+(?:pack|run\s+build)/, "publish job must not rebuild or repack");
  assert.doesNotMatch(publish, /agentify-\*\.tgz/);

  assert.match(release, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(release, /name: npm-package-\$\{\{ github\.run_id \}\}/);
  assert.match(release, /tarballs=\(\.\/release-artifact\/\*\.tgz\)/);
  assert.match(release, /\$\{#tarballs\[@\]\} != 1/);
  assert.match(release, /path=%s\\n/);
  assert.match(release, /files: \$\{\{ steps\.release-artifact\.outputs\.path \}\}/);
  assert.doesNotMatch(release, /agentify-\*\.tgz/);

  assert.doesNotMatch(workflow, /release-artifact\/agentify-\*\.tgz/);
  assert.doesNotMatch(workflow, /npm pack/, "release workflow must delegate packing to pack:release");
  assert.match(workflow, /https:\/\/www\.npmjs\.com\/package\/@anirudhsengar\/agentify/);

  const qualification = read("tests/package/exact-artifact-qualification.mjs");
  const standalone = read("tests/package/exact-artifact.mjs");
  assert.match(qualification, /\["run", "--silent", "pack:release"\]/);
  assert.match(standalone, /\["run", "--silent", "pack:release"\]/);
  assert.doesNotMatch(qualification, /\["pack"/);
  assert.doesNotMatch(standalone, /\["pack"/);
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
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.doesNotMatch(workflow, /npm audit --omit=dev/, "zero-dependency package must audit the full tree");
}

async function testReleaseVerificationContractIsComplete(): Promise<void> {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  const scripts = packageJson.scripts ?? {};
  assert.equal(
    scripts["test:package"],
    "node tests/package/exact-artifact-qualification.mjs",
  );
  assert.equal(scripts["verify:source"], "npm run typecheck && npm run test:all");
  assert.equal(scripts["verify:scaffold"], "npm run test:scaffold-e2e");
  assert.equal(scripts["verify:package"], "npm run test:package");
  assert.equal(scripts["verify:security"], "npm audit --audit-level=high");
  assert.equal(
    scripts["verify:release"],
    "npm run verify:source && npm run verify:scaffold && npm run verify:package && npm run verify:security",
  );
  assert.equal(scripts["release:check"], "npm run verify:release");
  assert.equal(scripts["pack:release"], "node scripts/pack-release.mjs");
  assert.equal(packageJson.packageManager, "npm@11.19.0");
  assert.equal(scripts.prepublishOnly, "npm run release:check");
  assert.match(scripts["test:maintenance"] ?? "", /tests\/release-safety\.test\.ts/);
  const packer = read("scripts/pack-release.mjs");
  assert.equal((packer.match(/\["pack", "--json", "--ignore-scripts"\]/g) ?? []).length, 1);
  assert.match(packer, /\["pack", "--dry-run", "--json", "--ignore-scripts"\]/);
  assert.match(packer, /Package text must use canonical LF/);
  assert.match(packer, /Refusing to overwrite existing release artifact/);
  assert.doesNotMatch(scripts["pack:release"], /prepack/);
}

async function testRepositoryTextPolicyIsCanonicalLf(): Promise<void> {
  const attributes = read(".gitattributes");
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.sh text eol=lf$/m);
  assert.match(attributes, /^\*\.tgz binary$/m);

  const reproducibility = read("scripts/verify-pack-reproducibility.mjs");
  assert.match(reproducibility, /core\.autocrlf/);
  assert.match(reproducibility, /core\.eol/);
  assert.match(reproducibility, /extracted package file bytes must match/);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "releaseJobsAreTagOnly", fn: testReleaseJobsAreTagOnly },
  { name: "scopedPackageIdentityIsStable", fn: testScopedPackageIdentityIsStable },
  { name: "exactVerifiedArtifactIsPublished", fn: testExactVerifiedArtifactIsPublished },
  { name: "tagVersionValidation", fn: testTagVersionValidation },
  { name: "ciSeparatesConcernsAndCoversEngines", fn: testCiSeparatesConcernsAndCoversEngines },
  { name: "releaseVerificationContractIsComplete", fn: testReleaseVerificationContractIsComplete },
  { name: "repositoryTextPolicyIsCanonicalLf", fn: testRepositoryTextPolicyIsCanonicalLf },
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
