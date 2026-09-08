import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Concern } from "../../src/core/audit/schema/concerns.ts";
import type { AgentRuntime } from "../../src/core/types.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { compileSpecialistEvidence } from "../../src/core/audit/specialist-compiler.ts";
import { reviewSpecialistCompilation } from "../../src/core/audit/specialist-review.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { readReviewPrompt } from "../fixtures/review-prompt.ts";

const SOURCE = "def present(value):\n    return value is not None\n";
const BAD = "An absent value is always present.";
const NOTE = "None makes the presence predicate False.";
for (const scenario of ["reused", "empty-notes", "changed-scope", "changed-thinking", "incomplete-followup",
  "cancelled-followup", "cached-argument-repair", "fresh-invocation"] as const) {
  test(`only completed identical source notes can be reused: ${scenario}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-source-note-reuse-"));
    const controller = new AbortController();
    try {
      for (const [file, source] of Object.entries({
        "a.py": SOURCE,
        "b.py": SOURCE + "# Distinct source identity.\n",
        "large.py": "def relay(value):\n    return value\n" + "# Immutable context for full review.\n".repeat(400),
      })) fs.writeFileSync(path.join(cwd, file), source);
      for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "immutable source views"]]) execFileSync("git", args, { cwd, stdio: "pipe" });
      const body: Concern = {
        concern: "Presence and relay", one_line: "Check presence and relay values.", covers: "Presence and unchanged relay.", excludes: "Storage and copying.",
        flows: [{ name: "Check and relay", description: "Check presence and return original data.", steps: [
          { path: "a.py", what_happens: "Check whether value is None." }, { path: "b.py", what_happens: "Evaluate the secondary presence predicate." },
          { path: "large.py", what_happens: "Return the original value." },
        ] }], touchpoints: ["a.py", "b.py", "large.py"].map(file => ({ path: file, symbol: file === "large.py" ? "relay" : "present",
          role: "Owns its corresponding operation.", line_range: null, centrality: "core" })),
        invariants: Array.from({ length: 26 }, (_, i) => ({ rule: `Case ${i}: relay returns its input.`, why: "The source returns value.", reference: "large.py" })),
        pitfalls: [{ risk: BAD, consequence: "None returns True.", reference: "a.py" },
          { risk: "None is not reported present.", consequence: "Check presence separately from relay.", reference: scenario === "changed-scope" ? "b.py" : "a.py" }],
        entry_questions: ["Does this affect presence?"], validation: [], spans_subtrees: [], stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-09-08T00:00:00.000Z",
      };
      const compilation = compileSpecialistEvidence(makeValidCodebaseMap({ concern_evidence: { concerns: [body], not_concerns: [] }, expert_evidence: undefined }), { cwd });
      assert.ok(compilation.assessment.accepted_concerns.includes(body.concern));
      const original = JSON.stringify(compilation.map);
      const config = { schemaVersion: 1 as const, thinkingLevel: "high" as "high" | "low", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } };
      let observations = 0; let reviews = 0; const sources: string[] = []; const budget = new AuditResourceBudget();
      const runtime: AgentRuntime = { async runSession(options) {
        const input = readReviewPrompt(options.userPrompt) as { source_observation?: boolean; claims?: Record<string, unknown>;
          evidence: Record<string, string>; untrusted_source_observations?: Array<{ path: string; excerpt: string; behavior: string }> };
        options.onProviderRequest!({ inputTokens: 1000, outputTokens: 12000, costUsd: 0.1 });
        assert.equal(options.maxOutputTokens, 12000); assert.ok(options.timeoutMs! <= 90000);
        const account = (): void => options.onEvent?.({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 100, output: 20, cost: { total: 0.001 } } } } as never);
        const tool = options.customTools![0]!;
        if (input.source_observation) {
          observations += 1; sources.push(Object.keys(input.evidence)[0]!); account();
          const report = { observations: scenario === "empty-notes" ? [] : [{ path: sources.at(-1)!, start_line: 2, end_line: 2, behavior: NOTE }] };
          await tool.execute("read", report, undefined, undefined, { cwd } as never);
          if (report.observations[0]) report.observations[0].behavior = "A mutable submission cannot poison accepted notes.";
        } else {
          reviews += 1;
          const falseClaim = Object.keys(input.claims!).find(id => JSON.stringify(input.claims![id]).includes(BAD));
          assert.ok(Array.isArray(input.untrusted_source_observations));
          if (scenario !== "empty-notes") {
            assert.equal(input.untrusted_source_observations[0]!.behavior, NOTE);
            assert.equal(input.untrusted_source_observations[0]!.path, scenario === "changed-scope" && !falseClaim ? "b.py" : "a.py");
            assert.equal(input.untrusted_source_observations[0]!.excerpt, "    return value is not None");
          }
          if (!falseClaim && scenario === "cancelled-followup") { controller.abort(); return { turns: 0, costUsd: null, aborted: true }; }
          account();
          if (!falseClaim && scenario === "incomplete-followup") return { turns: 1, costUsd: 0.001, aborted: true };
          if (!falseClaim && scenario === "cached-argument-repair") {
            await assert.rejects(() => tool.execute("incomplete", { verdict: "supported", checked_claims: [] }, undefined, undefined, { cwd } as never), /missing checked claim IDs/);
            options.onEvent?.({ type: "tool_execution_end", toolName: tool.name, isError: true } as never);
            options.onProviderRequest!({ inputTokens: 1000, outputTokens: 12000, costUsd: 0.1 }); account();
            assert.throws(() => options.onProviderRequest!({ inputTokens: 1000, outputTokens: 12000, costUsd: 0.1 }), /provider-call limit/);
          }
          await tool.execute("review", { verdict: falseClaim ? "unsupported" : "supported", checked_claims: Object.keys(input.claims!),
            ...(falseClaim ? { finding: { claim: falseClaim, path: "a.py", excerpt: "return value is not None", reason: NOTE } } : {}) },
          undefined, undefined, { cwd } as never);
          if (falseClaim && scenario === "changed-thinking") config.thinkingLevel = "low";
        }
        return { turns: 1, costUsd: 0.001, aborted: true };
      } };
      const context = { cwd, runtime, config, signal: controller.signal, ui: { status() {} } };
      const result = await reviewSpecialistCompilation(context as never, compilation, budget, "memo-fixture");
      const record = result.map.specialist_reviews!.records.find(r => r.concern === body.concern)!;
      assert.equal(record.failure === null, !["incomplete-followup", "cancelled-followup"].includes(scenario));
      const mustReadAgain = ["empty-notes", "changed-scope", "changed-thinking"].includes(scenario);
      assert.equal(observations, mustReadAgain ? 2 : 1, "an unchanged successful source reading should not consume a second request");
      assert.equal(reviews, 2, "the changed body still needs complete independent review");
      if (scenario === "changed-scope") assert.deepEqual(sources, ["a.py", "b.py"]);
      assert.equal(budget.snapshot().model_calls, scenario === "cached-argument-repair" || mustReadAgain ? 4 : 3);
      assert.equal(budget.snapshot().unreserved_calls, 0);
      if (scenario === "cancelled-followup") { assert.equal(budget.snapshot().unreported_calls, 1); assert.equal(budget.snapshot().reserved_output_tokens, 12000); }
      assert.equal(JSON.stringify(compilation.map), original);
      assert.equal(Object.hasOwn(record, "observations"), false);
      if (scenario === "fresh-invocation") {
        await reviewSpecialistCompilation(context as never, compilation, budget, "new-invocation");
        assert.equal(observations, 2, "source notes must not become a cross-invocation attestation cache");
        assert.equal(reviews, 4);
      }
      if (!controller.signal.aborted) {
        const before = budget.snapshot().model_calls;
        await reviewSpecialistCompilation(context as never, result, budget, "memo-fixture");
        assert.equal(budget.snapshot().model_calls, before, "same-run failures and approvals retain their existing exact-body cache rules");
      }
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}
