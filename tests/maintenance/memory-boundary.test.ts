import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

test("persistent memory remains an installed-CLI implementation detail", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    exports?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
  assert.ok(!(packageJson.files ?? []).includes("src"));
  assert.match(packageJson.scripts?.["test:package"] ?? "", /exact-artifact-qualification\.mjs/);
  assert.match(read("tests/package/exact-artifact-qualification.mjs"), /installed-memory-smoke\.mjs/);
  assert.match(packageJson.scripts?.["test:memory"] ?? "", /memory-schema\.test\.ts/);

  const build = read("scripts/build.mjs");
  assert.match(build, /source:\s*path\.join\(repoRoot, "src", "cli\.ts"\)/);
  assert.match(build, /outfile:\s*path\.join\(distDir, "cli\.js"\)/);
  assert.doesNotMatch(build, /memory["'],\s*["'](?:store|persistence|schema)/);

  const packageSmoke = read("tests/package/installed-memory-smoke.mjs");
  assert.match(packageSmoke, /src\/core\/memory\/index\.ts/);
  assert.match(packageSmoke, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test("memory documentation and security contracts are indexed", () => {
  const index = read("docs/README.md");
  const architecture = read("docs/architecture/agent-memory.md");
  const security = read("SECURITY.md");

  assert.ok(index.includes("architecture/agent-memory.md"));
  assert.match(architecture, /versioned repository data/i);
  assert.match(architecture, /supporting Git commit/i);
  assert.match(architecture, /real-byte hashes/i);
  assert.match(architecture, /deterministic journals/i);
  assert.match(architecture, /runtime\/.*ignored/is);
  assert.match(architecture, /unrecognized content blocks initialization/i);
  assert.match(security, /Durable records carry supporting commits/i);
  assert.match(security, /Model processes never receive GitHub write credentials/i);
});

test("the CLI recovers recognized memory before repository attachment or audit", () => {
  const cli = read("src/cli.ts");
  const recoveryIndex = cli.indexOf("recoverTeamMemoryStore(process.cwd())");
  const runIndex = cli.indexOf("await runAgentifyApp");
  assert.ok(recoveryIndex >= 0, "CLI must invoke memory recovery");
  assert.ok(runIndex > recoveryIndex, "memory recovery must precede audit/attach execution");
  assert.doesNotMatch(cli, /initializeTeamMemoryStore/);
});
