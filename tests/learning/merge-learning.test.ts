import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildLearningContext } from "../../src/core/learning/context.ts";
import type {
  AcceptedMergeEvent,
  AcceptedTaskEvidence,
} from "../../src/core/learning/contracts.ts";
import { processAcceptedMerge } from "../../src/core/learning/engine.ts";
import { verifyLearningSelfUpdateDiff } from "../../src/core/learning/self-update.ts";
import {
  initializeTeamMemoryStore,
  listMemoryRecords,
} from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  discoverSpecialistPortfolio,
  materializeSpecialistPortfolio,
  readGitCommitTimestamp,
} from "../../src/core/specialists/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

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

function createFixture(): {
  cwd: string;
  baseCommit: string;
  acceptedCommit: string;
  event: AcceptedMergeEvent;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-merge-learning-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  write(cwd, "package.json", `${JSON.stringify({ scripts: { test: "node --test" } }, null, 2)}\n`);
  write(cwd, "src/index.ts", "export * from './billing/index.js';\n");
  write(cwd, "src/lib.ts", "export const shared = true;\n");
  write(cwd, "src/billing/index.ts", "export const invoiceTotal = 100;\n");
  write(cwd, "src/billing/types.ts", "export interface Invoice { total: number }\n");
  write(cwd, "tests/billing.test.ts", "// billing tests\n");
  write(cwd, "scripts/prime-db.sh", "#!/usr/bin/env bash\nexit 0\n");
  const map = makeSpecialistFixtureMap();
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial repository");
  const sourceCommit = git(cwd, "rev-parse", "HEAD");
  const observedAt = readGitCommitTimestamp(cwd, sourceCommit);
  const bootstrap = buildSpecialistEvidenceReference({
    cwd,
    supportingCommit: sourceCommit,
    repositoryPath: "package.json",
    sourceType: "validated_bootstrap",
    observedAt,
    actor: "test-installer",
  });
  initializeTeamMemoryStore({
    cwd,
    repositoryId: "fixture/learning",
    supportingCommit: sourceCommit,
    evidence: [bootstrap],
    actor: "agentify-installer",
    options: { now: () => new Date(observedAt) },
  });
  write(cwd, ".agentify/runtime/audit/codebase_map.json", `${JSON.stringify(map, null, 2)}\n`);
  materializeSpecialistPortfolio({
    cwd,
    portfolio: discoverSpecialistPortfolio(map, sourceCommit),
    actor: "knowledge-maintainer",
    observed_at: observedAt,
  });
  git(cwd, "add", ".agentify");
  git(cwd, "commit", "-qm", "install Agentify baseline");
  const baseCommit = git(cwd, "rev-parse", "HEAD");

  write(cwd, "src/billing/index.ts", "export const invoiceTotal = 125;\n");
  git(cwd, "add", "src/billing/index.ts");
  git(cwd, "commit", "-qm", "update billing calculation");
  const acceptedCommit = git(cwd, "rev-parse", "HEAD");
  const acceptedAt = readGitCommitTimestamp(cwd, acceptedCommit);
  return {
    cwd,
    baseCommit,
    acceptedCommit,
    event: {
      schema_version: "1",
      repository_id: "fixture/learning",
      default_branch: "main",
      accepted_commit: acceptedCommit,
      first_parent_commit: baseCommit,
      expected_repository_head: acceptedCommit,
      pull_request_number: 12,
      issue_number: 9,
      pull_request_url: "https://github.example/fixture/learning/pull/12",
      actor: "maintainer",
      author_kind: "human",
      accepted_at: acceptedAt,
    },
  };
}

