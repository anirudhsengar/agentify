#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf-8",
    timeout: options.timeout ?? 180_000,
  });
  if (result.error) throw result.error;
  if (options.expectFailure === true) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
    return result;
  }
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
assert.equal(packageJson.name, "@anirudhsengar/agentify");
assert.deepEqual(packageJson.bin, { agentify: "./bin/agentify.js" });
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-smoke-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-home-"));
const priorVersionRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-prior-version-repo-"));
let tarballPath = null;

try {
  run(npmCommand, ["run", "build"]);
  const packed = run(npmCommand, ["pack", "--json", "--ignore-scripts"]);
  const packResult = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(packResult) && packResult.length === 1, "npm pack must return one artifact");
  const artifact = packResult[0];
  assert.equal(artifact?.name, packageJson.name, "npm pack must preserve the scoped package identity");
  assert.equal(artifact?.version, packageJson.version, "npm pack must preserve the release version");
  const filename = artifact?.filename;
  assert.equal(typeof filename, "string", "npm pack result must include filename");
  assert.ok(filename.trim().length > 0, "npm pack filename must be non-empty");
  tarballPath = path.join(repoRoot, filename);
  assert.ok(fs.existsSync(tarballPath), `packed tarball missing: ${tarballPath}`);

  const packedPaths = new Set((artifact.files ?? []).map((entry) => entry.path));
  for (const required of [
    "bin/agentify.js",
    "dist/cli.js",
    "dist/prompts/builder.md",
    "docs/README.md",
    "docs/architecture.md",
    "docs/architecture/dependency-compatibility-matrix.md",
    "docs/architecture/experimental-runtime-decisions.md",
    "docs/build-and-package.md",
    "docs/experimental-surfaces.md",
    "docs/eval-architecture.md",
    "docs/eval-grader-authoring.md",
    "docs/autonomy-and-promotion.md",
    "docs/github-draft-mode.md",
    "docs/refactors/modernization-baseline.md",
    "docs/refactors/runtime-reachability.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
  ]) {
    assert.ok(packedPaths.has(required), `tarball is missing required artifact: ${required}`);
  }
  assert.ok(
    [...packedPaths].some((entry) => entry.startsWith("dist/workflows/") && entry.endsWith(".json")),
    "tarball must include packaged workflow assets",
  );
  assert.ok(![...packedPaths].some((entry) => entry.startsWith("src/")), "tarball must not publish raw src/");
  assert.ok(![...packedPaths].some((entry) => entry.includes("jiti")), "tarball must not publish jiti runtime files");
  for (const packedPath of packedPaths) {
    assert.ok(!packedPath.endsWith(".tgz"), `tarball must not contain nested tarballs: ${packedPath}`);
    assert.ok(!packedPath.includes("pack-result.json"), `tarball must not contain pack metadata: ${packedPath}`);
    assert.ok(!packedPath.includes("release-artifact"), `tarball must not contain release scratch files: ${packedPath}`);
    assert.ok(!packedPath.includes(".tmp"), `tarball must not contain temporary files: ${packedPath}`);
  }
  for (const forbiddenPrefix of [
    "dist/webhook/",
    "dist/aiw/",
    "dist/orchestrator/",
    "dist/agent-expert",
  ]) {
    assert.ok(
      ![...packedPaths].some((entry) => entry.startsWith(forbiddenPrefix)),
      `tarball must not expose experimental runtime assets under ${forbiddenPrefix}`,
    );
  }

  run(npmCommand, ["init", "--yes"], { cwd: installRoot });
  run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot });

  const installedPackageJsonPath = path.join(installRoot, "node_modules", "@anirudhsengar", "agentify", "package.json");
  assert.ok(fs.existsSync(installedPackageJsonPath), "scoped package must install under node_modules/@anirudhsengar/agentify");
  const installedPackageJson = JSON.parse(fs.readFileSync(installedPackageJsonPath, "utf-8"));
  assert.equal(installedPackageJson.name, packageJson.name);
  assert.equal(installedPackageJson.version, packageJson.version);
  assert.deepEqual(installedPackageJson.bin, { agentify: "./bin/agentify.js" });
  assert.ok(!fs.existsSync(path.join(installRoot, "node_modules", "agentify")), "unscoped agentify package must not be installed");

  const bin = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agentify.cmd" : "agentify",
  );
  assert.ok(fs.existsSync(bin), "installed package must expose the agentify binary");

  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CI: "1",
    NO_COLOR: "1",
  };
  const help = run(bin, ["--help"], { cwd: installRoot, env, timeout: 30_000 });
  assert.match(help.stdout, /Usage:\s*\n\s*agentify \[options\]/);
  assert.match(help.stdout, /--mode <kind>/);
  assert.match(help.stdout, /--targets <csv>/);
  assert.equal(help.stderr, "");

  const version = run(bin, ["--version"], { cwd: installRoot, env, timeout: 30_000 });
  assert.equal(version.stdout, `${packageJson.version}\n`);
  assert.equal(version.stderr, "");

  const invalidOption = run(bin, ["--unknown"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
    expectFailure: true,
  });
  assert.equal(invalidOption.stdout, "");
  assert.match(invalidOption.stderr, /^agentify: .*unknown option '--unknown'/i);
  assert.doesNotMatch(invalidOption.stderr, /\n\s*at |Error:/);

  const positional = run(bin, ["unsupported-command"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
    expectFailure: true,
  });
  assert.equal(positional.stdout, "");
  assert.match(positional.stderr, /Known subcommands: login, logout, models, revert, engage, eval/);

  const engageHelp = run(bin, ["engage", "help"], { cwd: installRoot, env, timeout: 30_000 });
  assert.match(engageHelp.stdout, /agentify engage <init\|status\|validate\|report\|promotion>/);
  assert.match(engageHelp.stdout, /promotion <status\|evaluate\|approve\|revoke>/);
  assert.match(engageHelp.stdout, /agentify engage init --input engagement\.json --yes/);
  assert.equal(engageHelp.stderr, "");

  const evalHelp = run(bin, ["eval", "help"], { cwd: installRoot, env, timeout: 30_000 });
  assert.match(evalHelp.stdout, /agentify eval <run\|report\|validate>/);
  assert.match(evalHelp.stdout, /task files cannot supply shell commands/);
  assert.equal(evalHelp.stderr, "");

  const engageMissingRepo = run(bin, ["engage", "status"], { cwd: installRoot, env, timeout: 30_000, expectFailure: true });
  assert.match(engageMissingRepo.stderr, /engage requires a Git repository/);

  const engageRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-engage-"));
  fs.mkdirSync(path.join(engageRepo, ".git"));
  const engageInput = path.join(engageRepo, "engagement.json");
  fs.writeFileSync(engageInput, `${JSON.stringify({
    repository: { root: engageRepo, remote: null }, workflow_name: "Package Review", workflow_owner: "Operations",
    intended_users: ["analyst"], systems_involved: ["ledger"], problem_statement: "Review is slow.", workflow_frequency: "daily",
    baseline_metrics: [{ name: "cycle", unit: "minutes", value: 20 }], desired_primary_outcome: "Reduce cycle time",
    target: { direction: "decrease", value: 10, unit: "minutes" }, guardrail_metrics: [], forbidden_actions: [],
    requires_human_approval: true, business_owner: "Finance", technical_owner: "Platform", evidence_references: [],
  }, null, 2)}\n`);
  const engageInit = run(bin, ["engage", "init", "--input", engageInput, "--yes"], { cwd: engageRepo, env, timeout: 30_000 });
  assert.match(engageInit.stdout, /Created engagement package-review/);
  const engageStatus = run(bin, ["engage", "status"], { cwd: engageRepo, env, timeout: 30_000 });
  assert.match(engageStatus.stdout, /Lifecycle: draft/);
  assert.match(engageStatus.stdout, /Missing artifacts:/);
  fs.rmSync(engageRepo, { recursive: true, force: true });

  const utility = run(bin, ["login", "--provider", "openai-codex"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
  });
  assert.equal(utility.stderr, "");
  assert.match(utility.stdout, /OpenAI Codex uses OAuth/);
  assert.match(utility.stdout, /pi auth login openai-codex/);

  for (const internalPath of [
    "audit/prompt.ts",
    "webhook/index.ts",
    "aiw/index.ts",
    "orchestrator/host.ts",
    "orchestrator/comms/server.ts",
    "coms/server.ts",
    "agent-expert.ts",
  ]) {
    const deepImport = run(
      nodeCommand,
      ["--input-type=module", "--eval", `import('${packageJson.name}/src/core/${internalPath}')`],
      { cwd: installRoot, env, timeout: 30_000, expectFailure: true },
    );
    assert.match(
      `${deepImport.stderr}\n${deepImport.stdout}`,
      /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    );
  }

  const legacyStateDir = path.join(priorVersionRepo, ".pi", "agentify");
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyStateDir, "manifest.json"),
    `${JSON.stringify({
      schema_version: "1",
      agentify_version: "0.1.0",
      generated_at: "2026-01-01T00:00:00.000Z",
      mode: "brownfield",
      files: [],
    }, null, 2)}\n`,
  );
  const legacyAttach = run(bin, ["--targets", "claude-code"], {
    cwd: priorVersionRepo,
    env,
    timeout: 30_000,
  });
  assert.equal(legacyAttach.stderr, "");
  assert.match(legacyAttach.stdout, /attached to initialized brownfield repo/);
  assert.match(legacyAttach.stdout, /migrating retained legacy state \.pi\/agentify -> \.claude\/agentify/);
  assert.match(legacyAttach.stdout, /inspecting state at \.claude\/agentify/);
  assert.ok(fs.existsSync(path.join(priorVersionRepo, ".pi", "agentify", "manifest.json")));
  assert.ok(fs.existsSync(path.join(priorVersionRepo, ".claude", "agentify", "manifest.json")));
  assert.ok(!fs.existsSync(path.join(priorVersionRepo, ".agents", "agentify")));

  console.log(`installed compiled package smoke test passed (${packageJson.name}@${packageJson.version}).`);
} finally {
  if (tarballPath) fs.rmSync(tarballPath, { force: true });
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(priorVersionRepo, { recursive: true, force: true });
}
