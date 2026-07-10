import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compareExpertOutcomePair,
  evaluateExpertOutcomeEvidence,
  loadExpertOutcomeEvidenceFile,
  scoreExpertOutcome,
  type ExpertOutcomeReplay,
} from "../../src/core/expert-outcome.ts";
import type { ExpertiseYaml } from "../../src/core/agent-expert.ts";

const billingExpertise: ExpertiseYaml = {
  domain: "billing",
  last_updated: "2026-07-06T00:00:00.000Z",
  primary_paths: ["src/billing", "tests/billing"],
  overview: {
    description: "Billing carries recurring payment invariants.",
    key_files: [
      {
        path: "src/billing/index.ts",
        line_range: [1, 160],
        purpose: "Coordinates invoice authorization, capture, and retry behavior.",
      },
    ],
  },
  key_types: [
    {
      name: "InvoiceState",
      path: "src/billing/types.ts:12",
      purpose: "State machine that prevents capture before authorization.",
    },
  ],
  patterns: [
    {
      name: "authorization-before-capture",
      description: "Invoices cannot be captured before authorization succeeds.",
      example_ref: "src/billing/index.ts:42",
    },
  ],
  pitfalls: [
    {
      risk: "Retry handlers can double-charge customers.",
      consequence: "A timed-out request and async retry can both capture the same invoice.",
      reference: "src/billing/retry.ts:88",
    },
  ],
  conventions: ["Amounts are stored in cents and never as floats."],
  testing: {
    command: "npm test -- tests/billing/retry.test.ts",
    test_paths: ["tests/billing/retry.test.ts", "tests/billing/capture.test.ts"],
  },
};