function acceptedTaskEvidence(): AcceptedTaskEvidence {
  return {
    schema_version: "1",
    task_id: "issue-9",
    issue_number: 9,
    pull_request_number: 12,
    issue_url: "https://github.example/fixture/learning/issues/9",
    plan_digest: "a".repeat(64),
    selected_specialist_ids: ["specialist-billing"],
    selected_procedure_ids: ["validate-repository"],
    risk_category: "medium",
    validation: {
      commands: ["npm test -- tests/billing.test.ts"],
      passed: true,
      evidence_refs: ["artifact:validation-12"],
    },
    review_feedback: [{
      actor: "reviewer",
      source_ref: "https://github.example/fixture/learning/pull/12#review-1",
      accepted_at: "2026-07-31T00:10:00.000Z",
      statement: "Preserve invoice totals as integer minor units.",
    }],
    attempts: [
      {
        sequence: 1,
        approach: "Changed the display value only.",
        result: "failed",
        failure_category: "incorrect_layer",
        signal: "Billing integration test still observed the old total.",
        correction: "Changed the domain calculation and retained the test invariant.",
      },
      {
        sequence: 2,
        approach: "Changed the domain calculation.",
        result: "succeeded",
        failure_category: null,
        signal: "Focused billing validation passed.",
        correction: null,
      },
    ],
    generalization: "candidate",
    cost_usd: 0.42,
    runtime_ms: 2_500,
    source_artifact_url: "https://github.example/artifacts/task-12",
  };
}

