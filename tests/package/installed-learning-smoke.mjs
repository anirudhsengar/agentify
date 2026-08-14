#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeOwnedArtifact, resolveExactArtifact } from "./exact-artifact.mjs";
import { writeQualificationReceipt } from "./qualification-receipts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const nodeCommand = process.execPath;
const npmCliPath = process.env.npm_execpath;
assert.equal(typeof npmCliPath, "string", "npm_execpath must identify the active npm CLI");
const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf-8",
    timeout: options.timeout ?? 600_000,
  });
  if (result.error) throw result.error;
  if (options.expectFailure === true) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
    return result;
  }
  assert.equal(
    result.status,
    options.expectedStatus ?? 0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runNpm(args, options = {}) {
  return run(nodeCommand, [npmCliPath, ...args], options);
}

function git(cwd, ...args) {
  return run("git", ["-C", cwd, ...args]).stdout.trim();
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-package-"));
const targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-target-"));
let resolvedArtifact = null;

try {
  resolvedArtifact = resolveExactArtifact({ repoRoot, packageJson, runNpm });
  const { tarballPath, artifact } = resolvedArtifact;
  const packedPaths = new Set((artifact.files ?? []).map((entry) => entry.path));
  assert.ok(packedPaths.has("dist/learning-runtime.mjs"));
  assert.ok(![...packedPaths].some((entry) => entry.endsWith(".map")), "source maps must remain excluded");
  assert.ok(packedPaths.has("scaffold/.github/workflows/agentify-learn.yml"));

  runNpm(["init", "--yes"], { cwd: installRoot });
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installRoot,
  });
  run(nodeCommand, [tsxCliPath, "tests/package/seed-installed-learning-fixture.ts", targetRepo]);
  git(targetRepo, "config", "core.autocrlf", "false");

  const installedRoot = path.join(installRoot, "node_modules", packageJson.name);
  const runtime = path.join(installedRoot, "dist", "learning-runtime.mjs");
  assert.ok(fs.existsSync(runtime), "installed package must contain the bundled learning runtime");
  const noArgs = run(nodeCommand, [runtime], {
    cwd: targetRepo,
    timeout: 120_000,
    expectFailure: true,
  });
  assert.match(noArgs.stderr, /^agentify-learning: usage:/);
  assert.doesNotMatch(noArgs.stderr, /\n\s*at |Error:/);

  const ioRoot = path.join(installRoot, "learning-evidence");
  fs.mkdirSync(ioRoot, { recursive: true });
  const baseCommit = git(targetRepo, "rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(targetRepo, "src", "billing", "index.ts"),
    "export const installedLearningValue = 2;\n",
  );
  git(targetRepo, "add", "src/billing/index.ts");
  git(targetRepo, "commit", "-qm", "accepted installed learning change");
  const acceptedCommit = git(targetRepo, "rev-parse", "HEAD");
  const acceptedAt = git(targetRepo, "show", "-s", "--format=%cI", acceptedCommit);

  const eventPath = path.join(ioRoot, "issue-1-event.json");
  const evidencePath = path.join(ioRoot, "issue-1-evidence.json");
  const reportPath = path.join(ioRoot, "issue-1-report.json");
  const secondPath = path.join(ioRoot, "issue-1-duplicate.json");
  const contextRequestPath = path.join(ioRoot, "context-request.json");
  const contextPath = path.join(ioRoot, "context-after-issue-1.json");
  const diffPath = path.join(ioRoot, "diff.json");
  fs.writeFileSync(eventPath, `${JSON.stringify({
    schema_version: "1",
    repository_id: "fixture/installed-learning",
    default_branch: "main",
    accepted_commit: acceptedCommit,
    first_parent_commit: baseCommit,
    expected_repository_head: acceptedCommit,
    pull_request_number: 22,
    issue_number: 21,
    pull_request_url: "https://github.example/fixture/installed-learning/pull/22",
    actor: "fixture-maintainer",
    author_kind: "agentify",
    accepted_at: new Date(acceptedAt).toISOString(),
  }, null, 2)}\n`);
  fs.writeFileSync(evidencePath, `${JSON.stringify({
    schema_version: "1",
    task_id: "qualification-issue-1",
    issue_number: 21,
    pull_request_number: 22,
    issue_url: "https://github.example/fixture/installed-learning/issues/21",
    plan_digest: "a".repeat(64),
    selected_specialist_ids: ["specialist-billing"],
    selected_procedure_ids: ["procedure-billing-tests"],
    risk_category: "medium",
    validation: { commands: ["node --test"], passed: true, evidence_refs: ["sha256:" + "b".repeat(64)] },
    review_feedback: [{ actor: "reviewer", source_ref: "review:22:hidden-test", accepted_at: new Date(acceptedAt).toISOString(), statement: "Normalize invoice identifiers before comparing retries." }],
    attempts: [
      { sequence: 1, approach: "Compare raw invoice identifiers", result: "failed", failure_category: "hidden_test", signal: "mixed-case retry test failed", correction: "Normalize invoice identifiers before comparing retries." },
      { sequence: 2, approach: "Normalize invoice identifiers before comparing retries", result: "succeeded", failure_category: null, signal: "focused and hidden tests passed", correction: null },
    ],
    generalization: "candidate",
    cost_usd: 0,
    runtime_ms: 25,
    source_artifact_url: "https://github.example/fixture/installed-learning/actions/runs/22",
  }, null, 2)}\n`);

  run(nodeCommand, [
    runtime,
    "process",
    "--event", eventPath,
    "--task-evidence", evidencePath,
    "--output", reportPath,
  ], { cwd: targetRepo, timeout: 300_000 });
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  assert.equal(report.status, "processed");
  assert.equal(report.accepted_commit, acceptedCommit);
  assert.ok(report.invalidation.stale_memory_ids.length >= 1);
  assert.ok(report.candidates.some((entry) => entry.kind === "orchestrator"));
  assert.ok(report.candidates.some((entry) => entry.kind === "episode"));

  run(nodeCommand, [
    runtime,
    "process",
    "--event", eventPath,
    "--task-evidence", evidencePath,
    "--output", secondPath,
  ], { cwd: targetRepo, timeout: 300_000 });
  assert.equal(JSON.parse(fs.readFileSync(secondPath, "utf-8")).status, "already-processed");

  fs.writeFileSync(contextRequestPath, JSON.stringify({ candidate_paths: ["src/billing/index.ts"], max_records: 64 }));
  run(nodeCommand, [runtime, "context", "--request", contextRequestPath, "--output", contextPath], { cwd: targetRepo, timeout: 120_000 });
  const retained = JSON.parse(fs.readFileSync(contextPath, "utf-8"));
  const retainedText = JSON.stringify(retained);
  assert.match(retainedText, /Normalize invoice identifiers before comparing retries/);
  assert.ok(retained.records.every((entry) => entry.freshness === "current"));

  const issueTwoBase = git(targetRepo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(targetRepo, "tests", "billing.test.ts"), "// Regression: normalize invoice identifiers before retry comparison.\n");
  git(targetRepo, "add", "tests/billing.test.ts");
  git(targetRepo, "commit", "-qm", "apply retained invoice retry lesson");
  const issueTwoCommit = git(targetRepo, "rev-parse", "HEAD");
  const issueTwoAt = new Date(git(targetRepo, "show", "-s", "--format=%cI", issueTwoCommit)).toISOString();
  const issueTwoEvent = path.join(ioRoot, "issue-2-event.json");
  const issueTwoEvidence = path.join(ioRoot, "issue-2-evidence.json");
  const issueTwoReport = path.join(ioRoot, "issue-2-report.json");
  fs.writeFileSync(issueTwoEvent, JSON.stringify({ schema_version: "1", repository_id: "fixture/installed-learning", default_branch: "main", accepted_commit: issueTwoCommit, first_parent_commit: issueTwoBase, expected_repository_head: issueTwoCommit, pull_request_number: 24, issue_number: 23, pull_request_url: "https://github.example/fixture/installed-learning/pull/24", actor: "fixture-maintainer", author_kind: "agentify", accepted_at: issueTwoAt }));
  fs.writeFileSync(issueTwoEvidence, JSON.stringify({ schema_version: "1", task_id: "qualification-issue-2", issue_number: 23, pull_request_number: 24, issue_url: "https://github.example/fixture/installed-learning/issues/23", plan_digest: "c".repeat(64), selected_specialist_ids: ["specialist-billing"], selected_procedure_ids: ["procedure-billing-tests"], risk_category: "low", validation: { commands: ["node --test"], passed: true, evidence_refs: ["sha256:" + "d".repeat(64)] }, review_feedback: [], attempts: [{ sequence: 1, approach: "Apply retained correction: normalize invoice identifiers before comparing retries", result: "succeeded", failure_category: null, signal: "regression test passed on the first attempt", correction: null }], generalization: "candidate", cost_usd: 0, runtime_ms: 10, source_artifact_url: "https://github.example/fixture/installed-learning/actions/runs/24" }));
  run(nodeCommand, [runtime, "process", "--event", issueTwoEvent, "--task-evidence", issueTwoEvidence, "--output", issueTwoReport], { cwd: targetRepo, timeout: 300_000 });
  assert.equal(JSON.parse(fs.readFileSync(issueTwoReport, "utf-8")).status, "processed");

  const invalidationBase = git(targetRepo, "rev-parse", "HEAD");
  git(targetRepo, "rm", "src/billing/index.ts");
  git(targetRepo, "commit", "-qm", "remove obsolete invoice retry implementation");
  const invalidationCommit = git(targetRepo, "rev-parse", "HEAD");
  const invalidationEvent = path.join(ioRoot, "invalidation-event.json");
  const invalidationReport = path.join(ioRoot, "invalidation-report.json");
  fs.writeFileSync(invalidationEvent, JSON.stringify({ schema_version: "1", repository_id: "fixture/installed-learning", default_branch: "main", accepted_commit: invalidationCommit, first_parent_commit: invalidationBase, expected_repository_head: invalidationCommit, pull_request_number: 25, issue_number: null, pull_request_url: "https://github.example/fixture/installed-learning/pull/25", actor: "human-maintainer", author_kind: "human", accepted_at: new Date(git(targetRepo, "show", "-s", "--format=%cI", invalidationCommit)).toISOString() }));
  run(nodeCommand, [runtime, "process", "--event", invalidationEvent, "--output", invalidationReport], { cwd: targetRepo, timeout: 300_000 });
  const invalidated = JSON.parse(fs.readFileSync(invalidationReport, "utf-8"));
  assert.equal(invalidated.status, "processed");
  assert.ok(invalidated.invalidation.stale_memory_ids.length > 0);
  const postInvalidationContext = path.join(ioRoot, "context-after-invalidation.json");
  run(nodeCommand, [runtime, "context", "--request", contextRequestPath, "--output", postInvalidationContext], { cwd: targetRepo, timeout: 120_000 });
  assert.doesNotMatch(JSON.stringify(JSON.parse(fs.readFileSync(postInvalidationContext, "utf-8"))), /Normalize invoice identifiers before comparing retries/);

  const humanBase = git(targetRepo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(targetRepo, "src", "index.ts"), "export const humanAuthoredValue = 3;\n");
  git(targetRepo, "add", "src/index.ts");
  git(targetRepo, "commit", "-qm", "human authored repository change");
  const humanCommit = git(targetRepo, "rev-parse", "HEAD");
  const humanEvent = path.join(ioRoot, "human-event.json");
  const humanReport = path.join(ioRoot, "human-report.json");
  fs.writeFileSync(humanEvent, JSON.stringify({ schema_version: "1", repository_id: "fixture/installed-learning", default_branch: "main", accepted_commit: humanCommit, first_parent_commit: humanBase, expected_repository_head: humanCommit, pull_request_number: 26, issue_number: null, pull_request_url: "https://github.example/fixture/installed-learning/pull/26", actor: "human-maintainer", author_kind: "human", accepted_at: new Date(git(targetRepo, "show", "-s", "--format=%cI", humanCommit)).toISOString() }));
  run(nodeCommand, [runtime, "process", "--event", humanEvent, "--output", humanReport], { cwd: targetRepo, timeout: 300_000 });
  const human = JSON.parse(fs.readFileSync(humanReport, "utf-8"));
  assert.equal(human.status, "processed");
  assert.ok(human.candidates.some((entry) => entry.kind === "orchestrator"));

  fs.writeFileSync(path.join(targetRepo, "src", "reconciled.ts"), "export const reconciledValue = 1;\n");
  git(targetRepo, "add", "src/reconciled.ts");
  git(targetRepo, "commit", "-qm", "missed accepted change for reconciliation");
  const reconciledCommit = git(targetRepo, "rev-parse", "HEAD");
  const reconcileReport = path.join(ioRoot, "reconcile-report.json");
  run(nodeCommand, [
    runtime,
    "reconcile",
    "--repository-id", "fixture/installed-learning",
    "--default-branch", "main",
    "--max-commits", "1",
    "--output", reconcileReport,
  ], { cwd: targetRepo, timeout: 300_000 });
  const reconciled = JSON.parse(fs.readFileSync(reconcileReport, "utf-8"));
  assert.deepEqual(reconciled.processed.map((entry) => entry.accepted_commit), [reconciledCommit]);

  run(nodeCommand, [
    runtime,
    "verify-diff",
    "--expected-head", reconciledCommit,
    "--output", diffPath,
  ], { cwd: targetRepo, timeout: 120_000 });
  const verified = JSON.parse(fs.readFileSync(diffPath, "utf-8"));
  assert.ok(verified.paths.length > 0);
  assert.ok(verified.paths.every((entry) => entry.startsWith(".agentify/")));
  for (const relativePath of verified.paths) git(targetRepo, "add", "--", relativePath);
  git(
    targetRepo,
    "commit",
    "-qm",
    "chore(agentify): refresh repository knowledge\n\n"
      + "Agentify-Proposal-Version: 1\n"
      + "Agentify-Proposal-Repository: fixture/installed-learning\n"
      + `Agentify-Proposal-Base: ${reconciledCommit}`,
  );
  const proposalCommit = git(targetRepo, "rev-parse", "HEAD");
  git(targetRepo, "switch", "--detach", "--quiet", reconciledCommit);
  const adoptionPath = path.join(ioRoot, "proposal-adoption.json");
  run(nodeCommand, [
    runtime,
    "adopt-proposal",
    "--repository-id", "fixture/installed-learning",
    "--proposal", proposalCommit,
    "--expected-head", reconciledCommit,
    "--output", adoptionPath,
  ], { cwd: targetRepo, timeout: 300_000 });
  const adoption = JSON.parse(fs.readFileSync(adoptionPath, "utf-8"));
  assert.equal(adoption.proposal_commit, proposalCommit);
  assert.deepEqual(adoption.paths, verified.paths);
  fs.rmSync(diffPath);

  writeQualificationReceipt("installed-learning-smoke.mjs", [
    "learning.accepted-merge-processed",
    "learning.duplicate-merge-idempotent",
    "learning.correction-retained-in-context",
    "learning.changed-path-invalidates-context",
    "learning.human-merge-refreshes-knowledge",
    "learning.scheduled-reconciliation-processes-missed-commit",
    "learning.pending-proposal-resumes-in-fresh-checkout",
    "learning.output-confined-to-agentify-paths",
  ]);
  console.log(`installed repeated-learning qualification passed: bounded correction retained for Issue 2, later invalidated, and a human-authored merge refreshed knowledge (${packageJson.name}@${packageJson.version}).`);
} finally {
  removeOwnedArtifact(resolvedArtifact);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(targetRepo, { recursive: true, force: true });
}
