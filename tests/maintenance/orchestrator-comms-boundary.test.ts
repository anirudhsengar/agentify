import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

test("communications remains physically owned by the experimental orchestrator", () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "src/core/coms")), false);
  for (const relativePath of [
    "src/core/orchestrator/comms/types.ts",
    "src/core/orchestrator/comms/registry.ts",
    "src/core/orchestrator/comms/server.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, relativePath)), true, `${relativePath} must exist`);
  }
  assert.match(
    read("src/core/orchestrator/worker.ts"),
    /from "\.\/comms\/server\.ts"/,
  );
});

test("documentation names the new owner and drops the independent runtime path", () => {
  for (const documentationFile of [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/experimental-surfaces.md",
    "docs/refactors/runtime-reachability.md",
  ]) {
    assert.doesNotMatch(read(documentationFile), /`src\/core\/coms\/`/);
  }
  assert.match(read("docs/architecture.md"), /src\/core\/orchestrator\/comms\//);
  assert.match(read("AGENTS.md"), /src\/core\/orchestrator\/comms\//);
});

test("build and package boundaries do not expose the relocated transport", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    files?: string[];
    exports?: Record<string, string>;
  };
  assert.ok(!(packageJson.files ?? []).includes("src"));
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });

  const build = read("scripts/build.mjs");
  assert.doesNotMatch(build, /orchestrator["'],\s*["']comms/);
  assert.doesNotMatch(build, /["']coms["']/);

  const packageSmoke = read("tests/package/installed-cli-smoke.mjs");
  assert.match(packageSmoke, /orchestrator\/comms\/server\.ts/);
  assert.match(packageSmoke, /"dist\/orchestrator\/"/);
});
