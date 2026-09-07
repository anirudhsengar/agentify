import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentifyModelRuntime } from "../../src/core/pi-credential-store.ts";
import { createSpawnExplorerTool } from "../../src/core/audit/spawn-explorer-tool.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { ExplorerReceiptTracker } from "../../src/core/audit/explorer-receipts.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { getThinkingLevel, setThinkingLevel } from "../../src/core/audit/state.ts";

const CONCERN = "Request validation";
const ENTRY = 'import { validate } from "./validate.ts";\nexport function request(value: unknown) { return validate(value); }\n';
const SOURCE = 'export function validate(value: unknown) { return typeof value === "string"; }\n';
const BODY = {
  concern: CONCERN, one_line: "Checks whether a request value is a string.",
  covers: "Request entry and string validation.", excludes: "Rendering and persistence.",
  flows: [{ name: "validate request", description: "The entry delegates the value to validation.", steps: [
    { path: "src/entry.ts", what_happens: "Delegates the input value to validate." },
    { path: "src/validate.ts", what_happens: "Returns whether the value has string type." },
  ] }],
  touchpoints: [
    { path: "src/entry.ts", symbol: "request", role: "Delegates request validation.", line_range: null, centrality: "supporting" },
    { path: "src/validate.ts", symbol: "validate", role: "Checks the input type.", line_range: null, centrality: "core" },
  ],
  invariants: [{ rule: "Only string values return true.", why: "The result is a typeof comparison.", reference: "src/validate.ts" }],
  pitfalls: [{ risk: "Passing a non-string value returns false.", consequence: "The request is not accepted by this predicate.", reference: "src/validate.ts" }],
  entry_questions: ["Does this change alter accepted input types?"], validation: [],
  stability: "high", recurrence: "high", confidence: "high",
};

type Call = { name: string; input: Record<string, unknown> };
type Payload = { tools: Array<{ name: string }>; messages: unknown[]; system: unknown; tool_choice?: unknown;
  max_tokens?: number; thinking?: unknown };
function respond(response: ServerResponse, index: number, call?: Call): void {
  const events = [
    { type: "message_start", message: { id: `message_${index}`, type: "message", role: "assistant",
      model: "MiniMax-M3", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: call
      ? { type: "tool_use", id: `tool_${index}`, name: call.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call
      ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

async function trace(next: (index: number) => Call | undefined, focus?: string, signal?: AbortSignal, reasoning = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-tracer-terminal-"));
  const previousThinking = getThinkingLevel();
  const payloads: Payload[] = [];
  const tools: Array<{ toolCallId: string; toolName: string; isError: boolean; result: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Payload);
    respond(response, payloads.length, next(payloads.length));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    if (reasoning) setThinkingLevel("high");
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src/entry.ts"), ENTRY);
    fs.writeFileSync(path.join(cwd, "src/validate.ts"), SOURCE);
    fs.writeFileSync(path.join(cwd, "src/late.ts"), "LATE_SOURCE_MUST_NOT_BE_OBSERVED\n");
    for (const args of [["init", "-q"], ["config", "user.name", "Agentify Test"],
      ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "tracer fixture"]]) {
      execFileSync("git", args, { cwd, stdio: "pipe" });
    }
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      minimax: { baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages", apiKey: "fixture-placeholder",
        models: [{ id: "MiniMax-M3", contextWindow: 131072, maxTokens: reasoning ? 128000 : 12000, reasoning,
          cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 } }] },
    } }));
    const { modelRuntime } = await createAgentifyModelRuntime({ authFile: path.join(cwd, "auth.json"), modelsFile: path.join(cwd, "models.json") });
    const model = modelRuntime.getModel("minimax", "MiniMax-M3");
    assert.ok(model);
    const budget = new AuditResourceBudget();
    const explorer = createSpawnExplorerTool({ agentDir: cwd, stateDir: ".agentify/runtime/audit", explorerModel: model,
      resourceBudget: budget, maxSubagentDurationMs: 10_000,
      createSession: async options => {
        const created = await createAgentSession({ ...options, modelRuntime });
        created.session.subscribe(event => { if (event.type === "tool_execution_end") tools.push(event); });
        return created;
      },
    });
    const result = await explorer.execute("trace", { mode: "concern_tracer", target_path: "src", concern: CONCERN,
      ...(focus !== undefined ? { focus } : {}),
    } as never, signal, undefined, { cwd } as never);
    const tracker = new ExplorerReceiptTracker();
    tracker.observe({ type: "tool_execution_end", toolName: "spawn_explorer", result });
    const assessment = tracker.assess(makeValidCodebaseMap({ expert_evidence: undefined }));
    return { result, payloads, tools, usage: budget.snapshot(), assessment };
  } finally {
    setThinkingLevel(previousThinking);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
const read = (file: string): Call => ({ name: "read", input: { path: file } });
const submit = (body: unknown): Call => ({ name: "submit_concern_report", input: { report_json: JSON.stringify(body) } });

test("actual tracer SDK fits high thinking inside every bounded source and submission request", async () => {
  const outcome = await trace(index => index === 1 ? read("src/entry.ts")
    : index === 2 ? read("src/validate.ts") : submit(BODY), undefined, undefined, true);
  assert.notEqual((outcome.result as { isError?: boolean }).isError, true, JSON.stringify(outcome.result));
  assert.equal(outcome.payloads.length, 3);
  for (const payload of outcome.payloads) {
    assert.equal(payload.max_tokens, 12_000);
    assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 10_976, display: "summarized" });
  }
  assert.equal(outcome.usage.model_calls, 3);
  assert.equal(outcome.usage.unreported_calls, 0);
  assert.deepEqual((outcome.result.details as { observed_paths: string[] }).observed_paths, ["src/entry.ts", "src/validate.ts"]);
});

