import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ENGAGEMENT_STATUSES,
  EngagementCharterSchema,
  EngagementError,
  createEngagement,
  engagementCharterPath,
  engagementRootPath,
  legalEngagementTransitions,
  listEngagements,
  readEngagement,
  transitionEngagement,
  updateEngagement,
  validateEngagementId,
  type CreateEngagementInput,
  type EngagementCharter,
  type EngagementStatus,
} from "../../src/core/engagement/index.ts";

const FIRST_TIME = new Date("2026-07-22T10:00:00.000Z");
const SECOND_TIME = new Date("2026-07-22T11:00:00.000Z");

function input(): CreateEngagementInput {
  return {
    repository: { root: "/work/repo", remote: "https://example.test/owner/repo.git" },
    workflow_name: "Invoice review",
    workflow_owner: "Operations",
    intended_users: ["analysts"],
    systems_involved: ["billing", "ledger"],
    problem_statement: "Manual invoice review is slow and inconsistent.",
    workflow_frequency: "daily",
    baseline_metrics: [{ name: "cycle time", unit: "minutes", value: 45 }],
    desired_primary_outcome: "Reduce invoice review cycle time.",
    target: { direction: "decrease", value: 15, unit: "minutes" },
    guardrail_metrics: [{ name: "error rate", unit: "percent", value: 1 }],
    forbidden_actions: ["approve payments"],
    requires_human_approval: true,
    maximum_cost_usd: 100,
    maximum_runtime_minutes: 30,
    business_owner: "Finance VP",
    technical_owner: "Platform lead",
    evidence_references: ["ticket:FIN-1"],
  };
}

function validCharter(overrides: Partial<EngagementCharter> = {}): EngagementCharter {
  return {
    ...input(),
    schema_version: "1",
    revision: 1,
    engagement_id: "invoice-review",
    created_at: FIRST_TIME.toISOString(),
    updated_at: FIRST_TIME.toISOString(),
    status: "draft",
    stop_reason: null,
    ...overrides,
  };
}

function tempState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-engagement-"));
}

function expectCode(fn: () => unknown, code: EngagementError["code"]): EngagementError {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof EngagementError);
    assert.equal(error.code, code);
    return true;
  });
  try { fn(); } catch (error) { return error as EngagementError; }
  throw new Error("expected function to throw");
}

test("schema accepts a valid charter and rejects malformed contracts", () => {
  assert.equal(Value.Check(EngagementCharterSchema, validCharter()), true);
  const cases: unknown[] = [
    (() => { const { problem_statement: _, ...rest } = validCharter(); return rest; })(),
    { ...validCharter(), unknown: true },
    validCharter({ created_at: "July 22" }),
    validCharter({ status: "open" as EngagementStatus }),
    validCharter({ problem_statement: "" }),
    validCharter({ baseline_metrics: [{ name: "", unit: "minutes", value: 1 }] }),
    validCharter({ maximum_cost_usd: -1 }),
    validCharter({ maximum_runtime_minutes: -1 }),
    validCharter({ target: { direction: "up" as "increase", value: 1, unit: "items" } }),
  ];
  for (const candidate of cases) assert.equal(Value.Check(EngagementCharterSchema, candidate), false);
});

