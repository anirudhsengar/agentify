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
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-memory-package-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-memory-home-"));
const corruptRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-memory-corrupt-"));
const userOwnedRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-memory-user-owned-"));
let resolvedArtifact = null;

try {
  resolvedArtifact = resolveExactArtifact({ repoRoot, packageJson, runNpm });
  const { tarballPath } = resolvedArtifact;

  runNpm(["init", "--yes"], { cwd: installRoot });
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installRoot,
  });
  const bin = path.join(installRoot, "node_modules", packageJson.name, "bin", "agentify.js");
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CI: "1",
    NO_COLOR: "1",
  };

  fs.mkdirSync(path.join(corruptRepo, ".git"));
  fs.mkdirSync(path.join(corruptRepo, ".agentify", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(corruptRepo, ".agentify", ".gitignore"),
    "runtime/*\n!runtime/audit/\nruntime/audit/*\n!runtime/audit/codebase_map.json\nstate-transactions/\n",
  );
  fs.writeFileSync(path.join(corruptRepo, ".agentify", "manifest.json"), `${JSON.stringify({
    format: "agentify_team_memory",
    schema_version: "1",
    revision: 1,
    root: ".agentify",
    repository_id: "fixture/repo",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    entries: [],
    root_digest: "0".repeat(64),
  }, null, 2)}\n`);
  const corrupt = run(nodeCommand, [bin], {
    cwd: corruptRepo,
    env,
    timeout: 30_000,
    expectFailure: true,
  });
  assert.match(corrupt.stderr, /^agentify: team memory manifest root digest/);
  assert.doesNotMatch(corrupt.stderr, /\n\s*at |Error:/);
  assert.equal(
    fs.readFileSync(path.join(corruptRepo, ".agentify", "manifest.json"), "utf-8").includes("0".repeat(64)),
    true,
    "malformed installed memory must fail before mutation",
  );

  fs.mkdirSync(path.join(userOwnedRepo, ".git"));
  fs.mkdirSync(path.join(userOwnedRepo, ".agentify"));
  fs.writeFileSync(path.join(userOwnedRepo, ".agentify", "notes.txt"), "user-owned\n");
  const userOwned = run(nodeCommand, [bin], {
    cwd: userOwnedRepo,
    env,
    timeout: 30_000,
    expectFailure: true,
  });
  assert.doesNotMatch(userOwned.stderr, /team memory|unrecognized user-owned entry/i);
  assert.equal(
    fs.readFileSync(path.join(userOwnedRepo, ".agentify", "notes.txt"), "utf-8"),
    "user-owned\n",
  );
  assert.equal(fs.existsSync(path.join(userOwnedRepo, ".agentify", "runtime")), false);

  const deepImport = run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import('${packageJson.name}/src/core/memory/index.ts')`,
    ],
    { cwd: installRoot, env, timeout: 30_000, expectFailure: true },
  );
  assert.match(`${deepImport.stderr}\n${deepImport.stdout}`, /ERR_PACKAGE_PATH_NOT_EXPORTED/);

  writeQualificationReceipt("installed-memory-smoke.mjs", [
    "memory.corruption-rejected-before-mutation",
    "memory.user-owned-state-preserved",
    "memory.internal-import-rejected",
  ]);
  console.log(`installed memory smoke test passed (${packageJson.name}@${packageJson.version}).`);
} finally {
  removeOwnedArtifact(resolvedArtifact);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(corruptRepo, { recursive: true, force: true });
  fs.rmSync(userOwnedRepo, { recursive: true, force: true });
}
