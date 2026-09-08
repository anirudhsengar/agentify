import {Value} from "typebox/value";
import {withPrecheckProofs} from "./precheck-proof-runtime.mjs";
import { readReviewPrompt } from "../../tests/fixtures/review-prompt.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Concern } from "../../src/core/audit/schema/concerns.ts";
import type { AgentRuntime } from "../../src/core/types.ts";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { compileSpecialistEvidence } from "../../src/core/audit/specialist-compiler.ts";
import { reviewSpecialistCompilation } from "../../src/core/audit/specialist-review.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { makeValidCodebaseMap } from "../../tests/fixtures/codebase-map.ts";

for (const outcome of ["complete", "contradiction", "missing-clause", "unbound-id", "forged-excerpt"] as const) {
  test(`native MiniMax local source proofs preserve final review authority: ${outcome}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-native-source-check-"));
    const small = "def present(record):\n    return record is not None\n";
    const large = "def relay(record):\n    return record\n" + "# Broader immutable source context.\n".repeat(400);
    let sawClausePlan = false;
    const requests: Array<{ precheck: boolean; cap: number | undefined; thinking: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        max_tokens?: number; thinking?: unknown; tool_choice?: unknown;
        messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      };
      const content = payload.messages.find(message => message.role === "user")!.content;
      const text = typeof content === "string" ? content : content.map(part => part.text ?? "").join("\n");
      const data = readReviewPrompt(text) as { source_precheck?: boolean; claims: Record<string, { original_claim?: string; field?: string; text?: string }>; evidence: Record<string, string>; original_claim_context?: Record<string, unknown> };
      const precheck = data.source_precheck === true;
      requests.push({ precheck, cap: payload.max_tokens, thinking: payload.thinking });
      assert.deepEqual(payload.tool_choice, { type: "auto" });
      assert.equal(data.evidence["small.py"], small);
      if (precheck) {
        sawClausePlan = data.original_claim_context !== undefined && Object.keys(data.claims).length > 2;
        if (sawClausePlan) {
          assert.deepEqual(Object.keys(data.original_claim_context!), ["pitfalls[0]"]);
          assert.ok(Object.values(data.claims).every(clause => clause.original_claim === "pitfalls[0]"));
        }
      }
      else {
        assert.equal(data.evidence["large.py"], large);
        assert.ok(Object.keys(data.claims).length > 24);
      }
      const target = Object.entries(data.claims).find(([, clause]) => clause.text?.includes("absent record"))?.[0] ?? "pitfalls[0]";
      const rejects = ["contradiction", "unbound-id", "forged-excerpt"].includes(outcome);
      const finding = rejects && precheck ? {
        claim: outcome === "unbound-id" ? "pitfalls[0]" : target, path: "small.py",
        excerpt: outcome === "forged-excerpt" ? "return True" : "return record is not None",
        reason: "A None record makes the predicate False, not True.",
      } : undefined;
      const other = Object.keys(data.claims).find(id => id !== target)!;
      const report = { verdict: finding ? "unsupported" : "supported",
        checked_claims: outcome === "missing-clause" && precheck ? Object.keys(data.claims).slice(0,-1) : Object.keys(data.claims),
        ...(finding ? { finding } : {}),
        ...(outcome === "duplicate-parent" && precheck ? { additional_findings: [{ ...finding!, claim: other }] } : {}),
      };
      const reports = precheck && sawClausePlan
        ? finding ? [{claim: finding.claim,path: finding.path,excerpt: finding.excerpt,reason: finding.reason,verdict:"unsupported"}]
          : report.checked_claims.map(claim=>({claim,path:"small.py",excerpt:"return record is not None",reason:"The exact expression returns False when record is None.",verdict:"supported"}))
        : [report];
      const index=requests.length;
      const events: Array<[string, unknown]> = [["message_start",{type:"message_start",message:{id:`fixture-${index}`,type:"message",role:"assistant",model:"MiniMax-M3",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}}]];
      for(const [block, input] of reports.entries()) {
        events.push(["content_block_start",{type:"content_block_start",index:block,content_block:{type:"tool_use",id:`review-${index}-${block}`,name:"submit_specialist_review",input:{}}}],
          ["content_block_delta",{type:"content_block_delta",index:block,delta:{type:"input_json_delta",partial_json:JSON.stringify(input)}}],
          ["content_block_stop",{type:"content_block_stop",index:block}]);
      }
      events.push(["message_delta",{type:"message_delta",delta:{stop_reason:"tool_use",stop_sequence:null},usage:{output_tokens:40}}],["message_stop",{type:"message_stop"}]);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(""));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      fs.writeFileSync(path.join(cwd, "small.py"), small);
      fs.writeFileSync(path.join(cwd, "large.py"), large);
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", ["-C", cwd, "add", "."]);
      execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "local source review"]);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: { minimax: {
        baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages", apiKey: "local-test-placeholder",
        models: [{ id: "MiniMax-M3", reasoning: true, contextWindow: 32768, maxTokens: 12000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } } }));
      const body: Concern = {
        concern: "Record presence and relay", one_line: "Checks presence and relays records.", covers: "Record presence and relay.", excludes: "Copying and storage.",
        flows: [{ name: "Check and relay", description: "Check presence and relay unchanged.", steps: [
          { path: "small.py", what_happens: "present checks for None." }, { path: "large.py", what_happens: "relay returns the record." },
        ] }],
        touchpoints: [{ path: "small.py", symbol: "present", role: "Checks presence.", line_range: null, centrality: "core" },
          { path: "large.py", symbol: "relay", role: "Relays records.", line_range: null, centrality: "core" }],
        invariants: Array.from({ length: 26 }, (_, index) => ({ rule: `Case ${index}: relay returns its argument.`,
          why: "The return expression is record.", reference: "large.py" })),
        pitfalls: [{ risk: ["contradiction"].includes(outcome)
          ? "The predicate compares record with None, so an absent record returns True. The comparison controls presence."
          : "The predicate compares record with None. An absent record returns False. The comparison controls presence.",
          consequence: "Presence is separate from relay.", reference: "small.py" }],
        entry_questions: ["Does this affect presence?"], validation: [], spans_subtrees: [],
        stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-08-31T00:00:00.000Z",
      };
      const compilation = compileSpecialistEvidence(makeValidCodebaseMap({ concern_evidence: { concerns: [body], not_concerns: [] },
        expert_evidence: undefined }), { cwd });
      assert.ok(compilation.assessment.accepted_concerns.includes(body.concern));
      const budget = new AuditResourceBudget();
      const runtime: AgentRuntime = { runSession: options => {
        const adapted = withPrecheckProofs(options,readReviewPrompt(options.userPrompt),Value);
        if(!readReviewPrompt(options.userPrompt).source_precheck)assert.equal(adapted.options,options,"the full review configuration must remain identical");
        return new PiSdkRuntime().runSession({...adapted.options,configDir:cwd});
      } };
      const result = await reviewSpecialistCompilation({ cwd, runtime, ui: { status() {} },
        config: { schemaVersion: 1, thinkingLevel: "high", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } },
      } as never, compilation, budget, "native-source-local");
      assert.equal(sawClausePlan,true,"compound prose must be assigned separate immutable clause IDs");
      assert.deepEqual(requests.map(request => request.precheck), outcome === "complete" ? [true,false] : [true]);
      assert.ok(requests.every(request => request.cap === 12000));
      assert.ok(requests.every(request => JSON.stringify(request.thinking) === JSON.stringify({ type: "adaptive" })));
      assert.equal(budget.snapshot().model_calls,requests.length);
      assert.equal(budget.snapshot().unreported_calls,0);
      const record = result.map.specialist_reviews!.records[0]!;
      assert.equal(record.failure === null,outcome === "complete");
      if (["contradiction","duplicate-parent"].includes(outcome)) {
        assert.equal(record.retryable,false);
        assert.equal(record.finding?.claim,"pitfalls[0]","a local clause finding must bind the original stable claim");
        assert.equal(record.additional_findings?.length ?? 0,0,"one original claim must not be pruned twice");
      } else if(outcome !== "complete") assert.equal(record.retryable,true);
      assert.equal(execFileSync("git", ["-C", cwd, "show", "HEAD:small.py"], { encoding: "utf8" }), small);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