test("safe IDs resolve strictly beneath the supplied provider state root", () => {
  const root = tempState();
  try {
    assert.equal(
      engagementCharterPath(root, "engagement-1"),
      path.join(root, "engagements", "engagement-1", "charter.json"),
    );
    for (const unsafe of ["", "a/b", "a\\b", "../escape", "/absolute", "%2e%2e", "%2Ftmp", ".", ".."]) {
      expectCode(() => validateEngagementId(unsafe), "invalid_id");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("symlinked engagement state paths are rejected", { skip: process.platform === "win32" }, () => {
  const root = tempState();
  const outside = tempState();
  try {
    fs.symlinkSync(outside, path.join(root, "engagements"));
    expectCode(() => engagementCharterPath(root, "safe-id"), "unsafe_path");
    expectCode(() => engagementRootPath(root), "unsafe_path");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("create, read, duplicate detection, update, conflict, and deterministic listing", () => {
  const root = tempState();
  try {
    const created = createEngagement(root, "zeta", input(), { now: () => FIRST_TIME });
    assert.equal(created.revision, 1);
    assert.equal(created.status, "draft");
    assert.deepEqual(readEngagement(root, "zeta"), created);
    expectCode(() => createEngagement(root, "zeta", input()), "already_exists");

    const updated = updateEngagement(root, "zeta", { workflow_name: "Updated review" }, 1, {
      now: () => SECOND_TIME,
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.updated_at, SECOND_TIME.toISOString());
    assert.equal(updated.workflow_name, "Updated review");
    expectCode(() => updateEngagement(root, "zeta", { workflow_name: "stale" }, 1), "revision_conflict");
    expectCode(
      () => updateEngagement(root, "zeta", { status: "completed" } as unknown as CreateEngagementInput, 2),
      "invalid_charter",
    );
    assert.equal(readEngagement(root, "zeta").status, "draft");

    createEngagement(root, "alpha", input(), { now: () => FIRST_TIME });
    assert.deepEqual(listEngagements(root).map((charter) => charter.engagement_id), ["alpha", "zeta"]);
    expectCode(() => readEngagement(root, "missing"), "not_found");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed atomic update preserves the original charter", () => {
  const root = tempState();
  try {
    const created = createEngagement(root, "atomic", input(), { now: () => FIRST_TIME });
    expectCode(() => updateEngagement(root, "atomic", { workflow_name: "lost" }, 1, {
      now: () => SECOND_TIME,
      beforeRename: () => { throw new Error("simulated rename boundary failure"); },
    }), "persistence_failed");
    assert.deepEqual(readEngagement(root, "atomic"), created);
    assert.deepEqual(fs.readdirSync(path.dirname(engagementCharterPath(root, "atomic"))), ["charter.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("invalid JSON and schema-invalid persisted state produce corrupt-state errors", () => {
  const root = tempState();
  try {
    createEngagement(root, "corrupt", input(), { now: () => FIRST_TIME });
    const filePath = engagementCharterPath(root, "corrupt");
    fs.writeFileSync(filePath, "{broken");
    assert.match(expectCode(() => readEngagement(root, "corrupt"), "corrupt_state").message, /invalid JSON/);
    fs.writeFileSync(filePath, `${JSON.stringify({ engagement_id: "corrupt" })}\n`);
    assert.match(expectCode(() => readEngagement(root, "corrupt"), "corrupt_state").message, /schema-invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("every declared legal lifecycle edge succeeds with revision and timestamp updates", () => {
  for (const from of ENGAGEMENT_STATUSES) {
    for (const to of legalEngagementTransitions(from)) {
      const root = tempState();
      try {
        const filePath = engagementCharterPath(root, "edge");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(validCharter({ engagement_id: "edge", status: from }))}\n`);
        const transitioned = transitionEngagement(
          root,
          "edge",
          to,
          1,
          to === "stopped" ? "Sponsor ended the work" : undefined,
          { now: () => SECOND_TIME },
        );
        assert.equal(transitioned.status, to, `${from} -> ${to}`);
        assert.equal(transitioned.revision, 2);
        assert.equal(transitioned.updated_at, SECOND_TIME.toISOString());
        if (to !== "stopped") assert.equal(transitioned.stop_reason, null);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("illegal, terminal, reasonless, and stale transitions fail", () => {
  const root = tempState();
  try {
    createEngagement(root, "flow", input(), { now: () => FIRST_TIME });
    expectCode(() => transitionEngagement(root, "flow", "building", 1), "invalid_transition");
    expectCode(() => transitionEngagement(root, "flow", "stopped", 1, "  "), "invalid_transition");
    transitionEngagement(root, "flow", "qualified", 1, undefined, { now: () => SECOND_TIME });
    expectCode(() => transitionEngagement(root, "flow", "auditing", 1), "revision_conflict");

    for (const terminal of ["completed", "stopped"] as const) {
      const filePath = engagementCharterPath(root, terminal);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(validCharter({ engagement_id: terminal, status: terminal }))}\n`);
      expectCode(() => transitionEngagement(root, terminal, "draft", 1), "invalid_transition");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