for (const focus of [undefined, "  ", "src/entry.ts and src/validate.ts"]) {
  test(`actual tracer SDK receives required identity with optional focus ${JSON.stringify(focus)}`, async () => {
    const outcome = await trace(index => index === 1 ? read("src/entry.ts") : index === 2 ? read("src/validate.ts") : submit(BODY), focus);
    assert.notEqual((outcome.result as { isError?: boolean }).isError, true, JSON.stringify(outcome.result));
    const messages = JSON.stringify(outcome.payloads[0].messages);
    assert.ok(messages.includes(`src ${focus?.trim() || CONCERN}\\n`), "the positional task focus must default to the required concern identity");
    assert.doesNotMatch(JSON.stringify(outcome.payloads[0].system), /If `FOCUS` is empty, stop without submitting/);
    assert.equal(outcome.payloads.length, 3);
    assert.equal(outcome.usage.model_calls, 3);
    assert.equal(outcome.usage.unreported_calls, 0);
  });
}

test("actual tracer SDK blocks unoffered reads in the reserved final turns after rejected submissions", async () => {
  const outcome = await trace(index => index === 1 ? read("src/entry.ts") : index === 2 ? read("src/validate.ts")
    : index <= 6 ? submit({}) : index === 7 ? read("src/late.ts") : submit(BODY));
  assert.notEqual((outcome.result as { isError?: boolean }).isError, true, JSON.stringify(outcome.result));
  assert.equal(outcome.payloads.length, 8);
  for (const payload of outcome.payloads.slice(6)) {
    assert.deepEqual(payload.tools.map(tool => tool.name).sort(), ["submit_concern_rejection", "submit_concern_report"]);
    assert.deepEqual(payload.tool_choice, { type: "auto" });
  }
  const late = outcome.tools.find(event => event.toolCallId === "tool_7");
  assert.ok(late);
  assert.equal(late.isError, true, "advertised-tool filtering is not sufficient execution enforcement");
  assert.ok(!JSON.stringify(late.result).includes("LATE_SOURCE_MUST_NOT_BE_OBSERVED"));
  assert.ok(!JSON.stringify(outcome.payloads[7].messages).includes("LATE_SOURCE_MUST_NOT_BE_OBSERVED"));
  assert.equal((outcome.result.details as { reads: number }).reads, 2);
  assert.equal(outcome.usage.model_calls, 8);
  assert.equal(outcome.usage.unreported_calls, 0);
});

test("actual tracer SDK retains the last rejected submission without granting successful receipt credit", async () => {
  const outcome = await trace(index => index <= 2 ? read(index === 1 ? "src/entry.ts" : "src/validate.ts") : submit({}));
  assert.equal((outcome.result as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(outcome.result.content), /last submission rejected:.*schema validation/);
  assert.equal(outcome.payloads.length, 8);
  assert.equal(outcome.usage.model_calls, 8);
  assert.equal(outcome.usage.unreserved_calls, 0);
  assert.ok(outcome.assessment.reasons.some(reason => reason.includes("failed")), "failed tracer must stay unresolved");
});

test("pre-cancelled tracer does not dispatch or earn a receipt", async () => {
  const outcome = await trace(() => submit(BODY), undefined, AbortSignal.abort());
  assert.equal((outcome.result as { isError?: boolean }).isError, true);
  assert.equal(outcome.payloads.length, 0);
  assert.equal(outcome.usage.model_calls, 0);
});

test("submission diagnostics are bounded and redacted without reclassifying the actual failure", async () => {
  const marker = "sk-12345678901234567890";
  const outcome = await trace(() => submit({ blocker_reason: `timeout ${marker} ${"detail ".repeat(1000)}` }));
  assert.equal((outcome.result as { isError?: boolean }).isError, true);
  const details = outcome.result.details as { failure_kind: string; error_message: string };
  assert.equal(details.failure_kind, "error", "model-authored diagnostic text cannot turn call exhaustion into a clock timeout");
  assert.ok(details.error_message.length < 2300);
  assert.ok(!details.error_message.includes(marker));
  assert.match(details.error_message, /last submission rejected:.*\[REDACTED\].*\[TRUNCATED\]/);
  assert.equal(outcome.payloads.length, 8);
});
