#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  combineQualificationReceipts,
  QUALIFICATION_RECEIPT_ENV,
  readQualificationReceipt,
} from "./qualification-receipts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const nodeCommand = process.execPath;
const npmCliPath = process.env.npm_execpath;
assert.equal(typeof npmCliPath, "string", "npm_execpath must identify the active npm CLI");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const startedAt = new Date().toISOString();
const started = Date.now();
const initialRepositoryStatus = spawnSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: repoRoot, encoding: "utf8" },
);
assert.equal(initialRepositoryStatus.status, 0, initialRepositoryStatus.stderr);
const INSTALLED_SMOKE_SCRIPTS = [
  "installed-cli-smoke.mjs",
  "installed-memory-smoke.mjs",
  "installed-learning-smoke.mjs",
  "installed-task-lifecycle-smoke.mjs",
  "installed-installer-smoke.mjs",
];

function run(command, args, options = {}) {
  const began = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 15 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return { ...result, runtimeMs: Date.now() - began };
}

function npm(args, options = {}) {
  return run(nodeCommand, [npmCliPath, ...args], options);
}

const retainedRootValue = process.env.AGENTIFY_QUALIFICATION_EVIDENCE_DIR?.trim();
const retainedRoot = retainedRootValue ? path.resolve(retainedRootValue) : null;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-exact-artifact-qualification-"));
const receiptDirectory = path.join(scratch, "receipts");
const results = [];
let tarballPath = null;

try {
  const packed = npm(["run", "--silent", "pack:release"]);
  const artifact = JSON.parse(packed.stdout);
  assert.equal(artifact.name, packageJson.name);
  assert.equal(artifact.version, packageJson.version);
  tarballPath = path.resolve(repoRoot, artifact.filename);
  const stat = fs.statSync(tarballPath);
  assert.ok(stat.isFile() && stat.size > 0);
  const inventory = (artifact.inventory ?? []).map((entry) => ({
    path: entry.path,
    size: entry.size,
    mode: entry.mode,
  }));
  assert.ok(inventory.length > 0, "npm artifact inventory must be complete");

  const sharedEnv = {
    ...process.env,
    AGENTIFY_TEST_TARBALL: tarballPath,
    [QUALIFICATION_RECEIPT_ENV]: receiptDirectory,
    CI: "1",
    NO_COLOR: "1",
  };
  for (const script of INSTALLED_SMOKE_SCRIPTS) {
    const execution = run(nodeCommand, [path.join(repoRoot, "tests", "package", script)], {
      env: sharedEnv,
    });
    process.stdout.write(execution.stdout);
    if (execution.stderr) process.stderr.write(execution.stderr);
    results.push({
      script,
      exit_code: execution.status,
      runtime_ms: execution.runtimeMs,
      receipt: readQualificationReceipt(receiptDirectory, script),
    });
  }
  const receipts = combineQualificationReceipts(
    results.map((result) => result.receipt),
    INSTALLED_SMOKE_SCRIPTS,
  );

  const evidence = {
    schema_version: "1",
    qualification: "agentify_exact_installed_artifact",
    source_commit: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
    package: {
      name: artifact.name,
      version: artifact.version,
      filename: artifact.filename,
      bytes: artifact.packedBytes,
      unpacked_bytes: artifact.unpackedBytes,
      sha256: artifact.sha256,
      inventory_count: inventory.length,
      inventory,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: artifact.nodeVersion,
      npm: artifact.npmVersion,
    },
    installed_smokes: results,
    executed_checks: receipts.flatMap((receipt) => (
      receipt.checks.map((check) => ({ check, script: receipt.script }))
    )),
    limitations: [
      "A passing smoke receipt proves only the checks executed by that installed-artifact script.",
      "Source, scaffold, security-redteam, and release-audit suites are separate gates and are not restated as scenario-level claims here.",
      "The deterministic fixtures do not establish live-model quality, customer adoption, production safety, or independent human review.",
    ],
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    runtime_ms: Date.now() - started,
  };
  const localEvidence = path.join(scratch, "exact-artifact-qualification.json");
  fs.writeFileSync(localEvidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  if (retainedRoot) {
    fs.mkdirSync(retainedRoot, { recursive: true });
    const retainedArtifact = path.join(retainedRoot, artifact.filename);
    fs.copyFileSync(tarballPath, retainedArtifact);
    fs.copyFileSync(localEvidence, path.join(retainedRoot, "exact-artifact-qualification.json"));
    process.stdout.write(`exact artifact retained at ${retainedArtifact}\n`);
  }
  process.stdout.write(
    `exact installed artifact qualification passed (${artifact.filename}, ${evidence.package.sha256}, ${inventory.length} entries).\n`,
  );
  fs.rmSync(tarballPath, { force: true });
  tarballPath = null;
  assert.equal(
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim(),
    initialRepositoryStatus.stdout.trim(),
    "exact-artifact qualification must leave the working tree unchanged",
  );
} finally {
  if (tarballPath) fs.rmSync(tarballPath, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
