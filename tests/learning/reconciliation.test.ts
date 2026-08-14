import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { processAcceptedMerge } from "../../src/core/learning/engine.ts";
import { reconcileAcceptedMerges } from "../../src/core/learning/reconciliation.ts";
import { verifyLearningSelfUpdateDiff } from "../../src/core/learning/self-update.ts";
import {
  initializeTeamMemoryStore,
  listMemoryRecords,
} from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
} from "../../src/core/specialists/index.ts";
import { installSelfUpdatePolicy } from "./installation-fixture.ts";

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
    for (let index = 0; index < 4; index += 1) {
      write(cwd, `src/history-${index}.ts`, `export const history${index} = true;\n`);
      git(cwd, "add", `src/history-${index}.ts`);
      git(cwd, "commit", "-qm", `historical change ${index}`);
    }
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
    installSelfUpdatePolicy({ cwd, supportingCommit: initial, observedAt });
    write(cwd, "src/installation-change.ts", "export const installedAlongsideAppChange = true;\n");
    git(cwd, "add", ".agentify", "src/installation-change.ts");
    git(cwd, "commit", "-qm", "install Agentify team memory");
    const installation = git(cwd, "rev-parse", "HEAD");

    write(cwd, "src/index.ts", "export const version = 2;\n");
    git(cwd, "add", "src/index.ts");
    git(cwd, "commit", "-qm", "second accepted change");
    const second = git(cwd, "rev-parse", "HEAD");

    const manifestPath = path.join(cwd, ".agentify", "manifest.json");
    const manifestBytes = fs.readFileSync(manifestPath);
    git(cwd, "rm", ".agentify/manifest.json");
    git(cwd, "commit", "-qm", "temporarily remove manifest");
    fs.writeFileSync(manifestPath, manifestBytes);
    git(cwd, "add", ".agentify/manifest.json");
    git(cwd, "commit", "-qm", "restore manifest");

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
      [installation, second, third],
    );
    assert.ok(firstRun.considered_commits.includes(installation));
    assert.ok(firstRun.considered_commits.includes(second));
    assert.ok(firstRun.considered_commits.includes(third));
    assert.ok(!firstRun.considered_commits.includes(initial));
    assert.equal(
      firstRun.processed[0]?.changes.some((change) =>
        change.path === "src/installation-change.ts"
      ),
      true,
    );
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

test("reconciliation ignores Agentify upgrades and filters mixed managed changes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-managed-"));
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
      repositoryId: "fixture/managed-reconciliation",
      supportingCommit: initial,
      evidence: [evidence],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });
    installSelfUpdatePolicy({ cwd, supportingCommit: initial, observedAt });
    write(cwd, ".github/agentify/task-runtime.mjs", "// installed runtime\n");
    git(cwd, "add", ".agentify", ".github/agentify/task-runtime.mjs");
    git(cwd, "commit", "-qm", "install Agentify");

    write(cwd, ".github/agentify/task-runtime.mjs", "// upgraded runtime\n");
    git(cwd, "add", ".github/agentify/task-runtime.mjs");
    git(cwd, "commit", "-qm", "upgrade Agentify runtime");
    const upgrade = git(cwd, "rev-parse", "HEAD");

    write(cwd, ".github/workflows/agentify-learn.yml", "# agentify:managed\nname: learn\n");
    write(cwd, "src/application.ts", "export const value = 1;\n");
    git(cwd, "add", ".github/workflows/agentify-learn.yml", "src/application.ts");
    git(cwd, "commit", "-qm", "mixed application and Agentify update");
    const mixed = git(cwd, "rev-parse", "HEAD");

    const report = reconcileAcceptedMerges({
      cwd,
      repository_id: "fixture/managed-reconciliation",
      default_branch: "main",
      max_commits: 8,
    });
    assert.deepEqual(report.processed.map((entry) => entry.accepted_commit), [mixed]);
    assert.ok(report.skipped_commits.includes(upgrade));
    assert.deepEqual(report.processed[0]?.changes, [{
      status: "added",
      path: "src/application.ts",
      previous_path: null,
    }]);
    const learned = listMemoryRecords(cwd, { tag: `learning-run-${mixed}` });
    assert.equal(learned.length, 1);
    assert.ok(learned[0]?.tags.includes("unknown-authored"));
    assert.ok(!learned[0]?.tags.includes("human-authored"));
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

