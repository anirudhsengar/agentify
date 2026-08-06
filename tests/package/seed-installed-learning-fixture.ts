import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { initializeTeamMemoryStore } from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
  synchronizeRepositorySpecialists,
} from "../../src/core/specialists/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

const cwd = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("target repository path is required");

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function write(relativePath: string, content: string): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

fs.mkdirSync(cwd, { recursive: true });
write("package.json", `${JSON.stringify({ name: "installed-learning-fixture", private: true }, null, 2)}\n`);
for (const relativePath of [
  "src/index.ts",
  "src/lib.ts",
  "src/billing/index.ts",
  "src/billing/types.ts",
  "tests/billing.test.ts",
  "scripts/prime-db.sh",
]) {
  write(relativePath, `${relativePath}\n`);
}

git("init", "-q");
git("config", "user.name", "Agentify Package Test");
git("config", "user.email", "agentify@example.invalid");
git("add", ".");
git("commit", "-qm", "seed installed learning fixture");
const commit = git("rev-parse", "HEAD");
const observedAt = readGitCommitTimestamp(cwd, commit);
const evidence = buildSpecialistEvidenceReference({
  cwd,
  supportingCommit: commit,
  repositoryPath: "package.json",
  sourceType: "validated_bootstrap",
  observedAt,
  actor: "package-test",
});
initializeTeamMemoryStore({
  cwd,
  repositoryId: "fixture/installed-learning",
  supportingCommit: commit,
  evidence: [evidence],
  actor: "agentify-installer",
  options: { now: () => new Date(observedAt) },
});
write(
  ".agentify/runtime/audit/codebase_map.json",
  `${JSON.stringify(makeSpecialistFixtureMap(), null, 2)}\n`,
);
synchronizeRepositorySpecialists(cwd);
git("add", ".agentify");
git("commit", "-qm", "install Agentify learning baseline");
process.stdout.write(`${git("rev-parse", "HEAD")}\n`);
