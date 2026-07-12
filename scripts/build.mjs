#!/usr/bin/env node

import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "src", "cli.ts")],
  outfile: path.join(distDir, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});

const assetCopies = [
  [path.join(repoRoot, "src", "core", "audit", "prompts"), path.join(distDir, "prompts")],
  [path.join(repoRoot, "src", "core", "orchestrator", "workflows"), path.join(distDir, "workflows")],
];

for (const [source, destination] of assetCopies) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required runtime asset directory is missing: ${source}`);
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
}

for (const required of [
  path.join(distDir, "cli.js"),
  path.join(distDir, "prompts", "builder.md"),
]) {
  if (!fs.existsSync(required)) throw new Error(`Build output is missing: ${required}`);
}

console.log("compiled distribution written to dist/");