test("bounded reconciliation drains the recent backlog oldest-first", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-backlog-"));
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
      repositoryId: "fixture/backlog",
      supportingCommit: initial,
      evidence: [evidence],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });
    installSelfUpdatePolicy({ cwd, supportingCommit: initial, observedAt });
    git(cwd, "add", ".agentify");
    git(cwd, "commit", "-qm", "install Agentify");
    const commits: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      write(cwd, `src/change-${index}.ts`, `export const change${index} = true;\n`);
      git(cwd, "add", `src/change-${index}.ts`);
      git(cwd, "commit", "-qm", `accepted change ${index}`);
      commits.push(git(cwd, "rev-parse", "HEAD"));
    }
    const processed: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const report = reconcileAcceptedMerges({
        cwd,
        repository_id: "fixture/backlog",
        default_branch: "main",
        max_commits: 2,
      });
      processed.push(...report.processed.map((entry) => entry.accepted_commit));
    }
    assert.deepEqual(processed, commits);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("one maximum-size accepted diff remains independently publishable", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-max-merge-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "config", "core.autocrlf", "false");
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
      repositoryId: "fixture/maximum-merge",
      supportingCommit: initial,
      evidence: [evidence],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });
    installSelfUpdatePolicy({ cwd, supportingCommit: initial, observedAt });
    git(cwd, "add", ".agentify");
    git(cwd, "commit", "-qm", "install Agentify");
    for (let index = 0; index < 256; index += 1) {
      write(cwd, `src/bulk/change-${index}.ts`, `export const value${index} = ${index};\n`);
    }
    git(cwd, "add", "src/bulk");
    git(cwd, "commit", "-qm", "maximum accepted application diff");
    const accepted = git(cwd, "rev-parse", "HEAD");
    const report = reconcileAcceptedMerges({
      cwd,
      repository_id: "fixture/maximum-merge",
      default_branch: "main",
      max_commits: 1,
    });
    assert.deepEqual(report.processed.map((entry) => entry.accepted_commit), [accepted]);
    const verified = verifyLearningSelfUpdateDiff(cwd, accepted);
    assert.ok(verified.metrics.path_count <= 64);
    assert.ok(verified.metrics.patch_bytes <= 512 * 1024);
    assert.ok(verified.metrics.changed_lines <= 5_000);
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
    installSelfUpdatePolicy({ cwd, supportingCommit: initial, observedAt });
    git(cwd, "add", ".agentify");
    git(cwd, "commit", "-qm", "chore(agentify): install knowledge");
    const installationCommit = git(cwd, "rev-parse", "HEAD");
    const direct = processAcceptedMerge({
      cwd,
      event: {
        schema_version: "1",
        repository_id: "fixture/knowledge-noop",
        default_branch: "main",
        accepted_commit: installationCommit,
        first_parent_commit: initial,
        expected_repository_head: installationCommit,
        pull_request_number: 1,
        issue_number: null,
        pull_request_url: "https://github.example/fixture/knowledge-noop/pull/1",
        actor: "knowledge-maintainer",
        author_kind: "agentify",
        accepted_at: readGitCommitTimestamp(cwd, installationCommit),
      },
    });
    assert.equal(direct.status, "knowledge-only");
    assert.deepEqual(direct.candidates, []);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    assert.equal(
      listMemoryRecords(cwd, { tag: `learning-run-${installationCommit}` }).length,
      0,
    );

    write(cwd, ".agentify/.gitignore", "runtime/\nstate-transactions/\n*.lock\n# refreshed\n");
    git(cwd, "add", ".agentify/.gitignore");
    git(cwd, "commit", "-qm", "chore(agentify): refresh knowledge");
    const knowledgeCommit = git(cwd, "rev-parse", "HEAD");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const report = reconcileAcceptedMerges({
        cwd,
        repository_id: "fixture/knowledge-noop",
        default_branch: "main",
        max_commits: 1,
      });
      assert.deepEqual(report.processed, []);
      assert.ok(report.skipped_commits.includes(installationCommit));
      assert.ok(report.skipped_commits.includes(knowledgeCommit));
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
