import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

const packageJson = JSON.parse(read("package.json")) as {
  files?: string[];
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const buildConfig = JSON.parse(read("tsconfig.build.json")) as {
  compilerOptions?: Record<string, unknown>;
};
const bin = read("bin/agentify.js");
const builder = read("scripts/build.mjs");

assert.ok(packageJson.files?.includes("dist"), "published files must include dist/");
assert.ok(!packageJson.files?.includes("src"), "published files must exclude src/");
assert.equal(packageJson.dependencies?.jiti, undefined, "jiti must not be a runtime dependency");
assert.equal(packageJson.scripts?.build, "node scripts/build.mjs");
assert.equal(packageJson.scripts?.prepack, "npm run build");
assert.match(bin, /from "\.\.\/dist\/cli\.js"/);
assert.doesNotMatch(bin, /jiti|src\/cli\.ts/);
assert.equal(buildConfig.compilerOptions?.rewriteRelativeImportExtensions, true);
assert.equal(buildConfig.compilerOptions?.outDir, "dist");
assert.match(builder, /copyRuntimeAssets/);
assert.match(builder, /entry\.name\.endsWith\("\.ts"\)/);

console.log("compiled package configuration tests passed.");