function replay(mode: ExpertOutcomeReplay["mode"], outputText: string): ExpertOutcomeReplay {
  return {
    mode,
    expertise: billingExpertise,
    outputText,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-expert-outcome-"));
}

function testScoresPlanningOutcomeAgainstExpertKnowledge(): void {
  const generic = replay(
    "plan",
    "Plan: update the billing service, add a test, then run npm test.",
  );
  const expertGuided = replay(
    "plan",
    [
      "Task interpretation: preserve InvoiceState while adding retry behavior.",
      "Relevant files: src/billing/index.ts:42 and src/billing/retry.ts:88.",
      "Invariant: authorization-before-capture means invoices cannot be captured before authorization succeeds.",
      "Risk: retry handlers can double-charge customers, especially after a timed-out request.",
      "Validation: npm test -- tests/billing/retry.test.ts and inspect tests/billing/capture.test.ts.",
      "Staleness check: re-read src/billing/index.ts and expertise.yaml if current code contradicts this model.",
    ].join("\n"),
  );

  const comparison = compareExpertOutcomePair({ baseline: generic, expertGuided });
  assert.equal(comparison.baseline.passed, false);
  assert.equal(comparison.expertGuided.passed, true);
  assert.ok(comparison.delta >= 3, `expected expert-guided plan delta >= 3, got ${comparison.delta}`);
  assert.deepEqual(comparison.expertGuided.missing, []);
}

function testScoresReviewOutcomeAgainstExpertKnowledge(): void {
  const review = scoreExpertOutcome(replay(
    "review",
    [
      "Verdict: request changes.",
      "Blocker: src/billing/retry.ts:88 can still double-charge customers when retry runs after a timeout.",
      "The fix must preserve authorization-before-capture from src/billing/index.ts:42 and InvoiceState.",
      "Validation required: npm test -- tests/billing/retry.test.ts.",
    ].join("\n"),
  ));

  assert.equal(review.passed, true);
  assert.ok(review.coveredChecks.includes("review-verdict"));
  assert.ok(review.coveredChecks.includes("pitfall-risk"));
  assert.ok(review.coveredChecks.includes("validation-command"));
}

function testScoresRefreshOutcomeAgainstExpertKnowledge(): void {
  const refresh = scoreExpertOutcome(replay(
    "refresh",
    [
      "Updated .pi/prompts/experts/billing/expertise.yaml last_updated to 2026-07-07T00:00:00.000Z.",
      "Preserved durable knowledge: authorization-before-capture at src/billing/index.ts:42.",
      "Kept pitfall: retry handlers can double-charge customers at src/billing/retry.ts:88.",
      "Validation: npm test -- tests/billing/retry.test.ts.",
      "Removed stale claim after re-reading src/billing/types.ts:12.",
    ].join("\n"),
  ));

  assert.equal(refresh.passed, true);
  assert.ok(refresh.coveredChecks.includes("refresh-artifact"));
  assert.ok(refresh.coveredChecks.includes("stale-knowledge"));
}

function testLoadsReplayEvidenceManifest(): void {
  const cwd = tempDir();
  try {
    fs.mkdirSync(path.join(cwd, ".pi", "prompts", "experts", "billing"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "dogfood"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "prompts", "experts", "billing", "expertise.yaml"),
      [
        "domain: billing",
        "last_updated: 2026-07-06T00:00:00.000Z",
        "primary_paths:",
        "  - src/billing",
        "overview:",
        "  description: Billing carries recurring payment invariants.",
        "  key_files:",
        "    - path: src/billing/index.ts",
        "      purpose: Coordinates invoice authorization, capture, and retry behavior.",
        "key_types:",
        "  - name: InvoiceState",
        "    path: src/billing/types.ts:12",
        "    purpose: State machine that prevents capture before authorization.",
        "patterns:",
        "  - name: authorization-before-capture",
        "    description: Invoices cannot be captured before authorization succeeds.",
        "    example_ref: src/billing/index.ts:42",
        "pitfalls:",
        "  - risk: Retry handlers can double-charge customers.",
        "    consequence: A timed-out request and async retry can both capture the same invoice.",
        "    reference: src/billing/retry.ts:88",
        "testing:",
        "  command: npm test -- tests/billing/retry.test.ts",
        "  test_paths:",
        "    - tests/billing/retry.test.ts",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(cwd, "dogfood", "baseline.md"),
      "Plan: modify billing and run npm test.",
    );
    fs.writeFileSync(
      path.join(cwd, "dogfood", "expert.md"),
      [
        "Preserve InvoiceState while changing retry behavior.",
        "Relevant files: src/billing/index.ts:42 and src/billing/retry.ts:88.",
        "Invariant: authorization-before-capture.",
        "Risk: retry handlers can double-charge customers.",
        "Validation: npm test -- tests/billing/retry.test.ts.",
        "Staleness check: re-read expertise.yaml and src/billing/index.ts first.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(cwd, "dogfood", "expert-outcomes.json"),
      JSON.stringify({
        version: 1,
        repo: "owner/repo",
        commit_sha: "0123456789abcdef0123456789abcdef01234567",
        captured_at: "2026-07-07T00:00:00Z",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        cases: [
          {
            id: "billing-plan-dogfood",
            mode: "plan",
            expertise_path: "../.pi/prompts/experts/billing/expertise.yaml",
            baseline_transcript_path: "baseline.md",
            expert_guided_transcript_path: "expert.md",
            min_delta: 3,
          },
        ],
      }, null, 2),
    );

    const report = loadExpertOutcomeEvidenceFile(path.join(cwd, "dogfood", "expert-outcomes.json"));
    assert.equal(report.passed, true);
    assert.equal(report.totalCases, 1);
    assert.equal(report.passedCases, 1);
    assert.equal(report.metadata?.repo, "owner/repo");
    assert.equal(report.metadata?.commitSha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(report.metadata?.capturedAt, "2026-07-07T00:00:00Z");
    assert.equal(report.metadata?.provider, "anthropic");
    assert.equal(report.metadata?.model, "claude-sonnet-4-20250514");
    assert.equal(report.cases[0]?.id, "billing-plan-dogfood");
    assert.equal(report.cases[0]?.comparison.expertGuided.passed, true);
    assert.ok(report.cases[0]?.comparison.delta >= 3);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRequiresReplayEvidenceMetadata(): void {
  const cwd = tempDir();
  try {
    fs.mkdirSync(path.join(cwd, "dogfood"), { recursive: true });
    const manifestPath = path.join(cwd, "dogfood", "expert-outcomes.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        cases: [
          {
            id: "billing-plan-dogfood",
            mode: "plan",
            expertise_path: "expertise.yaml",
            baseline_transcript_path: "baseline.md",
            expert_guided_transcript_path: "expert.md",
            min_delta: 3,
          },
        ],
      }, null, 2),
    );

    assert.throws(
      () => loadExpertOutcomeEvidenceFile(manifestPath),
      /repo must be owner\/name/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testReplayEvidenceManifestFailsWeakExpertOutput(): void {
  const report = loadExpertOutcomeEvidenceFileFromCasesForTest([
    {
      id: "weak-plan",
      mode: "plan",
      expertise: billingExpertise,
      baselineText: "Plan: update billing and run npm test.",
      expertGuidedText: "Plan: update billing and run npm test.",
      minDelta: 3,
    },
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.cases[0]?.passed, false);
  assert.match(report.cases[0]?.reasons.join("\n") ?? "", /delta 0 below required 3/);
}

function loadExpertOutcomeEvidenceFileFromCasesForTest(
  cases: Parameters<typeof evaluateExpertOutcomeEvidence>[0],
): ReturnType<typeof evaluateExpertOutcomeEvidence> {
  // Kept as a wrapper so this test reads like the file-backed gate: a collection
  // of replay cases should produce a release-quality pass/fail report.
  return evaluateExpertOutcomeEvidence(cases);
}

testScoresPlanningOutcomeAgainstExpertKnowledge();
testScoresReviewOutcomeAgainstExpertKnowledge();
testScoresRefreshOutcomeAgainstExpertKnowledge();
testLoadsReplayEvidenceManifest();
testRequiresReplayEvidenceMetadata();
testReplayEvidenceManifestFailsWeakExpertOutput();

console.log("expert outcome replay tests passed.");
