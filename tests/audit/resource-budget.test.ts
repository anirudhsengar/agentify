import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditBudgetExceededError,
  AuditResourceBudget,
  DEFAULT_AUDIT_BUDGETS,
  resolveAuditBudgets,
  unresolvedObligationFingerprint,
  providerRequestReservation,
} from "../../src/core/audit/resource-budget.ts";

test("reservation uses full context, bounded output, and the highest input/cache price", () => {
  const model = { contextWindow: 100_000, maxTokens: 10_000,
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 } };
  assert.deepEqual(providerRequestReservation(model, 1_000), {
    inputTokens: 100_000, outputTokens: 1_000, costUsd: 0.204,
  });
  assert.equal(providerRequestReservation(model).outputTokens, 10_000,
    "a backend without a wire output ceiling reserves the model maximum");
  assert.throws(() => providerRequestReservation({ ...model, cost: { ...model.cost, input: NaN } }), /metadata/);
});

test("legacy unanswered requests without bounds cannot silently authorize new paid calls", () => {
  const prior = { ...new AuditResourceBudget().snapshot(), model_calls: 1, turns: 0 };
  delete prior.unreported_calls;
  delete prior.unreserved_calls;
  const budget = new AuditResourceBudget(undefined, Date.now(), prior);
  assert.equal(budget.snapshot().unreserved_calls, 1);
  assert.throws(() => budget.recordProviderRequest(budget.beginSession(), {
    inputTokens: 1, outputTokens: 1, costUsd: 0,
  }), /prior unanswered requests lack resource reservations/);
});

test("interrupted requests retain bounded token and cost reservations across continuation", () => {
  const budget = new AuditResourceBudget({ maxTotalCostUsd: 1 });
  const session = budget.beginSession();
  budget.recordProviderRequest(session, { inputTokens: 1_000, outputTokens: 100, costUsd: 0.6 });
  budget.observeParentEvent({ type: "message_end", message: {
    role: "assistant", stopReason: "aborted",
    usage: { input: 0, output: 0, cost: { total: 0 } },
  } } as never, session);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.unreported_calls, 1);
  assert.equal(snapshot.reserved_input_tokens, 1_000);
  assert.equal(snapshot.reserved_output_tokens, 100);
  assert.equal(snapshot.reserved_cost_usd, 0.6);
  assert.equal(snapshot.cost_usd, 0, "reservation is not measured provider usage");
  const continued = new AuditResourceBudget({ maxTotalCostUsd: 1 }, Date.now(), snapshot);
  assert.throws(() => continued.recordProviderRequest(continued.beginSession(), {
    inputTokens: 100, outputTokens: 10, costUsd: 0.5,
  }), /cost.*reserv|reserv.*cost/i);
  assert.equal(continued.snapshot().model_calls, 1, "denied request cannot be charged as dispatched");
});

test("completed provider usage replaces only that session's reservation", () => {
  const budget = new AuditResourceBudget();
  const parent = budget.beginSession();
  const child = budget.beginSession();
  budget.recordProviderRequest(parent, { inputTokens: 1_000, outputTokens: 100, costUsd: 0.6 });
  budget.recordProviderRequest(child, { inputTokens: 500, outputTokens: 50, costUsd: 0.3 });
  budget.observeParentEvent({ type: "message_end", message: {
    role: "assistant", stopReason: "toolUse",
    usage: { input: 70, cacheRead: 10, output: 9, cost: { total: 0.02 } },
  } } as never, child);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.unreported_calls, 1);
  assert.equal(snapshot.reserved_input_tokens, 1_000);
  assert.equal(snapshot.reserved_cost_usd, 0.6);
  assert.equal(snapshot.input_tokens, 80);
  assert.equal(snapshot.cost_usd, 0.02);
  assert.equal(snapshot.model_calls, 2);
});

