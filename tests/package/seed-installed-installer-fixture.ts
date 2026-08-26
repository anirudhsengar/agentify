import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { initializeTeamMemoryStore } from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
} from "../../src/core/specialists/index.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

const cwd = process.argv[2];
assert.ok(cwd, "fixture repository path is required");
const profile = process.argv[3] ?? "attached";
const repository = process.argv[4] ?? "owner/repo";

function write(relativePath: string, content: string): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const scripts = profile === "readiness-fail"
  ? { build: "node --check src/index.ts" }
  : {
      typecheck: "node --input-type=module --eval \"process.exit(0)\"",
      test: "node --input-type=module --eval \"process.exit(0)\"",
    };
write("package.json", `${JSON.stringify({
  name: `installer-fixture-${profile}`,
  private: true,
  scripts,
}, null, 2)}\n`);
write("package-lock.json", `${JSON.stringify({
  name: "installer-fixture",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "installer-fixture" } },
}, null, 2)}\n`);
const layouts: Record<string, string[]> = {
  small: ["src/index.ts", "src/math.ts", "tests/math.test.ts"],
  moderate: ["src/index.ts", "src/lib.ts", "src/billing/index.ts", "src/billing/types.ts", "src/orders/index.ts", "src/shared/id.ts", "tests/billing.test.ts", "tests/orders.test.ts", "scripts/prime-db.sh"],
  monorepo: ["packages/api/src/index.ts", "packages/api/tests/index.test.ts", "packages/web/src/index.ts", "packages/shared/src/index.ts", "tools/check.mjs"],
  attached: ["src/index.ts", "src/lib.ts", "src/billing/index.ts", "src/billing/types.ts", "tests/billing.test.ts", "scripts/prime-db.sh"],
  "readiness-fail": ["src/index.ts", "src/lib.ts"],
};
const mapEvidencePaths = [
  "README.md",
  "src/index.ts",
  "src/lib.ts",
  ...SPECIALIST_FIXTURE_TRACKED_FILES,
  "src/billing/types.ts",
  "scripts/prime-db.sh",
];
for (const relativePath of new Set([
  ...mapEvidencePaths,
  ...(layouts[profile] ?? layouts.attached!),
])) write(relativePath, `${relativePath}\n`);
write(".gitignore", "node_modules/\n");

git("init", "-q");
git("config", "user.name", "Agentify Installer Fixture");
git("config", "user.email", "agentify-installer@example.invalid");
git("add", ".");
git("commit", "-qm", "installer fixture");
git("remote", "add", "origin", `https://github.com/${repository}.git`);
const commit = git("rev-parse", "HEAD");
const observedAt = readGitCommitTimestamp(cwd, commit);
initializeTeamMemoryStore({
  cwd,
  repositoryId: repository,
  supportingCommit: commit,
  evidence: [buildSpecialistEvidenceReference({
    cwd,
    supportingCommit: commit,
    repositoryPath: "package.json",
    sourceType: "validated_bootstrap",
    observedAt,
    actor: "fixture-maintainer",
  })],
  actor: "agentify-installer",
  options: { now: () => new Date(observedAt) },
});
const map = makeSpecialistFixtureMap();
if (profile === "small") {
  map.concern_evidence?.not_concerns.push({
    candidate: "src/math.ts",
    why_rejected: "Synthetic package-qualification arithmetic only; tests/math.test.ts does not represent a recurring repository specialty.",
  });
}
write(".agentify/runtime/audit/codebase_map.json", `${JSON.stringify(map, null, 2)}\n`);
