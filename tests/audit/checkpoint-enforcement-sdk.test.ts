import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { createReadOnlyExecutionPolicy } from "../../src/core/security/execution-policy.ts";

function responseFor(response: ServerResponse, index: number): void {
  const write = index === 6 || index === 8;
  const tool = index < 10;
  const events = [
    { type: "message_start", message: { id: `message_${index}`, type: "message", role: "assistant",
      model: "MiniMax-M3", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: `tool_${index}`, name: write ? "write_map_delta" : "read", input: {} }
      : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(write ? {} : { path: index <= 4 ? "fixture.txt" : "late.txt" }) }
      : { type: "text_delta", text: "fixture complete" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

for (const terminalProtocol of [false, true]) {
  test(`actual MiniMax SDK rejects unoffered inspections until a validated checkpoint: terminal protocol ${terminalProtocol}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-checkpoint-enforcement-"));
    const payloads: Array<{ tools: Array<{ name: string }>; tool_choice: unknown }> = [];
    const observed: Array<{ toolName: string; toolCallId: string; isError: boolean; result: { content: unknown } }> = [];
    let writes = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof payloads[number]);
      // The fixture deliberately returns read calls absent from the advertised
      // tools, reproducing why provider filtering alone is not enforcement.
      responseFor(response, payloads.length);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      fs.writeFileSync(path.join(cwd, "fixture.txt"), "Observed source.\n");
      fs.writeFileSync(path.join(cwd, "late.txt"), "LATE_SOURCE_MUST_WAIT_FOR_CHECKPOINT\n");
      fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
        minimax: { baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages",
          apiKey: "local-test-placeholder", models: [{ id: "MiniMax-M3", contextWindow: 32768, maxTokens: 128 }] },
      } }));
      const result = await new PiSdkRuntime().runSession({
        cwd, configDir: cwd,
        config: { schemaVersion: 1, thinkingLevel: "off", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } },
        systemPrompt: "Local deterministic checkpoint fixture.", userPrompt: "Inspect source and checkpoint.",
        tools: ["read", "write_map_delta", "spawn_explorer"],
        customTools: [{ name: "write_map_delta", label: "Checkpoint", description: "Fixture checkpoint.", parameters: Type.Object({}),
          async execute() {
            writes += 1;
            return writes === 1
              ? { content: [{ type: "text" as const, text: "Invalid map; no checkpoint saved." }], isError: true, details: {} }
              : { content: [{ type: "text" as const, text: "Validated checkpoint saved." }], details: { path: "map.json" } };
          } },
        { name: "spawn_explorer", label: "Explorer", description: "Unused fixture explorer.", parameters: Type.Object({}),
          async execute() { throw new Error("fixture must not invoke an explorer"); } }],
        auditResourceBudget: new AuditResourceBudget(), timeoutMs: 10_000,
        onEvent(event) {
          if (event.type === "tool_execution_end") observed.push(event);
        },
        executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: ["read"] }),
        ...(terminalProtocol ? {
          forceRequiredToolChoiceAfterTurns: 100,
          recoveryPromptIfToolNotCalled: { requiredToolName: "write_map_delta", userPrompt: "Submit.", maxAttempts: 0 },
        } : {}),
      });
      assert.equal(result.aborted, false);
      assert.equal(payloads.length, 10);
      assert.equal(writes, 2);
      for (const index of [5, 7]) {
        const event = observed.find(event => event.toolCallId === `tool_${index}`);
        assert.ok(event);
        if (!terminalProtocol) assert.deepEqual(payloads[index - 1].tools.map(tool => tool.name), ["write_map_delta"]);
        assert.equal(event.isError, !terminalProtocol,
          "provider-emitted inspections cannot bypass a pending checkpoint or failed write");
        assert.equal(JSON.stringify(event.result.content).includes("LATE_SOURCE_MUST_WAIT_FOR_CHECKPOINT"), terminalProtocol);
      }
      const restored = observed.find(event => event.toolCallId === "tool_9");
      assert.ok(restored);
      assert.equal(restored.isError, false);
      assert.ok(JSON.stringify(restored.result.content).includes("LATE_SOURCE_MUST_WAIT_FOR_CHECKPOINT"));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
