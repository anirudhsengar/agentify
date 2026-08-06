#!/usr/bin/env node

import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const piSdkPackage = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  "utf8",
));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(piSdkPackage.version ?? "")) {
  throw new Error("installed pi-coding-agent package has no valid semantic version");
}
const esmBanner = {
  js: `import { createRequire as __agentifyCreateRequire } from "node:module"; const require = __agentifyCreateRequire(import.meta.url);`,
};

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const entry of [
  {
    source: path.join(repoRoot, "src", "cli.ts"),
    outfile: path.join(distDir, "cli.js"),
  },
  {
    source: path.join(repoRoot, "src", "core", "learning", "cli.ts"),
    outfile: path.join(distDir, "learning-runtime.mjs"),
  },
  {
    source: path.join(repoRoot, "src", "core", "task-lifecycle", "cli.ts"),
    outfile: path.join(distDir, "task-runtime.mjs"),
  },
]) {
  await build({
    entryPoints: [entry.source],
    outfile: entry.outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: esmBanner,
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    define: {
      __AGENTIFY_BUNDLED_PI_SDK_VERSION__: JSON.stringify(piSdkPackage.version),
    },
  });
}

const assetCopies = [
  [path.join(repoRoot, "src", "core", "audit", "prompts"), path.join(distDir, "prompts")],
];

for (const [source, destination] of assetCopies) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required runtime asset directory is missing: ${source}`);
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
}

for (const required of [
  path.join(distDir, "cli.js"),
  path.join(distDir, "learning-runtime.mjs"),
  path.join(distDir, "task-runtime.mjs"),
  path.join(distDir, "prompts", "builder.md"),
]) {
  if (!fs.existsSync(required)) throw new Error(`Build output is missing: ${required}`);
}

console.log("compiled distribution written to dist/");
