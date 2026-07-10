import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadSmokeEvidenceFiles,
  verifySmokeEvidence,
  type SmokeEvidence,
} from "../../src/core/smoke-evidence.ts";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-smoke-evidence-"));
}

function evidence(gate: SmokeEvidence["gate"], overrides: Partial<SmokeEvidence> = {}): SmokeEvidence {
  return {
    schema: "agentify.smoke-evidence.v1",
    gate,
    repo: "owner/repo",
    result: "passed",
    commit_sha: COMMIT_SHA,
    completed_at: "2026-07-07T00:00:00Z",
    issue_url: gate === "implement_preflight" || gate === "drill_preflight" || gate === "retry_command" || gate === "model_implementation"
      ? "https://github.com/owner/repo/issues/777"
      : "",
    pr_url: gate === "model_implementation" || gate === "model_review"
      ? "https://github.com/owner/repo/pull/888"
      : "",
    workflow_url: gate === "implement_preflight" || gate === "drill_preflight" || gate === "retry_command" || gate === "model_implementation" || gate === "model_review" || gate === "model_refresh"
      ? "https://github.com/owner/repo/actions/runs/999"
      : "",
    details: "passed",
    ...overrides,
  };
}

function writeEvidence(dir: string, fileName: string, value: SmokeEvidence): string {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function testVerifiesCompleteSmokeEvidenceSet(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("drill_preflight"),
    evidence("retry_command"),
    evidence("model_implementation"),
    evidence("model_review"),
    evidence("model_refresh"),
  ]);

  assert.equal(report.passed, true);
  assert.equal(report.totalEvidence, 6);
  assert.deepEqual(report.missingGates, []);
  assert.deepEqual(report.repos, ["owner/repo"]);
  assert.deepEqual(report.commitShas, [COMMIT_SHA]);
}

function testRejectsMissingRequiredGate(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("drill_preflight"),
    evidence("retry_command"),
    evidence("model_implementation"),
    evidence("model_review"),
  ]);

  assert.equal(report.passed, false);
  assert.deepEqual(report.missingGates, ["model_refresh"]);
}

function testVerifiesNoLlmSmokeEvidenceSet(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("drill_preflight"),
    evidence("retry_command"),
  ], { profile: "no_llm" });

  assert.equal(report.passed, true);
  assert.equal(report.totalEvidence, 3);
  assert.deepEqual(report.missingGates, []);
  assert.deepEqual(report.repos, ["owner/repo"]);
  assert.deepEqual(report.commitShas, [COMMIT_SHA]);
}

function testNoLlmProfileStillRequiresAllNoLlmGates(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("retry_command"),
  ], { profile: "no_llm" });

  assert.equal(report.passed, false);
  assert.deepEqual(report.missingGates, ["drill_preflight"]);
}

function testRejectsFailedOrWeakEvidence(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("drill_preflight", { issue_url: "", workflow_url: "" }),
    evidence("retry_command"),
    evidence("model_implementation", { result: "failed", commit_sha: "not-a-sha", workflow_url: "" }),
    evidence("model_review", { pr_url: "", workflow_url: "" }),
    evidence("model_refresh", { workflow_url: "" }),
  ]);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /drill_preflight must include issue_url/);
  assert.match(report.failures.join("\n"), /drill_preflight must include workflow_url/);
  assert.match(report.failures.join("\n"), /model_implementation result must be passed/);
  assert.match(report.failures.join("\n"), /model_implementation commit_sha must be a 40-character git SHA/);
  assert.match(report.failures.join("\n"), /model_implementation must include workflow_url/);
  assert.match(report.failures.join("\n"), /model_review must include pr_url/);
  assert.match(report.failures.join("\n"), /model_review must include workflow_url/);
  assert.match(report.failures.join("\n"), /model_refresh must include workflow_url/);
}

function testRejectsDuplicateGateEvidence(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("implement_preflight", { issue_url: "https://github.com/owner/repo/issues/778" }),
    evidence("drill_preflight"),
    evidence("retry_command"),
    evidence("model_implementation"),
    evidence("model_review"),
    evidence("model_refresh"),
  ]);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /duplicate smoke evidence for gate: implement_preflight/);
}

function testRejectsCrossCommitEvidence(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight"),
    evidence("drill_preflight", { commit_sha: "fedcba9876543210fedcba9876543210fedcba98" }),
    evidence("retry_command"),
    evidence("model_implementation"),
    evidence("model_review"),
    evidence("model_refresh"),
  ]);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /evidence spans multiple commits/);
}

function testRejectsCrossRepoUrls(): void {
  const report = verifySmokeEvidence([
    evidence("implement_preflight", { issue_url: "https://github.com/other/repo/issues/777" }),
    evidence("drill_preflight", {
      issue_url: "https://github.com/other/repo/issues/778",
      workflow_url: "https://github.com/other/repo/actions/runs/999",
    }),
    evidence("retry_command"),
    evidence("model_implementation", {
      pr_url: "https://github.com/other/repo/pull/888",
      workflow_url: "https://github.com/other/repo/actions/runs/999",
    }),
    evidence("model_review", { workflow_url: "https://github.com/other/repo/actions/runs/999" }),
    evidence("model_refresh", { workflow_url: "https://github.com/other/repo/actions/runs/999" }),
  ]);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /implement_preflight issue_url must point at owner\/repo/);
  assert.match(report.failures.join("\n"), /drill_preflight issue_url must point at owner\/repo/);
  assert.match(report.failures.join("\n"), /drill_preflight workflow_url must point at owner\/repo/);
  assert.match(report.failures.join("\n"), /model_implementation pr_url must point at owner\/repo/);
  assert.match(report.failures.join("\n"), /model_implementation workflow_url must point at owner\/repo/);
  assert.match(report.failures.join("\n"), /model_review workflow_url must point at owner\/repo/);
  assert.match(report.failures.join("\n"), /model_refresh workflow_url must point at owner\/repo/);
}

function testLoadsSmokeEvidenceFiles(): void {
  const cwd = tempDir();
  try {
    const files = [
      writeEvidence(cwd, "implement.json", evidence("implement_preflight")),
      writeEvidence(cwd, "drill.json", evidence("drill_preflight")),
      writeEvidence(cwd, "retry.json", evidence("retry_command")),
      writeEvidence(cwd, "model.json", evidence("model_implementation")),
      writeEvidence(cwd, "review.json", evidence("model_review")),
      writeEvidence(cwd, "refresh.json", evidence("model_refresh")),
    ];

    const report = loadSmokeEvidenceFiles(files);
    assert.equal(report.passed, true);
    assert.equal(report.totalEvidence, 6);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

testVerifiesCompleteSmokeEvidenceSet();
testRejectsMissingRequiredGate();
testVerifiesNoLlmSmokeEvidenceSet();
testNoLlmProfileStillRequiresAllNoLlmGates();
testRejectsFailedOrWeakEvidence();
testRejectsDuplicateGateEvidence();
testRejectsCrossCommitEvidence();
testRejectsCrossRepoUrls();
testLoadsSmokeEvidenceFiles();

console.log("smoke evidence tests passed.");
