import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acceptMemoryCandidate,
  compactMemoryRecords,
  createAgentIdentity,
  initializeTeamMemoryStore,
  listMemoryRecords,
  markMemoryStale,
  mergeMemoryEvidence,
  persistMemoryCandidate,
  readAgentMemoryView,
  readMemoryRecord,
  recoverTeamMemoryStore,
  revalidateMemory,
  TeamMemoryError,
  type MemoryCandidateDraft,
} from "../../src/core/memory/index.ts";
import {
  COMMIT_A,
  COMMIT_B,
  codebaseCandidate,
  evidence,
  initialize,
  tempRepo,
  testMemoryOptions,
} from "./helpers.ts";

function hasCode(error: unknown, code: TeamMemoryError["code"]): boolean {
  return error instanceof TeamMemoryError && error.code === code;
}


test("first initialization recovers only a recognized stale Agentify lock", () => {
  const cwd = tempRepo("agentify-memory-initial-lock-");
  try {
    const lockPath = path.join(cwd, ".agentify/runtime/locks/store.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      token: "00000000-0000-4000-8000-000000000001",
      pid: 2_147_483_647,
      hostname: os.hostname(),
      acquired_at: "2020-01-01T00:00:00.000Z",
    })}\n`);
    const old = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, old, old);

    const manifest = initializeTeamMemoryStore({
      cwd,
      repositoryId: "owner/repo",
      supportingCommit: COMMIT_A,
      evidence: [evidence("bootstrap-after-stale-lock")],
      options: testMemoryOptions({
        now: () => new Date("2026-07-30T00:10:00.000Z"),
        staleLockMs: 1,
      }),
    });
    assert.equal(manifest.repository_id, "owner/repo");
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(recoverTeamMemoryStore(cwd, testMemoryOptions()).status, "valid");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  const active = tempRepo("agentify-memory-active-initial-lock-");
  try {
    const lockPath = path.join(active, ".agentify/runtime/locks/store.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      token: "00000000-0000-4000-8000-000000000002",
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: "2026-07-30T00:10:00.000Z",
    })}\n`);
    assert.throws(
      () => initializeTeamMemoryStore({
        cwd: active,
        repositoryId: "owner/repo",
        supportingCommit: COMMIT_A,
        evidence: [evidence("bootstrap-during-active-lock")],
        options: testMemoryOptions({
          now: () => new Date("2026-07-30T00:10:01.000Z"),
          staleLockMs: 1,
        }),
      }),
      (error) => hasCode(error, "lock_conflict"),
    );
    assert.equal(fs.existsSync(path.join(active, ".agentify/manifest.json")), false);
  } finally {
    fs.rmSync(active, { recursive: true, force: true });
  }
});

