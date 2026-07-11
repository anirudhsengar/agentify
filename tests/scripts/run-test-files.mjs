#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const testsRoot = path.join(repoRoot, "tests");

function normalizeRepoPath(value) {
  return path.relative(repoRoot, path.resolve(repoRoot, value)).split(path.sep).join("/");
}

function parseArgs(argv) {
  const excluded = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--exclude") {
      const value = argv[index + 1];
      if (!value) throw new Error("--exclude requires a repository-relative test path");
      excluded.add(normalizeRepoPath(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      const value = arg.slice("--exclude=".length);
      if (!value) throw new Error("--exclude requires a repository-relative test path");
      excluded.add(normalizeRepoPath(value));
      continue;
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  return { excluded };
}

function discoverTestFiles(root) {
  const discovered = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        discovered.push(normalizeRepoPath(absolute));
      }
    }
  };
  visit(root);
  return discovered.sort((left, right) => left.localeCompare(right));
}

function main() {
  const { excluded } = parseArgs(process.argv.slice(2));
  const tests = discoverTestFiles(testsRoot).filter((testPath) => !excluded.has(testPath));
  if (tests.length === 0) throw new Error("no TypeScript test files were discovered");

  const tsxCommand = process.platform === "win32" ? "tsx.cmd" : "tsx";
  console.log(`Discovered ${tests.length} TypeScript test files.`);

  for (const testPath of tests) {
    console.log(`\n==> ${testPath}`);
    const result = spawnSync(tsxCommand, [testPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  console.log(`\nAll ${tests.length} discovered TypeScript test files passed.`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`test discovery failed: ${message}`);
  process.exit(1);
}