test("accepted human merges invalidate expertise, retain mistakes, and are idempotent", () => {
  const fixture = createFixture();
  try {
    const report = processAcceptedMerge({
      cwd: fixture.cwd,
      event: fixture.event,
      task_evidence: acceptedTaskEvidence(),
    });
    assert.equal(report.status, "processed");
    assert.equal(report.accepted_commit, fixture.acceptedCommit);
    assert.ok(report.invalidation.stale_memory_ids.length >= 1);
    assert.ok(report.invalidation.expertise.specialist_ids.includes("specialist-billing"));
    assert.equal(report.metrics.cost_usd, 0.42);
    assert.equal(
      fs.existsSync(path.join(
        fixture.cwd,
        ".agentify/state-transactions",
        `merge-learning-${fixture.acceptedCommit}.json`,
      )),
      false,
    );

    const episodes = listMemoryRecords(fixture.cwd, { kind: "episode", freshness: "current" });
    assert.equal(episodes.length, 1);
    const episode = episodes[0]!;
    assert.equal(episode.kind, "episode");
    if (episode.kind !== "episode") throw new Error("expected episode memory");
    assert.equal(episode.payload.attempts[0]!.result, "failed");
    assert.equal(episode.payload.attempts[0]!.failure_category, "incorrect_layer");
    assert.match(episode.payload.attempts[0]!.correction ?? "", /domain calculation/);

    const context = buildLearningContext(fixture.cwd, {
      candidate_paths: ["src/billing/index.ts"],
      specialist_ids: ["specialist-billing"],
      include_inactive: true,
    });
    assert.ok(context.records.some((record) => record.kind === "episode"));
    assert.ok(context.evidence.some((entry) => entry.source_type === "accepted_review_feedback"));

    const second = processAcceptedMerge({
      cwd: fixture.cwd,
      event: fixture.event,
      task_evidence: acceptedTaskEvidence(),
    });
    assert.equal(second.status, "already-processed");
    assert.equal(
      listMemoryRecords(fixture.cwd, { tag: `learning-run-${fixture.acceptedCommit}` }).length,
      1,
    );
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("a later path change stales a retained episode before task context is built", () => {
  const fixture = createFixture();
  try {
    processAcceptedMerge({
      cwd: fixture.cwd,
      event: fixture.event,
      task_evidence: acceptedTaskEvidence(),
    });
    assert.equal(listMemoryRecords(fixture.cwd, { kind: "episode", freshness: "current" }).length, 1);

    write(fixture.cwd, "src/billing/index.ts", "export const replacementBilling = true;\n");
    git(fixture.cwd, "add", "src/billing/index.ts");
    git(fixture.cwd, "commit", "-qm", "replace the learned billing behavior");
    const replacement = git(fixture.cwd, "rev-parse", "HEAD");
    const report = processAcceptedMerge({
      cwd: fixture.cwd,
      event: {
        ...fixture.event,
        accepted_commit: replacement,
        first_parent_commit: fixture.acceptedCommit,
        expected_repository_head: replacement,
        pull_request_number: 13,
        issue_number: null,
        author_kind: "human",
        accepted_at: readGitCommitTimestamp(fixture.cwd, replacement),
      },
      task_evidence: null,
    });
    assert.ok(report.invalidation.stale_memory_ids.some((id) => id.startsWith("episode-")));
    assert.equal(listMemoryRecords(fixture.cwd, { kind: "episode", freshness: "current" }).length, 0);
    assert.equal(buildLearningContext(fixture.cwd, {
      candidate_paths: ["src/billing/index.ts"],
    }).records.some((record) => record.kind === "episode"), false);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("a partial learning run resumes after every phase without duplicate memory", () => {
  const phases = [
    "bound",
    "assessed",
    "invalidated",
    "candidates-accepted",
    "specialists-refreshed",
    "recorded",
  ] as const;
  for (const crashPhase of phases) {
    const fixture = createFixture();
    try {
      assert.throws(
        () => processAcceptedMerge({
          cwd: fixture.cwd,
          event: fixture.event,
          task_evidence: acceptedTaskEvidence(),
          options: {
            afterPhase: (phase) => {
              if (phase === crashPhase) throw new Error(`simulated crash after ${phase}`);
            },
          },
        }),
        /simulated crash/,
      );
      assert.equal(
        fs.existsSync(path.join(
          fixture.cwd,
          ".agentify/state-transactions",
          `merge-learning-${fixture.acceptedCommit}.json`,
        )),
        true,
      );
      const recovered = processAcceptedMerge({
        cwd: fixture.cwd,
        event: fixture.event,
        task_evidence: acceptedTaskEvidence(),
      });
      assert.ok(recovered.status === "processed" || recovered.status === "already-processed");
      assert.equal(
        listMemoryRecords(fixture.cwd, { tag: `learning-run-${fixture.acceptedCommit}` }).length,
        1,
      );
      assert.equal(
        fs.existsSync(path.join(
          fixture.cwd,
          ".agentify/state-transactions",
          `merge-learning-${fixture.acceptedCommit}.json`,
        )),
        false,
      );
    } finally {
      fs.rmSync(fixture.cwd, { recursive: true, force: true });
    }
  }
});

test("learning rejects repository mismatch, stale heads, policy proposals, and unsafe diffs", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => processAcceptedMerge({
        cwd: fixture.cwd,
        event: { ...fixture.event, repository_id: "other/repository" },
      }),
      /memory belongs to fixture\/learning/,
    );
    assert.throws(
      () => processAcceptedMerge({
        cwd: fixture.cwd,
        event: { ...fixture.event, expected_repository_head: fixture.baseCommit },
      }),
      /expected repository head/,
    );

    const policyProposal = {
      schema_version: "1" as const,
      candidate_id: "candidate-policy-learning",
      memory_id: "learned-policy",
      kind: "policy" as const,
      proposed_by_agent_id: "knowledge-maintainer",
      owning_agent_id: "knowledge-maintainer",
      statement: "Expand automatic authority.",
      source_type: "merged_code" as const,
      supporting_commit: fixture.acceptedCommit,
      evidence: [{
        evidence_id: "evidence-policy-learning",
        source_type: "merged_code" as const,
        repository_path: null,
        commit_sha: fixture.acceptedCommit,
        sha256: null,
        line_start: null,
        line_end: null,
        external_ref: "test:policy",
        description: "Untrusted learned policy proposal.",
        observed_at: fixture.event.accepted_at,
        actor: "model",
      }],
      confidence: "high" as const,
      dependent_paths: [],
      invalidation_conditions: [],
      contradicts: [],
      human_attribution: null,
      tags: ["policy"],
      proposed_at: fixture.event.accepted_at,
      payload: {
        policy_key: "expand-authority",
        rule: "Expand automatic authority.",
        protected_paths: [],
        allowed_tools: [],
        forbidden_actions: [],
        approval_required: false,
        numeric_limit: null,
        unit: null,
      },
    };
    assert.throws(
      () => processAcceptedMerge({
        cwd: fixture.cwd,
        event: fixture.event,
        candidate_drafts: [policyProposal],
      }),
      /cannot propose policy memory/,
    );

    write(fixture.cwd, "src/unrelated.ts", "export const unsafe = true;\n");
    assert.throws(
      () => verifyLearningSelfUpdateDiff(fixture.cwd, fixture.acceptedCommit),
      /cannot modify src\/unrelated\.ts/,
    );
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});
