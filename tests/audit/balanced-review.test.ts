import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentRuntime } from "../../src/core/types.ts";
import type { Concern } from "../../src/core/audit/schema/concerns.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { compileSpecialistEvidence } from "../../src/core/audit/specialist-compiler.ts";
import { reviewSpecialistCompilation, specialistReviewDigest } from "../../src/core/audit/specialist-review.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { readReviewPrompt } from "../fixtures/review-prompt.ts";

const CLOCK = "def convert(value):\n    return int(value)\n" + "# Immutable module context.\n".repeat(400);
const CACHE = "def present(record):\n    return record is not None\n";
type Assignment = { index: number; body_digest: string; all_claim_ids: string[];
  required_checked_claim_ids: string[]; scope: { flows: unknown; invariants: unknown };
  focus?: { claims: Record<string, unknown>; evidence: Record<string, string> } };
type TaskInput = { claims: Record<string, unknown>; evidence: Record<string, string>;
  source_precheck?: boolean; assignment?: Assignment };

for (const outcome of ["supported", "incomplete", "foreign-claim", "forged-excerpt", "missing-empty-claim", "contradiction",
  "cancelled", "changed-head", "capacity-refused", "deadline-refused"] as const) {
  test(`balanced complete review keeps whole-body authority: ${outcome}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-balanced-review-"));
    const cancel = new AbortController();
    try {
      fs.writeFileSync(path.join(cwd, "clock.py"), CLOCK);
      fs.writeFileSync(path.join(cwd, "cache.py"), CACHE);
      for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "immutable review fixture"]]) {
        execFileSync("git", args, { cwd, stdio: "pipe" });
      }
      const body: Concern = {
        concern: "Conversion and record presence", one_line: "Convert values and check record presence.",
        covers: "Caller conversion and record presence.", excludes: "Storage and scheduling.",
        flows: [{ name: "Convert and check", description: "Convert a value and check presence.", steps: [
          { path: "clock.py", what_happens: "convert returns int(value)." },
          { path: "cache.py", what_happens: "present tests record against None." },
        ] }],
        touchpoints: [{ path: "clock.py", symbol: "convert", role: "Owns conversion.", line_range: null, centrality: "core" },
          { path: "cache.py", symbol: "present", role: "Checks record presence.", line_range: null, centrality: "core" }],
        invariants: Array.from({ length: 26 }, (_, i) => ({ rule: `Case ${i}: int(value) supplies converted output.`,
          why: "The immutable return expression calls int.", reference: "clock.py" })),
        pitfalls: [{ risk: "A None record is not present.", consequence: "The predicate returns False.", reference: "cache.py" }],
        entry_questions: ["Does this affect conversion or presence?"], validation: [], spans_subtrees: [],
        stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-09-08T00:00:00.000Z",
      };
      const compilation = compileSpecialistEvidence(makeValidCodebaseMap({
        concern_evidence: { concerns: [body], not_concerns: [] }, expert_evidence: undefined,
      }), { cwd });
      assert.ok(compilation.assessment.accepted_concerns.includes(body.concern));
      const original = JSON.stringify(compilation.map);
      const normalized = compilation.map.concern_evidence!.concerns.find(c => c.concern === body.concern)!;
      const config = { schemaVersion: 1 as const, thinkingLevel: "high" as const,
        models: { primary: { provider: "minimax", model: "MiniMax-M3" } } };
      const beforeConfig = JSON.stringify(config);
      const budget = new AuditResourceBudget(outcome === "capacity-refused" ? { maxOutputTokens: 20_000 } : {});
      const inputs = new Map<number, TaskInput>();
      const attempts: number[] = []; const accepted: number[] = [];
      let active = 0; let peak = 0; let checkpoints = 0; let ready!: () => void;
      const barrier = new Promise<void>(resolve => { ready = resolve; });
      const runtime: AgentRuntime = { async runSession(options) {
        const input = readReviewPrompt(options.userPrompt) as TaskInput;
        assert.ok(input.assignment, "large M3 bodies must have an explicit bounded assignment");
        const index = input.assignment.index;
        attempts.push(index); inputs.set(index, input);
        peak = Math.max(peak, ++active);
        try {
          assert.equal(input.source_precheck, undefined);
          assert.equal(options.config, config);
          assert.equal(options.maxOutputTokens, 12_000);
          assert.ok(options.timeoutMs! <= 90_000);
          assert.deepEqual(input.evidence, { "cache.py": CACHE, "clock.py": CLOCK });
          assert.deepEqual(input.assignment.required_checked_claim_ids, Object.keys(input.claims));
          assert.equal(input.assignment.body_digest, specialistReviewDigest(normalized));
          assert.deepEqual(input.assignment.scope.flows, normalized.flows);
          assert.deepEqual(input.assignment.scope.invariants, normalized.invariants);
          if (index === 0) {
            assert.deepEqual(Object.keys(input.assignment.focus!.claims), ["pitfalls[0]"]);
            assert.equal(input.assignment.focus!.evidence["cache.py"], CACHE);
          }
          if (inputs.size === 2) ready();
          const reservation = { inputTokens: 1000, outputTokens: 12000, costUsd: 0.1 };
          if (outcome === "deadline-refused" && index === 1) {
            const now = Date.now;
            try {
              Date.now = () => now() + 90_001;
              assert.throws(() => options.onProviderRequest!(reservation), /deadline expired/);
            } finally { Date.now = now; }
            return { turns: 0, costUsd: null, aborted: true };
          }
          options.onProviderRequest!(reservation);
          options.onEvent?.({ type: "tool_execution_end", toolName: "submit_specialist_review", isError: true } as never);
          assert.throws(() => options.onProviderRequest!(reservation), /provider-call limit/,
            "neither assignment may spend a third request on argument correction");
          await barrier;
          if (outcome === "cancelled") {
            cancel.abort(); return { turns: 0, costUsd: null, aborted: true };
          }
          options.onEvent?.({ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
            usage: { input: 50, output: 10, cost: { total: 0.001 } } } } as never);
          if (outcome === "changed-head" && index === 0) {
            execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "changed identity"], { cwd });
          }
          if (outcome === "incomplete" && index === 1) return { turns: 1, costUsd: 0.001, aborted: true };
          const tool = options.customTools![0]!;
          const ids = Object.keys(input.claims);
          if (outcome === "foreign-claim" && index === 1) {
            const foreign = Object.keys(inputs.get(0)!.claims).find(id => !ids.includes(id))!;
            await assert.rejects(() => tool.execute("foreign", { verdict: "supported", checked_claims: [...ids, foreign] },
              undefined, undefined, { cwd } as never), /invalid or expired/);
            return { turns: 1, costUsd: 0.001, aborted: false };
          }
          if (outcome === "missing-empty-claim" && ids.includes("validation")) {
            await assert.rejects(() => tool.execute("missing", { verdict: "supported", checked_claims: ids.filter(id => id !== "validation") },
              undefined, undefined, { cwd } as never), /missing checked claim IDs: validation/);
            return { turns: 1, costUsd: 0.001, aborted: false };
          }
          if (outcome === "forged-excerpt" && index === 1) {
            await assert.rejects(() => tool.execute("forged", { verdict: "unsupported", checked_claims: [], finding: {
              claim: ids[0], path: "cache.py", excerpt: "return True", reason: "Unobserved source cannot authorize rejection." } },
              undefined, undefined, { cwd } as never), /not contiguous verbatim source/);
            return { turns: 1, costUsd: 0.001, aborted: false };
          }
          if (!options.signal?.aborted) {
            assert.equal(checkpoints, 0, "partial assignments must not publish whole-body approval");
            const finding = outcome === "contradiction" && ids.includes("one_line") ? {
              claim: "one_line", path: "clock.py", excerpt: "return int(value)", reason: "The exact-source finding remains a full-body rejection."
            } : undefined;
            await tool.execute("review", { verdict: finding ? "unsupported" : "supported", checked_claims: ids,
              ...(finding ? { finding } : {}) }, undefined, undefined, { cwd } as never);
            accepted.push(index);
          }
          return { turns: 1, costUsd: 0.001, aborted: true };
        } finally { active -= 1; }
      } };
      const context = { cwd, runtime, config, signal: cancel.signal, ui: { status() {} } };
      const reviewed = await reviewSpecialistCompilation(context as never, compilation, budget, "balanced-fixture", () => { checkpoints += 1; });
      assert.equal(inputs.size, 2, "both exact assignments must participate");
      const sets = [Object.keys(inputs.get(0)!.claims), Object.keys(inputs.get(1)!.claims)];
      const all = [...new Set(sets.flat())].sort();
      assert.deepEqual(all, [...inputs.get(0)!.assignment!.all_claim_ids].sort());
      assert.deepEqual(sets[0]!.filter(id => sets[1]!.includes(id)).sort(), ["concern", "covers", "excludes"]);
      for (let i = 0; i < 26; i += 1) assert.ok(all.includes(`invariants[${i}]`));
      assert.equal(peak, 2);
      assert.equal(attempts.length, outcome === "capacity-refused" ? 3 : 2);
      assert.equal(new Set(accepted).size, accepted.length, "a completed assignment must not be replayed after peer refusal");
      const record = reviewed.map.specialist_reviews!.records.find(r => r.concern === normalized.concern)!;
      assert.equal(record.failure === null, outcome === "supported" || outcome === "capacity-refused");
      if (outcome === "contradiction") { assert.equal(record.retryable, false); assert.equal(record.finding?.claim, "one_line"); }
      else if (outcome !== "supported" && outcome !== "capacity-refused") assert.equal(record.retryable, true);
      assert.equal(budget.snapshot().model_calls, outcome === "deadline-refused" ? 1 : 2);
      assert.equal(budget.snapshot().unreserved_calls, 0);
      if (outcome === "cancelled") {
        assert.equal(budget.snapshot().unreported_calls, 2);
        assert.equal(budget.snapshot().reserved_output_tokens, 24_000);
      }
      assert.equal(JSON.stringify(compilation.map), original);
      assert.equal(JSON.stringify(config), beforeConfig);
      if (outcome === "changed-head") {
        assert.notEqual(reviewed.map.specialist_reviews!.repository_commit,
          execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
          "a changed HEAD must invalidate this unsuccessful review lineage");
      } else {
        const prior = attempts.length;
        await reviewSpecialistCompilation(context as never, reviewed, budget, "balanced-fixture");
        assert.equal(attempts.length, prior, "unchanged body cannot acquire another same-run attempt");
      }
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}


test("paired bodies and small reviews share the existing two-provider scheduler", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-balanced-scheduler-"));
  try {
    const bodies: Concern[] = ["clock", "cache", "queue"].map((name, index) => {
      fs.writeFileSync(path.join(cwd, `${name}.py`), `def ${name}(value):\n    return value\n`);
      return { concern: `${name} lifecycle`, one_line: `Owns ${name} state.`, covers: `${name} processing.`,
        excludes: `Other runtime subsystems.`, flows: [{ name: `Apply ${name}`, description: `Pass ${name} data.`,
          steps: [{ path: `${name}.py`, what_happens: `Receive ${name} data.` }, { path: `${name}.py`, what_happens: `Return ${name} data.` }] }],
        touchpoints: [{ path: `${name}.py`, symbol: name, role: `Owns ${name} operations.`, centrality: "core", line_range: null }],
        invariants: Array.from({ length: index === 2 ? 1 : 26 }, (_, i) => ({ rule: `${name} case ${i}: returns its input.`,
          why: "The immutable source returns value.", reference: `${name}.py` })),
        pitfalls: [], entry_questions: [`Does ${name} state change?`], validation: [], spans_subtrees: [],
        stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-09-08T00:00:00.000Z" };
    });
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "independent behaviors"]]) execFileSync("git", args, { cwd, stdio: "pipe" });
    const compilation = compileSpecialistEvidence(makeValidCodebaseMap({ concern_evidence: { concerns: bodies, not_concerns: [] }, expert_evidence: undefined }), { cwd });
    assert.equal(compilation.assessment.accepted_concerns.length, 3);
    let active = 0; let peak = 0; const activeBodies = new Set<string>(); const stages: Array<number | null> = [];
    const runtime: AgentRuntime = { async runSession(options) {
      const input = readReviewPrompt(options.userPrompt) as TaskInput;
      const name = input.claims.concern as string;
      active += 1; peak = Math.max(peak, active); activeBodies.add(name);
      stages.push(input.assignment?.index ?? null);
      if (input.assignment) assert.equal(activeBodies.size, 1, "a paired body must occupy both slots without another body");
      try {
        options.onProviderRequest!({ inputTokens: 1000, outputTokens: 12000, costUsd: 0.1 });
        await new Promise(resolve => setTimeout(resolve, 5));
        options.onEvent?.({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 100, output: 10, cost: { total: 0.001 } } } } as never);
        await options.customTools![0]!.execute("review", { verdict: "supported", checked_claims: Object.keys(input.claims) }, undefined, undefined, { cwd } as never);
        return { turns: 1, costUsd: 0.001, aborted: true };
      } finally { active -= 1; if (active === 0) activeBodies.clear(); }
    } };
    const budget = new AuditResourceBudget();
    const reviewed = await reviewSpecialistCompilation({ cwd, runtime, ui: { status() {} }, config: { schemaVersion: 1, thinkingLevel: "high", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } } } as never, compilation, budget, "paired-scheduler");
    assert.equal(peak, 2);
    assert.deepEqual(stages, [0, 1, 0, 1, null]);
    assert.equal(budget.snapshot().model_calls, 5);
    assert.ok(reviewed.map.specialist_reviews!.records.every(record => record.failure === null));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
