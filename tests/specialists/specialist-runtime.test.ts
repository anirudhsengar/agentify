import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { initializeTeamMemoryStore } from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
  synchronizeRepositorySpecialists,
} from "../../src/core/specialists/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, relativePath: string, content = `${relativePath}\n`): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

test("runtime synchronization consumes the canonical map only after memory bootstrap", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-specialist-runtime-"));
  try {
    const absent = synchronizeRepositorySpecialists(cwd);
    assert.equal(absent.status, "memory_absent");

    for (const relativePath of [
      "package.json",
      "src/index.ts",
      "src/lib.ts",
      "src/billing/index.ts",
      "src/billing/types.ts",
      "tests/billing.test.ts",
      "scripts/prime-db.sh",
    ]) {
      write(cwd, relativePath);
    }
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "runtime fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const observedAt = readGitCommitTimestamp(cwd, commit);
    const evidence = buildSpecialistEvidenceReference({
      cwd,
      supportingCommit: commit,
      repositoryPath: "package.json",
      sourceType: "validated_bootstrap",
      observedAt,
      actor: "test-maintainer",
    });
    initializeTeamMemoryStore({
      cwd,
      repositoryId: "fixture/runtime",
      supportingCommit: commit,
      evidence: [evidence],
      options: { now: () => new Date(observedAt) },
    });
    write(
      cwd,
      ".agentify/runtime/audit/codebase_map.json",
      `${JSON.stringify(makeSpecialistFixtureMap(), null, 2)}\n`,
    );

    const synchronized = synchronizeRepositorySpecialists(cwd);
    assert.equal(synchronized.status, "synchronized");
    if (synchronized.status !== "synchronized") return;
    assert.equal(synchronized.state_dir, ".agentify/runtime/audit");
    assert.deepEqual(synchronized.materialized.created_specialist_ids, ["specialist-billing"]);
    assert.ok(fs.existsSync(path.join(
      cwd,
      ".agentify/agents/specialists/specialist-billing.json",
    )));

    const repeated = synchronizeRepositorySpecialists(cwd);
    assert.equal(repeated.status, "synchronized");
    if (repeated.status !== "synchronized") return;
    assert.deepEqual(repeated.materialized.created_specialist_ids, []);
    assert.deepEqual(repeated.materialized.updated_specialist_ids, []);
    assert.deepEqual(repeated.materialized.unchanged_specialist_ids, ["specialist-billing"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime leaves an unrecognized user-owned manifest untouched", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-specialist-user-owned-"));
  try {
    const manifestPath = path.join(cwd, ".agentify", "manifest.json");
    write(cwd, ".agentify/manifest.json", '{"owner":"user"}\n');
    const before = fs.readFileSync(manifestPath);

    assert.deepEqual(
      synchronizeRepositorySpecialists(cwd),
      { status: "memory_absent" },
    );
    assert.deepEqual(fs.readFileSync(manifestPath), before);
    assert.deepEqual(
      fs.readdirSync(path.dirname(manifestPath)).sort(),
      ["manifest.json"],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