test("memory evidence merges use optimistic revisions", () => {
  const cwd = tempRepo("agentify-memory-evidence-merge-");
  try {
    initialize(cwd);
    persistMemoryCandidate(
      cwd,
      codebaseCandidate("merge-candidate", "merge-memory"),
      testMemoryOptions(),
    );
    acceptMemoryCandidate(
      cwd,
      "merge-candidate",
      "knowledge-maintainer",
      "accept initial fact",
      testMemoryOptions({ now: () => new Date("2026-07-30T00:30:00.000Z") }),
    );

    const merged = mergeMemoryEvidence(cwd, "merge-memory", {
      actor: "knowledge-maintainer",
      expectedRevision: 1,
      evidence: [evidence("merge-follow-up", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "add independently verified evidence",
      options: testMemoryOptions({ now: () => new Date("2026-07-30T01:00:00.000Z") }),
    });
    assert.equal(merged.revision, 2);
    assert.equal(merged.supporting_commit, COMMIT_B);
    assert.deepEqual(
      merged.evidence.map((entry) => entry.evidence_id),
      ["merge-candidate", "merge-follow-up"],
    );

    assert.throws(
      () => mergeMemoryEvidence(cwd, "merge-memory", {
        actor: "knowledge-maintainer",
        expectedRevision: 1,
        evidence: [evidence("stale-follow-up", COMMIT_B)],
        supportingCommit: COMMIT_B,
        reason: "stale evidence writer",
        options: testMemoryOptions(),
      }),
      (error) => hasCode(error, "revision_conflict"),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory queries cover domain, task, evidence, and tags", () => {
  const cwd = tempRepo("agentify-memory-query-");
  try {
    initialize(cwd);
    createAgentIdentity({
      cwd,
      agentId: "payments",
      role: "specialist",
      displayName: "Payments Specialist",
      domain: "payments",
      memoryKinds: ["codebase", "procedure", "episode", "specialist"],
      supportingCommit: COMMIT_A,
      evidence: [evidence("payments-identity")],
      actor: "knowledge-maintainer",
      options: testMemoryOptions(),
    });

    const specialistDraft: MemoryCandidateDraft = {
      schema_version: "1",
      candidate_id: "payments-specialist-candidate",
      memory_id: "payments-specialist-memory",
      kind: "specialist",
      proposed_by_agent_id: "orchestrator",
      owning_agent_id: "payments",
      statement: "Payments changes require the payments specialist.",
      source_type: "validated_bootstrap",
      supporting_commit: COMMIT_A,
      evidence: [evidence("payments-domain-evidence")],
      confidence: "verified",
      dependent_paths: ["src/payments"],
      invalidation_conditions: ["payments ownership changes"],
      contradicts: [],
      human_attribution: null,
      tags: ["domain", "payments"],
      proposed_at: "2026-07-30T01:10:00.000Z",
      payload: {
        specialist_id: "payments",
        concern: "payments",
        one_line: "Owns taking money from a customer exactly once.",
        covers: "Provider adapters, refunds, and retry behaviour.",
        excludes: "Who is allowed to pay, which authentication owns.",
        flows: [
          {
            name: "refund a charge",
            description: "Refund request through settled reversal.",
            steps: [
              { path: "src/payments/index.ts", what_happens: "Validates the refund request." },
              { path: "src/payments/provider.ts", what_happens: "Submits the reversal." },
            ],
          },
        ],
        touchpoints: [
          {
            path: "src/payments/index.ts",
            symbol: "PaymentProvider",
            role: "The provider adapter contract.",
            line_range: [1, 40] as [number, number],
            centrality: "core" as const,
          },
        ],
        invariants: [
          {
            rule: "Refunds must remain idempotent.",
            why: "A retried reversal would double-refund.",
            reference: "src/payments/index.ts",
          },
        ],
        pitfalls: [
          {
            risk: "Refund retried after a partial failure.",
            consequence: "The customer is refunded twice.",
            reference: "src/payments/index.ts",
          },
        ],
        entry_questions: ["Is this write idempotent under retry?"],
        context_paths: ["src/payments/index.ts"],
        related_specialists: [],
        validation_commands: ["npm test -- payments"],
      },
    };
    persistMemoryCandidate(cwd, specialistDraft, testMemoryOptions());
    acceptMemoryCandidate(
      cwd,
      specialistDraft.candidate_id,
      "knowledge-maintainer",
      "accept specialist expertise",
      testMemoryOptions(),
    );

    const episodeDraft: MemoryCandidateDraft = {
      schema_version: "1",
      candidate_id: "task-42-candidate",
      memory_id: "task-42-episode",
      kind: "episode",
      proposed_by_agent_id: "builder",
      owning_agent_id: "builder",
      statement: "Task 42 succeeded after adding the missing integration assertion.",
      source_type: "merged_code",
      supporting_commit: COMMIT_A,
      evidence: [evidence("task-42-evidence", COMMIT_A, "merged_code")],
      confidence: "high",
      dependent_paths: ["tests/payments/integration.test.ts"],
      invalidation_conditions: ["the integration contract changes"],
      contradicts: [],
      human_attribution: null,
      tags: ["learning", "payments"],
      proposed_at: "2026-07-30T01:11:00.000Z",
      payload: {
        task_id: "task-42",
        issue_number: 42,
        outcome: "success",
        attempts: [{
          sequence: 1,
          approach: "Add the missing integration assertion.",
          result: "succeeded",
          failure_category: null,
          signal: "The focused and full validation suites passed.",
          correction: null,
        }],
        review_feedback: ["Keep the assertion at the API boundary."],
        generalization: "candidate",
        cost_usd: 0.25,
        runtime_ms: 1_500,
      },
    };
    persistMemoryCandidate(cwd, episodeDraft, testMemoryOptions());
    acceptMemoryCandidate(
      cwd,
      episodeDraft.candidate_id,
      "knowledge-maintainer",
      "accept task episode",
      testMemoryOptions(),
    );

    assert.deepEqual(
      listMemoryRecords(cwd, { domain: "payments" }).map((record) => record.memory_id),
      ["payments-specialist-memory"],
    );
    assert.deepEqual(
      listMemoryRecords(cwd, { taskId: "task-42" }).map((record) => record.memory_id),
      ["task-42-episode"],
    );
    assert.deepEqual(
      listMemoryRecords(cwd, { evidenceId: "task-42-evidence" }).map((record) => record.memory_id),
      ["task-42-episode"],
    );
    assert.deepEqual(
      listMemoryRecords(cwd, { tag: "learning" }).map((record) => record.memory_id),
      ["task-42-episode"],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("compaction consolidates active evidence while preserving candidate provenance", () => {
  const cwd = tempRepo("agentify-memory-compaction-");
  try {
    initialize(cwd);
    const firstDraft = {
      ...codebaseCandidate("duplicate-a", "memory-a"),
      confidence: "low" as const,
      invalidation_conditions: ["first evidence changes"],
    };
    persistMemoryCandidate(cwd, firstDraft, testMemoryOptions());
    acceptMemoryCandidate(
      cwd,
      firstDraft.candidate_id,
      "knowledge-maintainer",
      "accept first duplicate",
      testMemoryOptions({ now: () => new Date("2026-07-30T01:20:00.000Z") }),
    );
    markMemoryStale(cwd, firstDraft.memory_id, {
      actor: "knowledge-maintainer",
      expectedRevision: 1,
      evidence: [evidence("duplicate-a-stale", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "supporting path changed",
      options: testMemoryOptions({ now: () => new Date("2026-07-30T01:21:00.000Z") }),
    });

    const secondDraft: MemoryCandidateDraft = {
      ...codebaseCandidate("duplicate-b", "memory-b", COMMIT_B),
      statement: firstDraft.statement,
      dependent_paths: firstDraft.dependent_paths,
      payload: firstDraft.payload,
      tags: firstDraft.tags,
      confidence: "verified",
      invalidation_conditions: ["second evidence changes"],
      contradicts: ["prior-fact"],
    };
    persistMemoryCandidate(cwd, secondDraft, testMemoryOptions());
    acceptMemoryCandidate(
      cwd,
      secondDraft.candidate_id,
      "knowledge-maintainer",
      "accept second duplicate while first is stale",
      testMemoryOptions({ now: () => new Date("2026-07-30T01:22:00.000Z") }),
    );
    revalidateMemory(cwd, firstDraft.memory_id, {
      actor: "knowledge-maintainer",
      expectedRevision: 2,
      evidence: [evidence("duplicate-a-revalidated", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "first fact was revalidated",
      options: testMemoryOptions({ now: () => new Date("2026-07-30T01:23:00.000Z") }),
    });

    assert.equal(listMemoryRecords(cwd, { freshness: "current" }).length, 2);
    const result = compactMemoryRecords(
      cwd,
      "knowledge-maintainer",
      COMMIT_B,
      [evidence("compaction-evidence", COMMIT_B)],
      testMemoryOptions({ now: () => new Date("2026-07-30T01:24:00.000Z") }),
    );
    assert.deepEqual(result, { kept: ["memory-a"], superseded: ["memory-b"] });

    const keeper = readMemoryRecord(cwd, "memory-a");
    assert.equal(keeper.revision, 4);
    assert.equal(keeper.confidence, "verified");
    assert.deepEqual(keeper.accepted_candidate_ids, ["duplicate-a"]);
    assert.deepEqual(keeper.invalidation_conditions, [
      "first evidence changes",
      "second evidence changes",
      "supporting path changed",
    ]);
    assert.deepEqual(keeper.contradicts, ["prior-fact"]);
    assert.deepEqual(
      keeper.evidence.map((entry) => entry.evidence_id),
      [
        "compaction-evidence",
        "duplicate-a",
        "duplicate-a-revalidated",
        "duplicate-a-stale",
        "duplicate-b",
      ],
    );

    const duplicate = readMemoryRecord(cwd, "memory-b");
    assert.equal(duplicate.freshness, "superseded");
    assert.equal(duplicate.superseded_by, "memory-a");
    assert.deepEqual(duplicate.accepted_candidate_ids, ["duplicate-b"]);
    assert.deepEqual(
      readAgentMemoryView(cwd, "orchestrator").records.map((record) => record.memory_id),
      ["memory-a"],
    );
    assert.equal(recoverTeamMemoryStore(cwd, testMemoryOptions()).status, "valid");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
