import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditBudgetExceededError,
  AuditResourceBudget,
  DEFAULT_AUDIT_BUDGETS,
  resolveAuditBudgets,
  unresolvedObligationFingerprint,
} from "../../src/core/audit/resource-budget.ts";

test("audit budget defaults bound every aggregate resource", () => {
  const limits = resolveAuditBudgets(undefined);
  assert.deepEqual(limits, DEFAULT_AUDIT_BUDGETS);
  for (const [name, value] of Object.entries(limits)) {
    assert.ok(Number.isFinite(value) && value > 0, `${name} must have a finite positive default`);
  }
  assert.ok(limits.maxSessionDurationMs <= limits.maxTotalDurationMs);
  assert.ok(limits.maxScoutDurationMs <= limits.maxSessionDurationMs);
  assert.ok(limits.maxTracerDurationMs <= limits.maxSessionDurationMs);
});

test("parent provider calls, turns, tokens, and cost share one hard budget", () => {
  const budget = new AuditResourceBudget({
    maxModelCalls: 1,
    maxTurns: 1,
    maxInputTokens: 10,
    maxOutputTokens: 10,
    maxTotalCostUsd: 1,
  });
  const session = budget.beginSession();
  budget.observeParentEvent({
    type: "message_end",
    message: { usage: { input: 5, output: 5, cost: { total: 0.5 } } },
  } as never, session);
  assert.throws(
    () => budget.finishParentSession(session, {
      turns: 2,
      costUsd: 0.5,
      diagnostics: { provider_requests: 2 },
    }),
    AuditBudgetExceededError,
  );
});

test("a continuation at the exact aggregate call limit fails before another request", () => {
  const budget = new AuditResourceBudget({ maxModelCalls: 1 });
  const session = budget.beginSession();
  assert.throws(
    () => budget.observeParentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        usage: { input: 1, output: 1, cost: { total: 0 } },
      },
    } as never, session),
    /model calls reached 1 while requesting continuation/i,
  );
  assert.throws(
    () => budget.finishParentSession(session, {
      turns: 2,
      costUsd: 0,
      diagnostics: { provider_requests: 2 },
    }),
    /model calls reached 1 while requesting continuation/i,
  );
  assert.equal(
    budget.snapshot().model_calls,
    1,
    "reconciliation after a recorded failure must not mutate counters past the limit",
  );

  const finalBudget = new AuditResourceBudget({ maxModelCalls: 1 });
  const finalSession = finalBudget.beginSession();
  assert.doesNotThrow(() => finalBudget.observeParentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 1, output: 1, cost: { total: 0 } },
    },
  } as never, finalSession));
});

test("tool-result message events cannot consume provider-call or turn budgets", () => {
  const budget = new AuditResourceBudget({ maxModelCalls: 1, maxTurns: 1 });
  const session = budget.beginSession();
  budget.observeParentEvent({
    type: "message_end",
    message: { role: "toolResult", stopReason: null, usage: undefined },
  } as never, session);
  assert.deepEqual(
    { model_calls: budget.snapshot().model_calls, turns: budget.snapshot().turns },
    { model_calls: 0, turns: 0 },
    "only provider-generated assistant messages are billable model calls and turns",
  );
  assert.doesNotThrow(() => budget.observeParentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 1, output: 1, cost: { total: 0 } },
    },
  } as never, session));
  assert.deepEqual(
    { model_calls: budget.snapshot().model_calls, turns: budget.snapshot().turns },
    { model_calls: 1, turns: 1 },
  );
});

test("explorer spawns share aggregate limits and receive mode-specific timeouts", () => {
  const budget = new AuditResourceBudget({
    maxExplorerSpawns: 2,
    maxScoutDurationMs: 1_111,
    maxTracerDurationMs: 2_222,
  });
  assert.ok(budget.reserveExplorer("concern_scout") <= 1_111);
  assert.ok(budget.reserveExplorer("concern_tracer") <= 2_222);
  assert.throws(() => budget.reserveExplorer("concern_tracer"), AuditBudgetExceededError);
});

test("explorer usage contributes to the same call, token, and cost counters", () => {
  const budget = new AuditResourceBudget({ maxTotalCostUsd: 0.01 });
  assert.throws(
    () => budget.recordExplorerMessages([{
      role: "assistant",
      usage: { input: 100, output: 20, cost: { total: 0.02 } },
    }]),
    /provider-reported cost exceeded \$0\.01/,
  );
  assert.equal(budget.snapshot().model_calls, 1);
});

test("unresolved-obligation fingerprints are canonical and sensitive", () => {
  const first = unresolvedObligationFingerprint({ paths: ["a", "b"], reasons: { z: 1, a: 2 } });
  const reordered = unresolvedObligationFingerprint({ reasons: { a: 2, z: 1 }, paths: ["a", "b"] });
  const changed = unresolvedObligationFingerprint({ reasons: { a: 2, z: 1 }, paths: ["a", "c"] });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
