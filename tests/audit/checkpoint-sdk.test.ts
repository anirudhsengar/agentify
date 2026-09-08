import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WriteMapDeltaParamsSchema } from "../../src/core/audit/schema/write-map-params.ts";
import { createWriteMapTools } from "../../src/core/audit/write-map-tools.ts";
import { createGapDraftMap } from "../../src/core/audit/map-draft.ts";
import { writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { createReadOnlyExecutionPolicy } from "../../src/core/security/execution-policy.ts";

test("incremental coverage transport exposes canonical field shapes without requiring unrelated evidence", () => {
  for (const delta of [
    { skeleton: { entry_points: [{ path: "src/index.ts", role: "entry", language: "TypeScript", run_command: "" }] } },
    { module_graph: { shared_abstractions: ["src/shared.ts"] } },
    { conventions: { naming: { files: "snake_case.py", functions: "snake_case" }, logging: { pattern: "warnings.warn" } } },
    { pitfalls: [{ module: "src/index.ts", what: "Throws for an invalid input", consequence: "The request is rejected", line_ref: 1 }] },
    { concern_evidence: { concerns: [], not_concerns: [] } },
    { open_questions: ["Unobserved validation remains a gap"] },
  ]) assert.equal(Value.Check(WriteMapDeltaParamsSchema, { delta }), true, JSON.stringify(delta));
  for (const delta of [
    { skeleton: { entry_points: { path: "src/index.ts" } } },
    { skeleton: { entry_points: [{ path: "src/index.ts", role: "entry" }] } },
    { module_graph: { shared_abstractions: { path: "src/shared.ts" } } },
    { conventions: { naming: { files: { pattern: "snake_case.py" } } } },
    { pitfalls: { module: "src/index.ts", what: "A failure", consequence: "Rejected", line_ref: 1 } },
    { pitfalls: [{ module: "src/index.ts", what: "A failure" }] },
  ]) assert.equal(Value.Check(WriteMapDeltaParamsSchema, { delta }), false, JSON.stringify(delta));
  assert.equal(Value.Check(WriteMapDeltaParamsSchema, { delta: "{\"open_questions\":[]}" }), true,
    "the existing serialized transport still reaches canonical parsing and validation");
});

test("actual SDK rejects malformed coverage fields before persistence and accepts the corrected array", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-coverage-shape-sdk-"));
  const payloads: Array<Record<string, unknown>> = [];
  const executions: unknown[] = [];
  const outcomes: boolean[] = [];
  const mapTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  writeCanonicalMap(cwd, createGapDraftMap(), { stateDir: ".agentify/runtime/audit", mapFilename: "codebase_map.json" });
  const originalMap = fs.readFileSync(mapTools.canonicalMapPath(cwd), "utf8");
  const pitfall = { module: "fixture.ts", what: "Input validation throws", consequence: "Invalid input is rejected", line_ref: 1 };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    const index = payloads.length;
    if (index === 2 || index === 3) assert.equal(fs.readFileSync(mapTools.canonicalMapPath(cwd), "utf8"), originalMap,
      "a rejected coverage shape must not modify the map or its exploration trail");
    const proposal = { pitfalls: index < 3 ? pitfall : [pitfall] };
    const delta = index < 4 ? { role: "assistant", tool_calls: [{ index: 0, id: `shape_${index}`, type: "function",
      function: { name: "write_map_delta", arguments: JSON.stringify({ delta: index === 2 ? JSON.stringify(proposal) : proposal }) },
    }] } : { role: "assistant", content: "done" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `shape_${index}`, choices: [{ index: 0, delta,
      finish_reason: index < 4 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-placeholder",
        models: [{ id: "shape-fixture", contextWindow: 32768, maxTokens: 128 }] },
    } }));
    const result = await new PiSdkRuntime().runSession({
      cwd, configDir: cwd, config: { schemaVersion: 1, thinkingLevel: "off",
        models: { primary: { provider: "openai", model: "shape-fixture" } } },
      systemPrompt: "Local deterministic transport fixture.", userPrompt: "Record observed evidence.",
      tools: ["write_map_delta"], timeoutMs: 10_000,
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, tools: [] }),
      customTools: [{ ...mapTools.writeMapDeltaTool,
        async execute(...args) {
          const result = await mapTools.writeMapDeltaTool.execute(...args);
          if (!(result as { isError?: boolean }).isError) executions.push((args[1] as { delta: unknown }).delta);
          return result;
        } }],
      onEvent(event) {
        if (event.type === "tool_execution_end" && event.toolName === "write_map_delta") outcomes.push(event.isError);
      },
    });
    assert.equal(result.aborted, false);
    assert.equal(payloads.length, 4);
    assert.deepEqual(outcomes, [true, true, false], "serialized transport cannot bypass the same owned validation");
    assert.deepEqual(executions, [{ pitfalls: [pitfall] }],
      "the malformed object must not reach persistence or be reported as an accepted checkpoint");
    assert.match(JSON.stringify(payloads[0]?.tools), /pitfalls.*array/);
    assert.ok(JSON.stringify(payloads[1]?.messages).includes("pitfalls"), "the rejected field must be named for repair");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("actual SDK checkpoints recur, survive tool errors, then restore inspection tools", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-checkpoint-sdk-"));
  const payloads: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    const index = payloads.length;
    const write = index === 5 || index === 6 || index === 11;
    const delta = index < 12 ? { role: "assistant", tool_calls: [{
      index: 0, id: `call_${index}`, type: "function", function: {
        name: write ? "write_map_delta" : "read",
        arguments: JSON.stringify(write ? {} : { path: path.join(cwd, "fixture.txt") }),
      },
    }] } : { role: "assistant", content: "fixture complete" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `response_${index}`, choices: [{
      index: 0, delta, finish_reason: index < 12 ? "tool_calls" : "stop",
    }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "fixture.txt"), "Observed fixture evidence.\n");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
        apiKey: "local-test-placeholder", models: [{ id: "checkpoint-fixture", contextWindow: 32768, maxTokens: 128 }] },
    } }));
    for (const structuredFailure of [false, true]) for (const terminalProtocol of [false, true]) {
      payloads.length = 0;
      let writes = 0;
      const observed: Array<{ tool: unknown; isError: unknown; details: unknown }> = [];
      const customTools = [{ name: "write_map_delta", label: "Checkpoint", description: "Fixture checkpoint.", parameters: Type.Object({}),
        async execute() {
          writes += 1;
          if (writes === 1) {
            if (!structuredFailure) throw new Error("Fixture schema rejection: no state was saved.");
            return { content: [{ type: "text" as const, text: "Fixture schema rejection: no state was saved." }],
              isError: true, details: { recorded: false, reason: "schema" } };
          }
          return { content: [{ type: "text" as const, text: "checkpoint recorded" }], details: { path: "map.json" } };
        } },
      { name: "spawn_explorer", label: "Explorer", description: "Unused fixture explorer.", parameters: Type.Object({}),
        async execute() { throw new Error("fixture must not invoke an explorer"); } }];
      const before = customTools[0].description;
      const result = await new PiSdkRuntime().runSession({
        cwd, configDir: cwd,
        config: { schemaVersion: 1, thinkingLevel: "off", models: { primary: { provider: "openai", model: "checkpoint-fixture" } } },
        systemPrompt: "Local deterministic SDK test.", userPrompt: "Inspect fixture evidence.",
        tools: ["read", "write_map_delta", "spawn_explorer"], customTools,
        auditResourceBudget: new AuditResourceBudget(), timeoutMs: 10_000,
        onEvent(event) {
          const value = event as { type?: unknown; toolName?: unknown; isError?: unknown; result?: { details?: unknown } };
          if (value.type === "tool_execution_end") observed.push({
            tool: value.toolName, isError: value.isError, details: value.result?.details,
          });
        },
        executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: ["read"] }),
        ...(terminalProtocol ? {
          forceRequiredToolChoiceAfterTurns: 100,
          recoveryPromptIfToolNotCalled: { requiredToolName: "write_map_delta", userPrompt: "Submit.", maxAttempts: 0 },
        } : {}),
      });
      assert.equal(result.aborted, false);
      assert.equal(payloads.length, 12, JSON.stringify(result.diagnostics));
      assert.equal(writes, 3);
      const rejected = observed.find(event => event.tool === "write_map_delta");
      assert.equal(rejected?.isError, true, "returned validator errors must not satisfy the required checkpoint");
      if (structuredFailure) assert.deepEqual(rejected?.details, { recorded: false, reason: "schema" },
        "error classification must preserve application-owned rejection details");
      assert.equal(observed.filter((event) => event.tool === "read").length, 8);
      assert.ok(observed.filter((event) => event.tool === "read").every((event) => event.isError === false),
        `fixture inspections must succeed: ${JSON.stringify(observed)}`);
      assert.equal(customTools[0].description, before, "runtime must not mutate caller-owned tools");
      for (const [index, payload] of payloads.entries()) {
        const checkpointDue = !terminalProtocol && [4, 5, 10].includes(index);
        if (checkpointDue) assert.deepEqual(payload.tool_choice, { type: "function", function: { name: "write_map_delta" } }, JSON.stringify({ request: index + 1, observed, diagnostics: result.diagnostics }));
        else assert.notDeepEqual(payload.tool_choice, { type: "function", function: { name: "write_map_delta" } });
      }
      assert.equal(result.diagnostics?.forced_tool_choice_requests, terminalProtocol ? 0 : 3);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
