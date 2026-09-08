import { readReviewPrompt } from "../fixtures/review-prompt.ts";
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
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

for (const outcome of ["supported", "local-contradiction", "incomplete-full-review", "incomplete-observations",
  "forged-observation", "claim-verdict-as-observation", "empty-observations", "false-notes",
  "cancelled-after-observations", "changed-head", "capacity-refused", "reversed-lines", "fractional-lines", "unknown-path"] as const) {
  test(`native MiniMax source observations preserve final review authority: ${outcome}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-native-source-check-"));
    const controller = new AbortController();
    const small = "def present(record):\n    return record is not None\n";
    const large = "def relay(record):\n    return record\n" + "# Broader immutable source context.\n".repeat(400);
    const requests: Array<{ precheck: boolean; cap: number | undefined; thinking: unknown }> = [];
    const serverErrors: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        max_tokens?: number; thinking?: unknown; tool_choice?: unknown;
        messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      };
      const content = payload.messages.find(message => message.role === "user")!.content;
      const text = typeof content === "string" ? content : content.map(part => part.text ?? "").join("\n");
      const data = readReviewPrompt(text) as { source_observation?: boolean; claims?: Record<string, unknown>;
        evidence: Record<string, string>;
        untrusted_source_observations?: Array<{ behavior: string; excerpt: string }> };
      const precheck = data.source_observation === true;
      requests.push({ precheck, cap: payload.max_tokens, thinking: payload.thinking });
      assert.deepEqual(payload.tool_choice, { type: "auto" });
      if (precheck) {
        assert.equal(data.claims, undefined, "source reading must not be anchored to a proposed assertion");
        assert.deepEqual(Object.keys(data.evidence), ["small.py"]);
        assert.deepEqual(data.evidence["small.py"], small.split("\n").map((text, index) => `${index + 1}|${text}`).join("\n"));
      }
      else {
        assert.equal(data.evidence["small.py"], small);
        assert.equal(data.evidence["large.py"], large);
        assert.ok(Object.keys(data.claims!).length > 24);
        assert.ok(Array.isArray(data.untrusted_source_observations));
        if (outcome === "false-notes") assert.equal(data.untrusted_source_observations[0]!.behavior, "A None input returns True.");
        if (outcome !== "empty-observations") assert.equal(data.untrusted_source_observations[0]!.excerpt, "    return record is not None");
      }
      const finding = outcome === "local-contradiction" && !precheck ? {
        claim: "pitfalls[0]", path: "small.py", excerpt: "return record is not None",
        reason: "A None record makes this predicate False, not True.",
      } : undefined;
      const report = precheck && outcome !== "claim-verdict-as-observation"
        ? { observations: outcome === "empty-observations" ? [] : [{ path: outcome === "unknown-path" ? "outside.py" : "small.py",
          start_line: outcome === "reversed-lines" ? 3 : outcome === "fractional-lines" ? 1.5 : 2,
          end_line: outcome === "forged-observation" ? 99 : 2,
          behavior: outcome === "false-notes" ? "A None input returns True." : "A None input returns False." }] }
        : { verdict: finding ? "unsupported" : "supported", checked_claims: Object.keys(data.claims ?? {}),
          ...(finding ? { finding } : {}) };
      const useTool = !(outcome === "incomplete-full-review" && !precheck)
        && !(outcome === "incomplete-observations" && precheck);
      const index = requests.length;
      const events = [
        ["message_start", { type: "message_start", message: { id: `fixture-${index}`, type: "message", role: "assistant",
          model: "MiniMax-M3", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: useTool
          ? { type: "tool_use", id: `check-${index}`, name: precheck ? "submit_source_observations" : "submit_specialist_review", input: {} } : { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: useTool
          ? { type: "input_json_delta", partial_json: JSON.stringify(report) }
          : { type: "text_delta", text: "A prose summary is not a complete review." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 40 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(""));
      } catch (error) {
        serverErrors.push(error);
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fixture request assertion failed" } }));
      }
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
        pitfalls: [{ risk: outcome === "local-contradiction" ? "None is reported present." : "None is not reported present.",
          consequence: "Presence is separate from relay.", reference: "small.py" }],
        entry_questions: ["Does this affect presence?"], validation: [], spans_subtrees: [],
        stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-08-31T00:00:00.000Z",
      };
      const compilation = compileSpecialistEvidence(makeValidCodebaseMap({ concern_evidence: { concerns: [body], not_concerns: [] },
        expert_evidence: undefined }), { cwd });
      assert.ok(compilation.assessment.accepted_concerns.includes(body.concern));
      const budget = new AuditResourceBudget(outcome === "capacity-refused" ? { maxOutputTokens: 12_020 } : {});
      const runtime: AgentRuntime = { async runSession(options) {
        const result = await new PiSdkRuntime().runSession({ ...options, configDir: cwd });
        if (options.tools.includes("submit_source_observations")) {
          if (outcome === "cancelled-after-observations") controller.abort();
          if (outcome === "changed-head") execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "changed source identity"]);
        }
        return result;
      } };
      const config = { schemaVersion: 1, thinkingLevel: "high", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } };
      const originalConfig = JSON.stringify(config);
      const result = await reviewSpecialistCompilation({ cwd, runtime, signal: controller.signal, ui: { status() {} }, config,
      } as never, compilation, budget, "native-source-local");
      assert.deepEqual(serverErrors, [], "native request must satisfy the source-observation contract");
      assert.equal(JSON.stringify(config), originalConfig, "source reading cannot mutate the configured full-review behavior");
      const observationFailed = ["incomplete-observations", "forged-observation", "claim-verdict-as-observation",
        "cancelled-after-observations", "changed-head", "capacity-refused", "reversed-lines", "fractional-lines", "unknown-path"].includes(outcome);
      assert.deepEqual(requests.map(request => request.precheck), observationFailed ? [true] : [true, false]);
      assert.deepEqual(requests.map(request => request.cap), observationFailed ? [12000] : [12000, 12000]);
      assert.ok(requests.every(request => JSON.stringify(request.thinking) === JSON.stringify({ type: "adaptive" })),
        "source reading and complete review retain the configured thinking policy");
      assert.equal(budget.snapshot().model_calls, requests.length);
      assert.equal(budget.snapshot().unreported_calls, 0);
      const record = result.map.specialist_reviews!.records[0]!;
      assert.equal(record.failure === null, ["supported", "empty-observations", "false-notes"].includes(outcome));
      if (outcome === "local-contradiction") assert.equal(record.finding?.claim, "pitfalls[0]");
      if (outcome === "incomplete-full-review") assert.equal(record.retryable, true);
      if (observationFailed) assert.equal(record.retryable, true);
      assert.ok(!Object.hasOwn(record, "observations"), "reading notes cannot become durable review attestation");
      assert.equal(execFileSync("git", ["-C", cwd, "show", "HEAD:small.py"], { encoding: "utf8" }), small);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
