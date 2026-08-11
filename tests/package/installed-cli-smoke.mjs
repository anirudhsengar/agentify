#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeOwnedArtifact, resolveExactArtifact } from "./exact-artifact.mjs";
import { writeQualificationReceipt } from "./qualification-receipts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const nodeCommand = process.execPath;
const npmCliPath = process.env.npm_execpath;
assert.equal(typeof npmCliPath, "string", "npm_execpath must identify the active npm CLI");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf-8",
    timeout: options.timeout ?? 600_000,
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

function runNpm(args, options = {}) {
  return run(nodeCommand, [npmCliPath, ...args], options);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
assert.equal(packageJson.name, "@anirudhsengar/agentify");
assert.deepEqual(packageJson.bin, { agentify: "./bin/agentify.js" });
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-smoke-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-home-"));
let resolvedArtifact = null;

try {
  resolvedArtifact = resolveExactArtifact({ repoRoot, packageJson, runNpm });
  const { tarballPath, artifact } = resolvedArtifact;
  assert.ok(fs.existsSync(tarballPath), `packed tarball missing: ${tarballPath}`);

  const packedPaths = new Set((artifact.files ?? []).map((entry) => entry.path));
  assert.ok(![...packedPaths].some((entry) => entry.endsWith(".map")), "source maps must remain excluded");
  for (const required of [
    "bin/agentify.js",
    "dist/cli.js",
    "dist/prompts/builder.md",
    "docs/architecture/install-once-repository-team.md",
    "docs/architecture/agent-memory.md",
    "docs/architecture/repository-specialists.md",
    "docs/architecture/continuous-learning.md",
    "docs/architecture/issue-lifecycle.md",
    "docs/architecture.md",
    "docs/build-and-package.md",
    "docs/release-process.md",
    "docs/state-lifecycle.md",
    "docs/README.md",
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
  ]) {
    assert.ok(packedPaths.has(required), `tarball is missing required artifact: ${required}`);
  }
  for (const focusedAsset of [
    "dist/task-runtime.mjs",
    "dist/learning-runtime.mjs",
    "scaffold/.github/workflows/agentify-issue.yml",
    "scaffold/.github/workflows/agentify-learn.yml",
    "scaffold/.github/agentify-task-policy.json",
    "scaffold/AGENTS.md",
    "scaffold/SETUP.md",
  ]) {
    assert.ok(packedPaths.has(focusedAsset), `tarball is missing focused runtime asset: ${focusedAsset}`);
  }
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
      `tarball must not expose internal runtime assets under ${forbiddenPrefix}`,
    );
  }

  runNpm(["init", "--yes"], { cwd: installRoot });
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot });

  const installedPackageJsonPath = path.join(installRoot, "node_modules", "@anirudhsengar", "agentify", "package.json");
  assert.ok(fs.existsSync(installedPackageJsonPath), "scoped package must install under node_modules/@anirudhsengar/agentify");
  const installedPackageJson = JSON.parse(fs.readFileSync(installedPackageJsonPath, "utf-8"));
  assert.equal(installedPackageJson.name, packageJson.name);
  assert.equal(installedPackageJson.version, packageJson.version);
  assert.deepEqual(installedPackageJson.bin, { agentify: "./bin/agentify.js" });
  assert.ok(!fs.existsSync(path.join(installRoot, "node_modules", "agentify")), "unscoped agentify package must not be installed");

  const installedRoot = path.dirname(installedPackageJsonPath);
  const shippedMarkdown = [...packedPaths].filter((entry) => entry.endsWith(".md"));
  const linkPattern = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/g;
  for (const relativePath of shippedMarkdown) {
    const source = fs.readFileSync(path.join(installedRoot, relativePath), "utf-8");
    for (const match of source.matchAll(linkPattern)) {
      const target = path.resolve(installedRoot, path.dirname(relativePath), decodeURIComponent(match[1]));
      assert.ok(fs.existsSync(target), `${relativePath} has a broken packaged link to ${match[1]}`);
    }
  }

  const bin = path.join(installRoot, "node_modules", packageJson.name, "bin", "agentify.js");
  assert.ok(fs.existsSync(bin), "installed package must expose the agentify binary");

  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CI: "1",
    NO_COLOR: "1",
  };
  const help = run(nodeCommand, [bin, "--help"], { cwd: installRoot, env, timeout: 30_000 });
  assert.match(help.stdout, /Usage:\s*\n\s*agentify \[options\]/);
  assert.match(help.stdout, /Install Agentify once in an existing GitHub repository/);
  assert.match(help.stdout, /persistent orchestrator/);
  assert.match(help.stdout, /exactly one builder/);
  assert.match(help.stdout, /role-separated automated read-only review/);
  assert.match(help.stdout, /unmerged draft pull request/);
  assert.match(help.stdout, /human\s+retains application merge authority/i);
  assert.doesNotMatch(help.stdout, /^\s*--mode\b/m);
  assert.doesNotMatch(help.stdout, /^\s*--targets\b/m);
  assert.doesNotMatch(help.stdout, /^\s*--migrate-state\b/m);
  assert.doesNotMatch(help.stdout, /^\s*--github-runtime\b/m);
  assert.doesNotMatch(help.stdout, /^\s*agentify engage\b/m);
  assert.doesNotMatch(help.stdout, /^\s*agentify eval\b/m);
  assert.equal(help.stderr, "");

  for (const [command, expected] of [
    ["login", /Usage: agentify login/],
    ["logout", /Usage: agentify logout/],
    ["models", /agentify models show \[--resolved\]/],
  ]) {
    const commandHelp = run(nodeCommand, [bin, command, "--help"], {
      cwd: installRoot,
      env,
      timeout: 30_000,
    });
    assert.match(commandHelp.stdout, expected);
    assert.equal(commandHelp.stderr, "");
  }

  const version = run(nodeCommand, [bin, "--version"], { cwd: installRoot, env, timeout: 30_000 });
  assert.equal(version.stdout, `${packageJson.version}\n`);
  assert.equal(version.stderr, "");

  const invalidOption = run(nodeCommand, [bin, "--unknown"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
    expectFailure: true,
  });
  assert.equal(invalidOption.stdout, "");
  assert.match(invalidOption.stderr, /^agentify: .*unknown option '--unknown'/i);
  assert.doesNotMatch(invalidOption.stderr, /\n\s*at |Error:/);

  const positional = run(nodeCommand, [bin, "unsupported-command"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
    expectFailure: true,
  });
  assert.equal(positional.stdout, "");
  assert.match(positional.stderr, /Known subcommands: login, logout, models/);

  const utility = run(nodeCommand, [bin, "login", "--provider", "openai-codex"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
  });
  assert.equal(utility.stderr, "");
  assert.match(utility.stdout, /OpenAI Codex uses OAuth/);
  assert.match(utility.stdout, /pi auth login openai-codex/);

  for (const internalPath of [
    "audit/prompt.ts",
    "task-lifecycle/cli.ts",
    "learning/cli.ts",
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

  for (const unsupported of ["--mode", "--targets", "--migrate-state", "--github-runtime"]) {
    const rejected = run(nodeCommand, [bin, unsupported], {
      cwd: installRoot,
      env,
      timeout: 30_000,
      expectFailure: true,
    });
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /unknown option/i);
  }

  writeQualificationReceipt("installed-cli-smoke.mjs", [
    "cli.artifact-inventory-validated",
    "cli.package-installed",
    "cli.packaged-links-resolved",
    "cli.public-contract-executed",
    "cli.internal-imports-rejected",
  ]);
  console.log(`installed compiled package smoke test passed (${packageJson.name}@${packageJson.version}).`);
} finally {
  removeOwnedArtifact(resolvedArtifact);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
