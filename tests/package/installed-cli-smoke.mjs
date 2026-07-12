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
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-smoke-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-home-"));
let tarballPath = null;

try {
  run(npmCommand, ["run", "build"]);
  const packed = run(npmCommand, ["pack", "--json", "--ignore-scripts"]);
  const packResult = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(packResult) && packResult.length === 1, "npm pack must return one artifact");
  const artifact = packResult[0];
  const filename = artifact?.filename;
  assert.equal(typeof filename, "string", "npm pack result must include filename");
  tarballPath = path.join(repoRoot, filename);
  assert.ok(fs.existsSync(tarballPath), `packed tarball missing: ${tarballPath}`);

  const packedPaths = new Set((artifact.files ?? []).map((entry) => entry.path));
  for (const required of [
    "bin/agentify.js",
    "dist/cli.js",
    "dist/prompts/builder.md",
    "docs/README.md",
    "docs/architecture.md",
    "docs/build-and-package.md",
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

  run(npmCommand, ["init", "--yes"], { cwd: installRoot });
  run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot });

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
  assert.match(positional.stderr, /Known subcommands: login, logout, models, revert/);

  const utility = run(bin, ["login", "--provider", "openai-codex"], {
    cwd: installRoot,
    env,
    timeout: 30_000,
  });
  assert.equal(utility.stderr, "");
  assert.match(utility.stdout, /OpenAI Codex uses OAuth/);
  assert.match(utility.stdout, /pi auth login openai-codex/);

  const deepImport = run(
    nodeCommand,
    ["--input-type=module", "--eval", "import('agentify/src/core/audit/prompt.ts')"],
    { cwd: installRoot, env, timeout: 30_000, expectFailure: true },
  );
  assert.match(`${deepImport.stderr}\n${deepImport.stdout}`, /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find package/);

  console.log(`installed compiled package smoke test passed (${packageJson.version}).`);
} finally {
  if (tarballPath) fs.rmSync(tarballPath, { force: true });
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
