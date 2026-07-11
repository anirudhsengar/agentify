#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const testsRoot = path.join(repoRoot, "tests");
const testFilePattern = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;
const typeScriptTestPattern = /\.test\.(?:ts|mts|cts)$/;

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
      } else if (entry.isFile() && testFilePattern.test(entry.name)) {
        discovered.push(normalizeRepoPath(absolute));
      }
    }
  };
  visit(root);
  return discovered.sort((left, right) => left.localeCompare(right));
}

function commandFor(testPath) {
  if (typeScriptTestPattern.test(testPath)) {
    return {
      command: process.platform === "win32" ? "tsx.cmd" : "tsx",
      args: [testPath],
    };
  }
  return { command: process.execPath, args: [testPath] };
}

function main() {
  const { excluded } = parseArgs(process.argv.slice(2));
  const tests = discoverTestFiles(testsRoot).filter((testPath) => !excluded.has(testPath));
  if (tests.length === 0) throw new Error("no test files were discovered");

  console.log(`Discovered ${tests.length} test files.`);

  for (const testPath of tests) {
    console.log(`\n==> ${testPath}`);
    const invocation = commandFor(testPath);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  console.log(`\nAll ${tests.length} discovered test files passed.`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`test discovery failed: ${message}`);
  process.exit(1);
}