test("usage reported at a deadline is charged before the deadline rejects it", () => {
  const budget = new AuditResourceBudget();
  const session = budget.beginSession();
  session.startedAt -= session.maxDurationMs + 1;
  assert.throws(() => budget.observeParentEvent({
    type: "message_end",
    message: { role: "assistant", usage: { input: 7, cacheRead: 11, output: 3, cost: { total: 0.02 } } },
  } as never, session), /session elapsed time/);
  const usage = budget.snapshot();
  assert.deepEqual(usage, {
    ...usage, model_calls: 1, turns: 1, input_tokens: 18, output_tokens: 3, cost_usd: 0.02,
  });
});

test("a session deadline preserves the aggregate allowance for bounded recovery", () => {
  const budget = new AuditResourceBudget();
  const expired = budget.beginSession();
  budget.recordProviderRequest(expired);
  expired.startedAt -= expired.maxDurationMs + 1;
  assert.throws(() => budget.recordProviderRequest(expired), /session elapsed time/);
  budget.finishParentSession(expired, { turns: 0, costUsd: 0.01, diagnostics: { provider_requests: 1 } });
  budget.reserveCoverageRecoveryPass();
  const recovery = budget.beginSession();
  budget.recordProviderRequest(recovery);
  assert.equal(budget.snapshot().model_calls, 2);
  assert.equal(budget.snapshot().cost_usd, 0.01);
  assert.throws(() => budget.recordProviderRequest(expired), /session elapsed time/);
  assert.throws(() => budget.reserveCoverageRecoveryPass(), /coverage recovery passes/);
});

test("aggregate elapsed checks include time charged before a continuation", () => {
  const budget = new AuditResourceBudget(undefined, Date.now() - 1_000, {
    ...new AuditResourceBudget().snapshot(), elapsed_ms: DEFAULT_AUDIT_BUDGETS.maxTotalDurationMs - 500,
  });
  assert.throws(() => budget.assertWithinBudget(), /elapsed time exceeded/);
});

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

test("an interrupted admitted request remains charged without inventing response usage", () => {
  const budget = new AuditResourceBudget({ maxModelCalls: 1 });
  const session = budget.beginSession();
  budget.recordProviderRequest(session);
  assert.equal(budget.snapshot().model_calls, 1);
  assert.equal(budget.snapshot().turns, 0);
  assert.equal(budget.snapshot().cost_usd, 0, "no provider usage has arrived; this is not a measured free request");
  assert.throws(() => budget.recordProviderRequest(session), /model calls reached 1/);
  assert.equal(budget.snapshot().model_calls, 1);
});

test("admission and response observations count one call, including explorer overlap", () => {
  const budget = new AuditResourceBudget();
  const parent = budget.beginSession();
  const explorer = budget.beginSession();
  const response = { type: "message_end", message: { role: "assistant", usage: { input: 7, output: 3 } } } as never;
  budget.recordProviderRequest(parent);
  budget.observeParentEvent(response, parent);
  budget.recordProviderRequest(explorer);
  budget.observeParentEvent(response, explorer);
  budget.recordProviderRequest(explorer); // Interrupted: no usage response.
  budget.finishParentSession(parent, { turns: 1, costUsd: null, diagnostics: { provider_requests: 1 } });
  budget.finishParentSession(explorer, { turns: 1, costUsd: null, diagnostics: { provider_requests: 2 } });
  assert.equal(budget.snapshot().model_calls, 3);
  assert.equal(budget.snapshot().turns, 2);
  assert.equal(budget.snapshot().input_tokens, 14);
  assert.equal(budget.snapshot().output_tokens, 6);
});

test("session deadlines leave bounded headroom for terminal cleanup", () => {
  const budget = new AuditResourceBudget(
    undefined,
    Date.now(),
    {
      elapsed_ms: DEFAULT_AUDIT_BUDGETS.maxTotalDurationMs - 1_500,
      model_calls: 0,
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      explorer_spawns: 0,
      coverage_recovery_passes: 0,
      semantic_repair_passes: 0,
    },
  );
  assert.ok(
    budget.remainingDurationMs() <= 500,
    "the final provider session must stop before the total deadline so cleanup and terminal audit accounting remain within budget",
  );

  const early = new AuditResourceBudget(
    { maxSessionDurationMs: 1_000 },
  );
  assert.equal(early.remainingDurationMs(), 1_000);
});

