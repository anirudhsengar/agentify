import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

test("repository specialists are deterministic memory adapters, not a generic skill installer", () => {
  const discovery = read("src/core/specialists/discovery.ts");
  const persistence = read("src/core/specialists/persistence.ts");
  const contracts = read("src/core/specialists/contracts.ts");
  const runtime = read("src/core/specialists/runtime.ts");

  assert.doesNotMatch(discovery, /skill-curation|packaged\/skills|artifact-exporters/);
  assert.doesNotMatch(persistence, /skill-curation|packaged\/skills|artifact-exporters/);
  assert.match(contracts, /mode: "read_only"/);
  assert.match(contracts, /filesystem_writes: "denied"/);
  assert.match(contracts, /github_write: "none"/);
  assert.match(persistence, /createAgentIdentity/);
  assert.match(persistence, /acceptMemoryCandidate/);
  assert.doesNotMatch(persistence, /git push|gh pr|octokit|createPullRequest/i);
  assert.match(runtime, /readTeamMemoryManifest/);
  assert.match(runtime, /loadCanonicalMapAt/);
});

test("specialist synchronization occurs during trusted finalization after the audit", () => {
  const cli = read("src/cli.ts");
  const finalization = read("src/core/installer/finalization.ts");
  const recoveryIndex = cli.indexOf("recoverTeamMemoryStore(process.cwd())");
  const runIndex = cli.indexOf("await runAgentifyApp");
  const finalizeIndex = cli.indexOf("const report = finalizeOneTimeInstallation");
  assert.ok(recoveryIndex >= 0);
  assert.ok(runIndex > recoveryIndex);
  assert.ok(finalizeIndex > runIndex);
  assert.ok(finalization.indexOf("synchronizeRepositorySpecialists(input.cwd)") > finalization.indexOf("initializePersistentTeam"));
});

test("specialist architecture and installed-package coverage stay indexed", () => {
  const docs = read("docs/README.md");
  const architecture = read("docs/architecture/repository-specialists.md");
  const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.ok(docs.includes("architecture/repository-specialists.md"));
  assert.match(architecture, /portfolio remains small/i);
  assert.match(architecture, /read-only/i);
  assert.match(architecture, /procedures/i);
  assert.match(packageJson.scripts?.["test:package"] ?? "", /exact-artifact-qualification\.mjs/);
  assert.match(read("tests/package/exact-artifact-qualification.mjs"), /installed-installer-smoke\.mjs/);
  assert.match(packageJson.scripts?.["test:specialists"] ?? "", /specialist-discovery\.test\.ts/);
});
