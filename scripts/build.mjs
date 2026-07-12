#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "src");
const outputRoot = path.join(repoRoot, "dist");
const tscBin = path.join(
  repoRoot,
  "node_modules",
  "typescript",
  "bin",
  process.platform === "win32" ? "tsc" : "tsc",
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function copyRuntimeAssets(sourceDir, outputDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const outputPath = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(outputPath, { recursive: true });
      copyRuntimeAssets(sourcePath, outputPath);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".ts")) continue;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(sourcePath, outputPath);
  }
}

fs.rmSync(outputRoot, { recursive: true, force: true });
run(process.execPath, [tscBin, "--project", "tsconfig.build.json"]);
copyRuntimeAssets(sourceRoot, outputRoot);

const entrypoint = path.join(outputRoot, "cli.js");
if (!fs.existsSync(entrypoint)) {
  throw new Error(`compiled CLI entrypoint is missing: ${entrypoint}`);
}

console.log("compiled package written to dist/");
