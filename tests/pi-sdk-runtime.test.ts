import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { capProviderOutputTokens, forceProviderToolChoice, PiSdkRuntime } from "../src/core/pi-sdk-runtime.ts";
import { createReadOnlyExecutionPolicy } from "../src/core/security/execution-policy.ts";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentifyModelRuntime } from "../src/core/pi-credential-store.ts";
import { createSpawnExplorerTool } from "../src/core/audit/spawn-explorer-tool.ts";
import { AuditResourceBudget } from "../src/core/audit/resource-budget.ts";

test("SDK admission rejection prevents HTTP dispatch, while admitted requests still dispatch", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-sdk-admission-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
        apiKey: "local-test-placeholder", models: [{ id: "admission-fixture", contextWindow: 32768, maxTokens: 128 }] },
    } }));
    const runtime = new PiSdkRuntime();
    for (const reject of [true, false]) {
      const before = requests;
      let admissions = 0;
      const result = await runtime.runSession({
        cwd, configDir: cwd,
        config: { schemaVersion: 1, thinkingLevel: "off", models: { primary: { provider: "openai", model: "admission-fixture" } } },
        systemPrompt: "Local transport test.", userPrompt: "ok", tools: [], timeoutMs: 5000,
        executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
        onProviderRequest: () => { admissions += 1; if (reject) throw new Error("admission denied"); },
      });
      assert.equal(admissions, 1);
      assert.equal(requests - before, reject ? 0 : 1, "denied SDK hooks must not dispatch their original payload");
      assert.equal(result.diagnostics?.provider_requests, reject ? 0 : 1);
    }
    const { modelRuntime } = await createAgentifyModelRuntime({
      authFile: path.join(cwd, "auth.json"), modelsFile: path.join(cwd, "models.json"),
    });
    const model = modelRuntime.getModel("openai", "admission-fixture");
    assert.ok(model);
    const budget = new AuditResourceBudget({ maxModelCalls: 3 });
    const before = requests;
    let explorerCreated = false;
    const explorer = createSpawnExplorerTool({
      agentDir: cwd, stateDir: ".audit", explorerModel: model, resourceBudget: budget,
      createSession: async (options) => {
        const created = await createAgentSession({ ...options, modelRuntime });
        explorerCreated = true;
        // Another session consumes the remaining slots after explorer preflight.
        const competing = budget.beginSession();
        created.session.subscribe((event) => {
          if (event.type === "agent_start") {
            for (let call = 0; call < 3; call += 1) budget.recordProviderRequest(competing);
          }
        });
        return created;
      },
    });
    const denied = await explorer.execute("sdk-admission", { mode: "topography", target_path: "." } as never,
      undefined, undefined, { cwd } as never);
    assert.equal((denied as { isError?: boolean }).isError, true);
    assert.equal(explorerCreated, true, JSON.stringify(denied));
    assert.equal(requests, before, "explorer rejection must abort the actual SDK transport");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("required tool choice uses the Anthropic wire contract", () => {
  const payload = forceProviderToolChoice({ model: "fixture", tools: [{ name: "submit" }] }, "anthropic-messages", "submit");
  assert.deepEqual(payload, {
    model: "fixture",
    tools: [{ name: "submit" }],
    tool_choice: { type: "tool", name: "submit", disable_parallel_tool_use: true },
  });
  assert.deepEqual(
    forceProviderToolChoice({
      thinking: { type: "enabled", budget_tokens: 1_024 },
      output_config: { effort: "low" },
      tools: [{ name: "submit" }],
    }, "anthropic-messages", "submit"),
    {
      thinking: { type: "disabled" },
      tools: [{ name: "submit" }],
      tool_choice: { type: "tool", name: "submit", disable_parallel_tool_use: true },
    },
  );
});

test("required tool choice uses the OpenAI chat and responses wire contracts", () => {
  assert.deepEqual(
    forceProviderToolChoice({ tools: [] }, "openai-completions", "submit"),
    {
      tools: [],
      tool_choice: { type: "function", function: { name: "submit" } },
      parallel_tool_calls: false,
    },
  );
  assert.deepEqual(
    forceProviderToolChoice({ tools: [] }, "openai-responses", "submit"),
    {
      tools: [],
      tool_choice: { type: "function", name: "submit" },
      parallel_tool_calls: false,
    },
  );
  // The Codex backend accepts this shape (verified live): the named tool must
  // be present in the session allowlist or the backend rejects the choice.
  assert.deepEqual(
    forceProviderToolChoice({ tools: [] }, "openai-codex-responses", "submit"),
    {
      tools: [],
      tool_choice: { type: "function", name: "submit" },
      parallel_tool_calls: false,
    },
  );
});

test("required tool choice preserves unknown provider payloads", () => {
  const payload = { provider_owned: true };
  assert.equal(forceProviderToolChoice(payload, "future-api", "submit"), payload);
});

test("provider output caps narrow Anthropic and preserve smaller limits", () => {
  assert.deepEqual(
    capProviderOutputTokens({ max_tokens: 131_072, tools: [] }, "anthropic-messages", 4_096),
    { max_tokens: 4_096, tools: [] },
  );
  assert.deepEqual(
    capProviderOutputTokens({ max_tokens: 2_048 }, "anthropic-messages", 4_096),
    { max_tokens: 2_048 },
  );
});

test("provider output caps use nested Google and Bedrock wire contracts", () => {
  assert.deepEqual(
    capProviderOutputTokens({ config: { temperature: 0 } }, "google-generative-ai", 4_096),
    { config: { temperature: 0, maxOutputTokens: 4_096 } },
  );
  assert.deepEqual(
    capProviderOutputTokens({ inferenceConfig: { temperature: 0 } }, "bedrock-converse-stream", 4_096),
    { inferenceConfig: { temperature: 0, maxTokens: 4_096 } },
  );
});

test("provider output caps narrow OpenAI responses but never touch the Codex payload", () => {
  assert.deepEqual(
    capProviderOutputTokens({ max_output_tokens: 131_072, tools: [] }, "openai-responses", 4_096),
    { max_output_tokens: 4_096, tools: [] },
  );
  // The ChatGPT Codex backend rejects max_output_tokens outright ("Codex
  // error: Unsupported parameter: max_output_tokens"); injecting it fails
  // every request, so the payload must pass through untouched.
  const codexPayload = { model: "gpt-5.6-luna", tools: [], tool_choice: "auto" };
  assert.equal(capProviderOutputTokens(codexPayload, "openai-codex-responses", 4_096), codexPayload);
});
