import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { createReadOnlyExecutionPolicy } from "../../src/core/security/execution-policy.ts";

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
