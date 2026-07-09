import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { qualifyReleaseEvidence } from "../../src/core/release-qualification.ts";
import type { ExpertOutcomeMode } from "../../src/core/expert-outcome.ts";
import type { SmokeEvidence } from "../../src/core/smoke-evidence.ts";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const EVIDENCE_SINCE = "2026-07-06T00:00:00Z";
const EXPERT_CAPTURED_AT = "2026-07-07T00:00:00Z";

interface ExpertOutcomeManifestOptions {
  modes?: ExpertOutcomeMode[];
  repo?: string;
  commitSha?: string;
  capturedAt?: string;
  provider?: string;
  model?: string;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-release-qualification-"));
}

function smoke(gate: SmokeEvidence["gate"]): SmokeEvidence {
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
  };
}

function writeJson(dir: string, fileName: string, value: unknown): string {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function writeSmokeEvidence(dir: string): string[] {
  return [
    writeJson(dir, "smoke-implement.json", smoke("implement_preflight")),
    writeJson(dir, "smoke-drill.json", smoke("drill_preflight")),
    writeJson(dir, "smoke-retry.json", smoke("retry_command")),
    writeJson(dir, "smoke-model.json", smoke("model_implementation")),
    writeJson(dir, "smoke-review.json", smoke("model_review")),
    writeJson(dir, "smoke-refresh.json", smoke("model_refresh")),
  ];
}

function writeExpertOutcomeManifest(
  cwd: string,
  options: ExpertOutcomeManifestOptions = {},
): string {
  const modes = options.modes ?? ["plan", "review", "refresh"];
  const expertDir = path.join(cwd, ".pi", "prompts", "experts", "billing");
  const dogfoodDir = path.join(cwd, "dogfood");
  fs.mkdirSync(expertDir, { recursive: true });
  fs.mkdirSync(dogfoodDir, { recursive: true });
  fs.writeFileSync(
    path.join(expertDir, "expertise.yaml"),
    [
      "domain: billing",
      "overview:",
      "  key_files:",
      "    - path: src/billing/index.ts",
      "key_types:",
      "  - name: InvoiceState",
      "    path: src/billing/types.ts:12",
      "patterns:",
      "  - name: authorization-before-capture",
      "    description: Invoices cannot be captured before authorization succeeds.",
      "    example_ref: src/billing/index.ts:42",
      "pitfalls:",
      "  - risk: Retry handlers can double-charge customers.",
      "    reference: src/billing/retry.ts:88",
      "testing:",
      "  command: npm test -- tests/billing/retry.test.ts",
      "  test_paths:",
      "    - tests/billing/retry.test.ts",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dogfoodDir, "baseline-plan.md"), "Plan: update billing and run npm test.");
  fs.writeFileSync(path.join(dogfoodDir, "baseline-review.md"), "Review: looks okay.");
  fs.writeFileSync(path.join(dogfoodDir, "baseline-refresh.md"), "Refresh the expert file.");
  fs.writeFileSync(
    path.join(dogfoodDir, "expert-plan.md"),
    [
      "Preserve InvoiceState.",
      "Relevant files: src/billing/index.ts:42 and src/billing/retry.ts:88.",
      "Invariant: authorization-before-capture.",
      "Risk: retry handlers can double-charge customers.",
      "Validation: npm test -- tests/billing/retry.test.ts.",
      "Staleness check: re-read expertise.yaml before implementation.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dogfoodDir, "expert-review.md"),
    [
      "Verdict: request changes.",
      "Blocker: src/billing/retry.ts:88 can still double-charge customers.",
      "Preserve InvoiceState and authorization-before-capture from src/billing/index.ts:42.",
      "Validation: npm test -- tests/billing/retry.test.ts.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dogfoodDir, "expert-refresh.md"),
    [
      "Updated .pi/prompts/experts/billing/expertise.yaml last_updated to 2026-07-07T00:00:00.000Z.",
      "Preserved durable knowledge: authorization-before-capture at src/billing/index.ts:42.",
      "Kept pitfall: retry handlers can double-charge customers at src/billing/retry.ts:88.",
      "Validation: npm test -- tests/billing/retry.test.ts.",
      "Removed stale claim after re-reading src/billing/types.ts:12.",
    ].join("\n"),
  );
  return writeJson(dogfoodDir, "expert-outcomes.json", {
    version: 1,
    repo: options.repo ?? "owner/repo",
    commit_sha: options.commitSha ?? COMMIT_SHA,
    captured_at: options.capturedAt ?? EXPERT_CAPTURED_AT,
    provider: options.provider ?? "anthropic",
    model: options.model ?? "claude-sonnet-4-20250514",
    cases: modes.map((mode) => ({
      id: `billing-${mode}`,
      mode,
      expertise_path: "../.pi/prompts/experts/billing/expertise.yaml",
      baseline_transcript_path: `baseline-${mode}.md`,
      expert_guided_transcript_path: `expert-${mode}.md`,
      min_delta: 3,
    })),
  });
}

function testQualifiesCompleteReleaseEvidence(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, true);
    assert.deepEqual(report.failures, []);
    assert.equal(report.smoke.passed, true);
    assert.equal(report.expertOutcome?.passed, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRequiresExpertOutcomeEvidence(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(report.failures.join("\n"), /missing expert outcome manifest/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRequiresEvidenceWindow(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(report.failures.join("\n"), /missing evidence window/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsStaleSmokeEvidence(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: "2026-07-08T00:00:00Z",
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(
      report.failures.join("\n"),
      /implement_preflight completed_at 2026-07-07T00:00:00Z is before evidence window 2026-07-08T00:00:00Z/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRequiresExpectedCommit(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(report.failures.join("\n"), /missing expected candidate commit/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsUnexpectedCommit(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: "fedcba9876543210fedcba9876543210fedcba98",
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(
      report.failures.join("\n"),
      /smoke evidence commit 0123456789abcdef0123456789abcdef01234567 does not match expected candidate commit fedcba9876543210fedcba9876543210fedcba98/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRequiresExpectedRepository(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(report.failures.join("\n"), /missing expected staged repository/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsUnexpectedRepository(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "other/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(
      report.failures.join("\n"),
      /smoke evidence repository owner\/repo does not match expected staged repository other\/repo/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRequiresExpertOutcomeModes(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd, { modes: ["plan", "review"] }),
    });

    assert.equal(report.passed, false);
    assert.match(report.failures.join("\n"), /missing expert outcome refresh case/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsUnexpectedExpertOutcomeRepository(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd, { repo: "other/repo" }),
    });

    assert.equal(report.passed, false);
    assert.match(
      report.failures.join("\n"),
      /expert outcome repository other\/repo does not match expected staged repository owner\/repo/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsUnexpectedExpertOutcomeCommit(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd, {
        commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      }),
    });

    assert.equal(report.passed, false);
    assert.match(
      report.failures.join("\n"),
      /expert outcome commit fedcba9876543210fedcba9876543210fedcba98 does not match expected candidate commit 0123456789abcdef0123456789abcdef01234567/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRejectsStaleExpertOutcomeEvidence(): void {
  const cwd = tempDir();
  try {
    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: writeSmokeEvidence(cwd),
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd, {
        capturedAt: "2026-07-05T00:00:00Z",
      }),
    });

    assert.equal(report.passed, false);
    assert.match(
      report.failures.join("\n"),
      /expert outcome captured_at 2026-07-05T00:00:00Z is before evidence window 2026-07-06T00:00:00Z/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testPropagatesSmokeFailures(): void {
  const cwd = tempDir();
  try {
    const smokeFiles = writeSmokeEvidence(cwd);
    fs.writeFileSync(
      smokeFiles[3]!,
      JSON.stringify({ ...smoke("model_implementation"), pr_url: "" }, null, 2),
    );

    const report = qualifyReleaseEvidence({
      expectedRepo: "owner/repo",
      expectedCommit: COMMIT_SHA,
      evidenceSince: EVIDENCE_SINCE,
      smokeEvidenceFiles: smokeFiles,
      expertOutcomeManifestPath: writeExpertOutcomeManifest(cwd),
    });

    assert.equal(report.passed, false);
    assert.match(report.failures.join("\n"), /model_implementation must include pr_url/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

testQualifiesCompleteReleaseEvidence();
testRequiresExpertOutcomeEvidence();
testRequiresEvidenceWindow();
testRejectsStaleSmokeEvidence();
testRequiresExpectedCommit();
testRejectsUnexpectedCommit();
testRequiresExpectedRepository();
testRejectsUnexpectedRepository();
testRequiresExpertOutcomeModes();
testRejectsUnexpectedExpertOutcomeRepository();
testRejectsUnexpectedExpertOutcomeCommit();
testRejectsStaleExpertOutcomeEvidence();
testPropagatesSmokeFailures();

console.log("release qualification tests passed.");
