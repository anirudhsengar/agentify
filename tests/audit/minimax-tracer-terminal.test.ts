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
import { forceProviderToolChoice } from "../../src/core/pi-sdk-runtime.ts";

const TERMINALS = ["submit_concern_report", "submit_concern_rejection"] as const;

function toolResponse(response: ServerResponse, index: number, name: string, input: unknown): void {
  const events = [
    { type: "message_start", message: { id: `message_${index}`, type: "message", role: "assistant",
      model: "MiniMax-M3", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool_${index}`, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

for (const provider of ["minimax", "minimax-cn"]) {
  test(`${provider} fresh tracers reserve terminal choices before the call cap, including a rejected submission`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-minimax-terminal-"));
    const payloads: Array<{ tools: Array<{ name: string }>; tool_choice: unknown; thinking?: unknown }> = [];
    const source = "export const parseCookie = () => null;\nexport const streamBody = () => null;\n";
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof payloads[number]);
      const index = payloads.length;
      toolResponse(response, index, index === 1 ? "read" : "submit_concern_rejection", index === 1
        ? { path: "src/catalog.ts" }
        : { reason: "Cookie parsing and response streaming have independent entry points and failure invariants; a shared catalog is not one specialty.",
          evidence_path: "src/catalog.ts", excerpt: index === 2 ? "not present in immutable source" : source.split("\n")[0] });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "src/catalog.ts"), source);
      for (const args of [["init", "-q"], ["config", "user.name", "Agentify Test"],
        ["config", "user.email", "agentify@example.invalid"], ["add", "."], ["commit", "-qm", "terminal fixture"]]) {
        execFileSync("git", args, { cwd, stdio: "pipe" });
      }
      const address = server.address();
      assert.ok(address && typeof address === "object");
      fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
        [provider]: { baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages", apiKey: "local-test-placeholder",
          models: [{ id: "MiniMax-M3", contextWindow: 32768, maxTokens: 4096 }] },
      } }));
      const { modelRuntime } = await createAgentifyModelRuntime({
        authFile: path.join(cwd, "auth.json"), modelsFile: path.join(cwd, "models.json"),
      });
      const model = modelRuntime.getModel(provider, "MiniMax-M3");
      assert.ok(model);
      const budget = new AuditResourceBudget();
      const observed: unknown[] = [];
      const tool = createSpawnExplorerTool({ agentDir: cwd, stateDir: ".audit", explorerModel: model,
        resourceBudget: budget, maxSubagentDurationMs: 10_000,
        createSession: async options => {
          const created = await createAgentSession({ ...options, modelRuntime });
          created.session.subscribe(event => { if (event.type === "tool_execution_end") observed.push(event); });
          return { session: created.session };
        },
      });
      const result = await tool.execute("trace", { mode: "concern_tracer", target_path: ".", concern: "Helper catalog",
        max_total_steps: 3 } as never, undefined, undefined, { cwd } as never);
      assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify({ result, observed }));
      assert.equal(payloads.length, 3, "one source read and the existing bounded argument correction, never a fourth call");
      assert.ok(payloads[0].tools.some(tool => tool.name === "read"));
      for (const payload of payloads.slice(1)) {
        assert.deepEqual(payload.tools.map(tool => tool.name), [...TERMINALS], "both honest dispositions must replace further inspection near the call cap");
        assert.deepEqual(payload.tool_choice, { type: "auto" }, "MiniMax must not receive unsupported named or required forcing");
        assert.deepEqual(payload.thinking, payloads[0].thinking);
      }
      const details = result.details as { structured_concern: unknown; structured_rejection: { candidate: string; why_rejected: string };
        observed_paths: string[]; provider_calls: number; max_provider_calls: number };
      assert.equal(details.structured_concern, null, "a rejection cannot manufacture a specialist body");
      assert.equal(details.structured_rejection.candidate, "Helper catalog");
      assert.ok(!details.structured_rejection.why_rejected.includes("not present in immutable source"));
      assert.deepEqual(details.observed_paths, ["src/catalog.ts"]);
      assert.equal(details.provider_calls, 3);
      assert.equal(details.max_provider_calls, 3);
      assert.equal(budget.snapshot().model_calls, 3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("MiniMax alternative terminals preserve reasoning and leave unverified wire contracts unchanged", () => {
  const payload = { thinking: { type: "adaptive" }, max_tokens: 12000, tools: [
    { name: "read" }, { name: TERMINALS[0] }, { name: TERMINALS[1] },
  ] };
  const before = structuredClone(payload);
  assert.deepEqual(forceProviderToolChoice(payload, "anthropic-messages", TERMINALS, "minimax"), {
    ...payload, tools: payload.tools.slice(1), tool_choice: { type: "auto" },
  });
  assert.deepEqual(payload, before, "provider filtering must not mutate caller-owned payloads");
  assert.equal(forceProviderToolChoice(payload, "anthropic-messages", [], "minimax"), payload);
  for (const [api, provider] of [["anthropic-messages", "anthropic"], ["openai-completions", "openai"], ["future-api", "future"]]) {
    assert.equal(forceProviderToolChoice(payload, api, TERMINALS, provider), payload,
      "unsupported alternative-choice contracts retain their existing behavior");
  }
});