test("default budgets retain bounded capacity for a final obligation-focused repair pass", () => {
  const budget = new AuditResourceBudget(undefined, Date.now(), {
    elapsed_ms: 997_918,
    model_calls: 160,
    turns: 160,
    input_tokens: 2_614_181,
    output_tokens: 95_679,
    cost_usd: 0.39316984,
    explorer_spawns: 18,
    coverage_recovery_passes: 0,
    semantic_repair_passes: 1,
  });
  assert.doesNotThrow(() => budget.assertProviderSessionCapacity(1_000_000));
  assert.equal(budget.remainingModelCalls(64), 64);
  for (let index = 0; index < 6; index += 1) {
    assert.doesNotThrow(() => budget.reserveExplorer("concern_tracer"));
  }
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
    message: { role: "assistant", usage: { input: 5, output: 5, cost: { total: 0.5 } } },
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
    2,
    "reported post-limit usage must remain charged while the run stays failed; hiding an overrun is not enforcement",
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

test("an explorer call cap reserves one aggregate call for the parent to consume its report", () => {
  const budget = new AuditResourceBudget({ maxModelCalls: 3 });
  const session = budget.beginSession();
  budget.observeParentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cost: { total: 0 } },
    },
  } as never, session);
  assert.equal(
    budget.remainingModelCalls(10),
    1,
    "one of the two remaining calls must stay reserved for the parent continuation",
  );

  const noCapacity = new AuditResourceBudget({ maxModelCalls: 2 });
  const noCapacitySession = noCapacity.beginSession();
  noCapacity.observeParentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cost: { total: 0 } },
    },
  } as never, noCapacitySession);
  assert.throws(
    () => noCapacity.remainingModelCalls(10),
    /model-call capacity.*parent continuation/i,
  );
});

test("a continuation reserves enough aggregate input budget for the next observed context", () => {
  const budget = new AuditResourceBudget({ maxInputTokens: 15 });
  const session = budget.beginSession();
  assert.throws(
    () => budget.observeParentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        usage: { input: 4, cacheRead: 6, output: 1, cost: { total: 0 } },
      },
    } as never, session),
    /input token reserve.*next provider request/i,
  );
  assert.equal(
    budget.snapshot().input_tokens,
    10,
    "request admission must stop before aggregate input usage crosses the configured cap",
  );
});

test("a new session rejects a provider payload that can overshoot persisted input headroom", () => {
  const persistedUsage = {
    elapsed_ms: 1_048_060,
    model_calls: 85,
    turns: 85,
    input_tokens: 1_995_420,
    output_tokens: 72_797,
    cost_usd: 0.18641548,
    explorer_spawns: 8,
    coverage_recovery_passes: 0,
    semantic_repair_passes: 0,
  };
  const budget = new AuditResourceBudget(
    { maxInputTokens: 2_000_000 },
    Date.now(),
    persistedUsage,
  );
  const admission = budget as unknown as {
    assertProviderInputCapacity(payload: unknown): number;
  };
  assert.throws(
    () => admission.assertProviderInputCapacity({ input: "x".repeat(7_141) }),
    /input token reserve 4580.*serialized provider request bound/i,
  );
  assert.equal(
    budget.snapshot().input_tokens,
    persistedUsage.input_tokens,
    "rejected request admission must not mutate trusted usage",
  );

  const admissible = new AuditResourceBudget(
    { maxInputTokens: 2_000_000 },
    Date.now(),
    { ...persistedUsage, input_tokens: 1_980_000 },
  ) as unknown as { assertProviderInputCapacity(payload: unknown): number };
  assert.doesNotThrow(() => admissible.assertProviderInputCapacity({ input: "x".repeat(7_141) }));
});

