import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { processAcceptedMerge } from "../../src/core/learning/engine.ts";
import { reconcileAcceptedMerges } from "../../src/core/learning/reconciliation.ts";
import {
  initializeTeamMemoryStore,
  listMemoryRecords,
} from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
} from "../../src/core/specialists/index.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, relativePath: string, content: string): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

test("bounded reconciliation catches missed accepted commits idempotently", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-reconcile-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    write(cwd, "package.json", `${JSON.stringify({ private: true }, null, 2)}\n`);
    write(cwd, "src/index.ts", "export const version = 1;\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "initial repository");
    const initial = git(cwd, "rev-parse", "HEAD");
    const observedAt = readGitCommitTimestamp(cwd, initial);
    const bootstrap = buildSpecialistEvidenceReference({
      cwd,
      supportingCommit: initial,
      repositoryPath: "package.json",
      sourceType: "validated_bootstrap",
      observedAt,
      actor: "test-installer",
    });
    initializeTeamMemoryStore({
      cwd,
      repositoryId: "fixture/reconciliation",
      supportingCommit: initial,
      evidence: [bootstrap],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });

    write(cwd, "src/index.ts", "export const version = 2;\n");
    git(cwd, "add", "src/index.ts");
    git(cwd, "commit", "-qm", "second accepted change");
    const second = git(cwd, "rev-parse", "HEAD");

    write(cwd, "src/feature.ts", "export const feature = true;\n");
    git(cwd, "add", "src/feature.ts");
    git(cwd, "commit", "-qm", "third accepted change");
    const third = git(cwd, "rev-parse", "HEAD");

    const firstRun = reconcileAcceptedMerges({
      cwd,
      repository_id: "fixture/reconciliation",
      default_branch: "main",
      max_commits: 8,
    });
    assert.deepEqual(
      firstRun.processed.map((report) => report.accepted_commit),
      [second, third],
    );
    assert.ok(firstRun.skipped_commits.includes(initial));
    assert.equal(
      listMemoryRecords(cwd, { tag: `learning-run-${second}` }).length,
      1,
    );
    assert.equal(
      listMemoryRecords(cwd, { tag: `learning-run-${third}` }).length,
      1,
    );

    const secondRun = reconcileAcceptedMerges({
      cwd,
      repository_id: "fixture/reconciliation",
      default_branch: "main",
      max_commits: 8,
    });
    assert.deepEqual(secondRun.processed, []);
    assert.ok(secondRun.skipped_commits.includes(second));
    assert.ok(secondRun.skipped_commits.includes(third));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("reconciliation remains bounded", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-reconcile-bound-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    write(cwd, "package.json", "{}\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    assert.throws(
      () => reconcileAcceptedMerges({
        cwd,
        repository_id: "fixture/reconciliation",
        default_branch: "main",
        max_commits: 1000,
      }),
      /max_commits/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("knowledge-only reconciliation is a repeatable repository no-op", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-noop-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    write(cwd, "package.json", "{}\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const initial = git(cwd, "rev-parse", "HEAD");
    const observedAt = readGitCommitTimestamp(cwd, initial);
    const evidence = buildSpecialistEvidenceReference({
      cwd,
      supportingCommit: initial,
      repositoryPath: "package.json",
      sourceType: "validated_bootstrap",
      observedAt,
      actor: "test-installer",
    });
    initializeTeamMemoryStore({
      cwd,
      repositoryId: "fixture/knowledge-noop",
      supportingCommit: initial,
      evidence: [evidence],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });
    git(cwd, "add", ".agentify");
    git(cwd, "commit", "-qm", "chore(agentify): install knowledge");
    const knowledgeCommit = git(cwd, "rev-parse", "HEAD");
    const direct = processAcceptedMerge({
      cwd,
      event: {
        schema_version: "1",
        repository_id: "fixture/knowledge-noop",
        default_branch: "main",
        accepted_commit: knowledgeCommit,
        first_parent_commit: initial,
        expected_repository_head: knowledgeCommit,
        pull_request_number: 1,
        issue_number: null,
        pull_request_url: "https://github.example/fixture/knowledge-noop/pull/1",
        actor: "knowledge-maintainer",
        author_kind: "agentify",
        accepted_at: readGitCommitTimestamp(cwd, knowledgeCommit),
      },
    });
    assert.equal(direct.status, "knowledge-only");
    assert.deepEqual(direct.candidates, []);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    assert.equal(
      listMemoryRecords(cwd, { tag: `learning-run-${knowledgeCommit}` }).length,
      0,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const report = reconcileAcceptedMerges({
        cwd,
        repository_id: "fixture/knowledge-noop",
        default_branch: "main",
        max_commits: 1,
      });
      assert.deepEqual(report.processed, []);
      assert.deepEqual(report.skipped_commits, [knowledgeCommit]);
      assert.equal(git(cwd, "status", "--porcelain"), "");
      assert.equal(
        listMemoryRecords(cwd, { tag: `learning-run-${knowledgeCommit}` }).length,
        0,
      );
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
