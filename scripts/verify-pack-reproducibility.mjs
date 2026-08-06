#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const npmCliPath = process.env.npm_execpath;
assert.equal(typeof npmCliPath, "string", "verify:pack-reproducibility must run through npm");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function npm(cwd, args) {
  return run(process.execPath, [npmCliPath, ...args], { cwd });
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileMap(root) {
  const result = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) result.set(path.relative(root, absolutePath).replaceAll("\\", "/"), sha256(absolutePath));
      else throw new Error(`Unexpected extracted entry type: ${absolutePath}`);
    }
  };
  visit(root);
  return result;
}

const initialStatus = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim();
assert.equal(initialStatus, "", "cross-line-ending qualification requires a clean committed source tree");
const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-pack-reproducibility-"));
const configurations = [
  { id: "lf", settings: [["core.autocrlf", "false"], ["core.eol", "lf"]] },
  { id: "autocrlf", settings: [["core.autocrlf", "true"]] },
];
const results = [];

try {
  for (const configuration of configurations) {
    const checkout = path.join(scratch, configuration.id);
    run("git", ["clone", "--no-checkout", "--no-local", repoRoot, checkout], { cwd: scratch });
    for (const [key, value] of configuration.settings) run("git", ["config", key, value], { cwd: checkout });
    run("git", ["checkout", "--detach", commit], { cwd: checkout });
    npm(checkout, ["ci", "--ignore-scripts"]);
    const packed = npm(checkout, ["run", "--silent", "pack:release"]);
    const metadata = JSON.parse(packed.stdout);
    const artifactPath = path.join(checkout, metadata.filename);
    const extracted = path.join(scratch, `${configuration.id}-extracted`);
    fs.mkdirSync(extracted);
    run("tar", ["-xf", artifactPath, "-C", extracted]);
    results.push({ configuration: configuration.id, checkout, artifactPath, metadata, extractedFiles: fileMap(extracted) });
  }

  const [first, second] = results;
  for (const field of ["name", "version", "packedBytes", "unpackedBytes", "inventoryCount", "sha256"]) {
    assert.equal(first.metadata[field], second.metadata[field], `cross-line-ending ${field} mismatch`);
  }
  assert.deepEqual([...first.extractedFiles], [...second.extractedFiles], "extracted package file bytes must match");
  process.stdout.write(`${JSON.stringify({
    commit,
    nodeVersion: process.version,
    npmVersion: first.metadata.npmVersion,
    results: results.map(({ configuration, metadata }) => ({ configuration, ...metadata, inventory: undefined })),
  }, null, 2)}\n`);
} finally {
  if (process.env.AGENTIFY_RETAIN_PACK_REPRODUCIBILITY !== "1") fs.rmSync(scratch, { recursive: true, force: true });
  else process.stderr.write(`retained cross-line-ending evidence at ${scratch}\n`);
}
