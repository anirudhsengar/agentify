#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf-8",
    timeout: options.timeout ?? 180_000,
  });
  if (result.error) throw result.error;
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
  const packed = run(npmCommand, ["pack", "--json", "--ignore-scripts"]);
  const packResult = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(packResult) && packResult.length === 1, "npm pack must return one artifact");
  const filename = packResult[0]?.filename;
  assert.equal(typeof filename, "string", "npm pack result must include filename");
  tarballPath = path.join(repoRoot, filename);
  assert.ok(fs.existsSync(tarballPath), `packed tarball missing: ${tarballPath}`);

  run(npmCommand, ["init", "--yes"], { cwd: installRoot });
  run(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: installRoot },
  );

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

  const version = run(bin, ["--version"], { cwd: installRoot, env, timeout: 30_000 });
  assert.equal(version.stdout.trim(), packageJson.version);

  console.log(`installed package smoke test passed (${packageJson.version}).`);
} finally {
  if (tarballPath) fs.rmSync(tarballPath, { force: true });
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