test("a new model session reserves its maximum input window before the initial request", () => {
  const persistedUsage = {
    elapsed_ms: 1_048_060,
    model_calls: 85,
    turns: 85,
    input_tokens: 1_995_420,
    output_tokens: 72_797,
    cost_usd: 0.18641548,
    explorer_spawns: 8,
    coverage_recovery_passes: 0,
    semantic_repair_passes: 0,
  };
  const budget = new AuditResourceBudget(
    { maxInputTokens: 2_000_000 },
    Date.now(),
    persistedUsage,
  ) as unknown as { assertProviderSessionCapacity(contextWindow: number): void };
  assert.throws(
    () => budget.assertProviderSessionCapacity(272_000),
    /input token reserve 4580.*model context window of 272000/i,
  );

  const admissible = new AuditResourceBudget(
    { maxInputTokens: 2_000_000 },
    Date.now(),
    { ...persistedUsage, input_tokens: 1_700_000 },
  ) as unknown as { assertProviderSessionCapacity(contextWindow: number): void };
  assert.doesNotThrow(() => admissible.assertProviderSessionCapacity(272_000));
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

test("runtime message counts cannot inflate provider-turn reconciliation", () => {
  const budget = new AuditResourceBudget({ maxModelCalls: 1, maxTurns: 1 });
  const session = budget.beginSession();
  budget.observeParentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 1, output: 1, cost: { total: 0 } },
    },
  } as never, session);

  assert.doesNotThrow(() => budget.finishParentSession(session, {
    turns: 4,
    costUsd: 0,
    diagnostics: { provider_requests: 1 },
  }));
  assert.deepEqual(
    { model_calls: budget.snapshot().model_calls, turns: budget.snapshot().turns },
    { model_calls: 1, turns: 1 },
    "runtime message totals include user/tool-result delivery and are not provider turns",
  );
});

test("a parent session cannot continue past its application-owned duration", async () => {
  const budget = new AuditResourceBudget({ maxSessionDurationMs: 1 });
  const session = budget.beginSession();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(
    () => budget.observeParentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1, output: 1, cost: { total: 0 } },
      },
    } as never, session),
    /session elapsed time.*1ms/i,
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

test("persisted usage bounds same-commit continuation passes and counters", () => {
  const budget = new AuditResourceBudget({
    maxModelCalls: 5,
    maxTurns: 5,
    maxCoverageRecoveryPasses: 1,
    maxSemanticRepairPasses: 2,
  }, Date.now(), {
    elapsed_ms: 10,
    model_calls: 3,
    turns: 3,
    input_tokens: 20,
    output_tokens: 5,
    cost_usd: 0.25,
    explorer_spawns: 1,
    coverage_recovery_passes: 1,
    semantic_repair_passes: 2,
  });
  assert.equal(budget.remainingModelCalls(10), 1);
  assert.throws(() => budget.reserveSemanticRepairPass(), /semantic repair passes reached 2/i);
  assert.equal(budget.snapshot().model_calls, 3);
  const fingerprint = "a".repeat(64);
  assert.equal(budget.recordUnresolvedFingerprint(fingerprint), true);
  assert.equal(budget.recordUnresolvedFingerprint(fingerprint), true);
  assert.equal(budget.recordUnresolvedFingerprint(fingerprint), false);
  assert.deepEqual(budget.unresolvedFingerprints(), [fingerprint, fingerprint, fingerprint]);
});

test("unresolved-obligation fingerprints are canonical and sensitive", () => {
  const first = unresolvedObligationFingerprint({ paths: ["a", "b"], reasons: { z: 1, a: 2 } });
  const reordered = unresolvedObligationFingerprint({ reasons: { a: 2, z: 1 }, paths: ["a", "b"] });
  const changed = unresolvedObligationFingerprint({ reasons: { a: 2, z: 1 }, paths: ["a", "c"] });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
