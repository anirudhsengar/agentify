import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { Type } from "typebox";
import { capProviderOutputTokens, forceProviderToolChoice, PiSdkRuntime } from "../src/core/pi-sdk-runtime.ts";
import { createReadOnlyExecutionPolicy } from "../src/core/security/execution-policy.ts";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentifyModelRuntime } from "../src/core/pi-credential-store.ts";
import { createSpawnExplorerTool } from "../src/core/audit/spawn-explorer-tool.ts";
import { AuditBudgetExceededError, AuditResourceBudget } from "../src/core/audit/resource-budget.ts";
import { bindStructuredToolErrors } from "../src/core/structured-tool-errors.ts";

test("structured tool errors retain hook diagnostics and cannot become success", async () => {
  type Agent = Parameters<typeof bindStructuredToolErrors>[0];
  type Context = Parameters<NonNullable<Agent["afterToolCall"]>>[0];
  const content = [{ type: "text" as const, text: "Rejected tracked-source claim." }];
  const details = { recorded: false, expected_concern: "Request validation" };
  for (const failure of ["returned", "thrown", "none"] as const) {
    let seen: Context | undefined;
    const agent: Agent = { afterToolCall: async context => {
      seen = context;
      return { content, details, isError: false };
    } };
    bindStructuredToolErrors(agent);
    const context = { result: { content, details, isError: failure === "returned" },
      isError: failure === "thrown" } as unknown as Context;
    const outcome = await agent.afterToolCall!(context, undefined);
    assert.equal(seen?.isError, failure !== "none");
    assert.deepEqual(outcome, { content, details, isError: failure !== "none" });
    assert.equal(context.isError, failure === "thrown", "the original context must not be mutated");
    assert.deepEqual(context.result.details, details);
  }
  const agent: Agent = { afterToolCall: async () => { throw new Error("existing hook failure"); } };
  bindStructuredToolErrors(agent);
  await assert.rejects(agent.afterToolCall!({ result: { content, details }, isError: false } as unknown as Context,
    undefined), /existing hook failure/);
});

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
        apiKey: "local-test-placeholder", models: [{ id: "admission-fixture", contextWindow: 32768, maxTokens: 128,
          cost: { input: 1, output: 100, cacheRead: 0.1, cacheWrite: 1.25 } }] },
    } }));
    const runtime = new PiSdkRuntime();
    for (const reject of [true, false]) {
      const before = requests;
      let admissions = 0;
      const run = runtime.runSession({
        cwd, configDir: cwd,
        config: { schemaVersion: 1, thinkingLevel: "off", models: { primary: { provider: "openai", model: "admission-fixture" } } },
        systemPrompt: "Local transport test.", userPrompt: "ok", tools: [], timeoutMs: 5000,
        executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
        onProviderRequest: () => { admissions += 1; if (reject) throw new Error("admission denied"); },
      });
      if (reject) await assert.rejects(run, /admission denied/,
        "SDK-swallowed admission errors must reach the caller, not look like a model timeout");
      else assert.equal((await run).diagnostics?.provider_requests, 1);
      assert.equal(admissions, 1);
      assert.equal(requests - before, reject ? 0 : 1, "denied SDK hooks must not dispatch their original payload");
    }
    const costBudget = new AuditResourceBudget({ maxTotalCostUsd: 0.01 });
    const costSession = costBudget.beginSession();
    const beforeCostRejection = requests;
    await assert.rejects(runtime.runSession({
      cwd, configDir: cwd,
      config: { schemaVersion: 1, thinkingLevel: "off", models: { primary: { provider: "openai", model: "admission-fixture" } } },
      systemPrompt: "Local cost admission test.", userPrompt: "ok", tools: [], timeoutMs: 5000,
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
      auditResourceBudget: costBudget,
      onProviderRequest: (reservation) => {
        assert.ok(reservation, "the real SDK must supply model-bound reservations");
        assert.ok(reservation.inputTokens < 32768,
          "a visible exact request must retain its serialized bound, not the full model context");
        costBudget.recordProviderRequest(costSession, reservation);
      },
    }), AuditBudgetExceededError, "preserve typed budget exhaustion across SDK extension dispatch");
    assert.equal(requests, beforeCostRejection, "cost reservation rejection must prevent HTTP dispatch");
    assert.equal(costBudget.snapshot().model_calls, 0);
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
    assert.equal(budget.snapshot().model_calls, 3, "a denied dispatch is not a fourth model call");
    assert.equal((denied.details as { provider_calls: number }).provider_calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("MiniMax compatibility keeps reasoning and avoids unsupported named tool choice on the wire", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-sdk-tool-choice-"));
  const payloads: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    // A deterministic non-retryable response suffices to inspect dispatch.
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "wire fixture complete" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      minimax: { baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages",
        apiKey: "local-test-placeholder", models: [{ id: "MiniMax-M3", reasoning: true, contextWindow: 32768, maxTokens: 4096 }] },
    } }));
    await assert.rejects(new PiSdkRuntime().runSession({
      cwd, configDir: cwd,
      config: { schemaVersion: 1, thinkingLevel: "high", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } },
      systemPrompt: "Local wire test.", userPrompt: "Read the fixture.", tools: ["read", "submit_report"], timeoutMs: 5000,
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: ["read"] }),
      customTools: [{ name: "submit_report", label: "Submit", description: "Submit fixture result.", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "recorded" }], details: {} }; } }],
      forceRequiredToolChoice: true,
      recoveryPromptIfToolNotCalled: { requiredToolName: "submit_report", userPrompt: "Submit.", maxAttempts: 0 },
    }), /provider session failed \(minimax\): 400 .*wire fixture complete/,
    "the intentional HTTP 400 must surface without changing the dispatched wire contract");
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0]!.tool_choice, { type: "auto" });
    assert.deepEqual((payloads[0]!.tools as Array<{ name: string }>).map((tool) => tool.name), ["submit_report"]);
    assert.notDeepEqual(payloads[0]!.thinking, { type: "disabled" }, "unsupported forcing must not disable configured reasoning");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a refused SDK retry retains the preceding provider quota error and typed admission failure", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-provider-quota-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(429, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error",
      message: "The Token Plan usage limit has been reached. (2067)" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      minimax: { baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages",
        apiKey: "fixture-placeholder", models: [{ id: "MiniMax-M3", contextWindow: 32768,
          maxTokens: 4096, cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 } }] },
    } }));
    const budget = new AuditResourceBudget();
    const session = budget.beginSession();
    const denied = new AuditBudgetExceededError("fixture provider-call limit reached");
    let admissions = 0;
    await assert.rejects(new PiSdkRuntime().runSession({
      cwd, configDir: cwd,
      config: { schemaVersion: 1, thinkingLevel: "off", models: {
        primary: { provider: "minimax", model: "MiniMax-M3" },
      } },
      systemPrompt: "Local quota transport fixture.", userPrompt: "Return a result.", tools: [], timeoutMs: 10_000,
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, tools: [] }), auditResourceBudget: budget,
      onProviderRequest(reservation) {
        if (admissions++ > 0) throw denied;
        budget.recordProviderRequest(session, reservation);
      },
      onEvent(event) { budget.observeParentEvent(event, session); },
    }), error => {
      assert.equal(error, denied, "keep the original typed budget error and its identity");
      assert.match((error as Error).message, /provider-call limit reached.*429.*Token Plan.*2067/);
      return true;
    });
    assert.equal(requests, 1, "refused retry must not dispatch another HTTP request");
    assert.equal(budget.snapshot().model_calls, 1);
    assert.equal(budget.snapshot().unreserved_calls, 0);
    assert.equal(budget.snapshot().unreported_calls, 1, "a failed response does not prove zero provider usage");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

test("Anthropic output caps retain enabled thinking inside the answer-reserved envelope", () => {
  const payload = { max_tokens: 128_000, thinking: {
    type: "enabled", budget_tokens: 16_384, display: "summarized",
  }, tools: [] };
  assert.deepEqual(capProviderOutputTokens(payload, "anthropic-messages", 12_000), {
    ...payload, max_tokens: 12_000, thinking: { ...payload.thinking, budget_tokens: 10_976 },
  });
  assert.equal(payload.thinking.budget_tokens, 16_384, "do not mutate the SDK's original request");
  assert.deepEqual(capProviderOutputTokens({ ...payload, max_tokens: 4_096 }, "anthropic-messages", 12_000), {
    ...payload, max_tokens: 4_096, thinking: { ...payload.thinking, budget_tokens: 3_072 },
  });
  assert.deepEqual(capProviderOutputTokens({ ...payload, thinking: { type: "enabled", budget_tokens: 2_048 } },
    "anthropic-messages", 12_000), { ...payload, max_tokens: 12_000, thinking: { type: "enabled", budget_tokens: 2_048 } },
    "an already smaller reasoning allowance is never raised");
  for (const thinking of [{ type: "adaptive" }, { type: "disabled" }]) {
    assert.deepEqual(capProviderOutputTokens({ ...payload, thinking }, "anthropic-messages", 12_000),
      { ...payload, max_tokens: 12_000, thinking });
  }
  for (const cap of [1, 1_024, 2_047]) {
    assert.throws(() => capProviderOutputTokens(payload, "anthropic-messages", cap), /cannot fit enabled thinking/,
      "an impossible ceiling must not disable reasoning or expand the configured output budget");
  }
  assert.deepEqual(capProviderOutputTokens(payload, "anthropic-messages", 2_048), {
    ...payload, max_tokens: 2_048, thinking: { ...payload.thinking, budget_tokens: 1_024 },
  });
});

test("actual M3 SDK request caps fit thinking and refuse impossible caps before HTTP or accounting", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-sdk-thinking-cap-"));
  const payloads: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking-cap wire fixture complete" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      minimax: { baseUrl: `http://127.0.0.1:${address.port}`, api: "anthropic-messages", apiKey: "local-test-placeholder",
        models: [{ id: "MiniMax-M3", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 }] },
    } }));
    for (const posture of ["ordinary", "required", "after-turns"] as const) {
      for (const cap of [12_000, 1_024]) {
        const before = payloads.length;
        const budget = new AuditResourceBudget();
        const session = budget.beginSession();
        const run = new PiSdkRuntime().runSession({
          cwd, configDir: cwd,
          config: { schemaVersion: 1, thinkingLevel: "high", models: { primary: { provider: "minimax", model: "MiniMax-M3" } } },
          systemPrompt: "Local request envelope fixture.", userPrompt: "Submit the typed report.",
          tools: ["submit_report"], timeoutMs: 5_000, maxOutputTokens: cap,
          executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
          customTools: [{ name: "submit_report", label: "Submit", description: "Submit fixture result.", parameters: Type.Object({}),
            async execute() { return { content: [{ type: "text", text: "recorded" }], details: {} }; } }],
          ...(posture === "ordinary" ? {} : {
            recoveryPromptIfToolNotCalled: { requiredToolName: "submit_report", userPrompt: "Submit.", maxAttempts: 0 },
            ...(posture === "required" ? { forceRequiredToolChoice: true } : { forceRequiredToolChoiceAfterTurns: 1 }),
          }),
          auditResourceBudget: budget,
          onProviderRequest: reservation => budget.recordProviderRequest(session, reservation),
        });
        if (cap === 1_024) {
          await assert.rejects(run, /cannot fit enabled thinking/);
          assert.equal(payloads.length, before, `${posture}: SDK-swallowed hook failures cannot send the uncapped original`);
          assert.equal(budget.snapshot().model_calls, 0);
          assert.equal(budget.snapshot().reserved_output_tokens, 0);
        } else {
          await assert.rejects(run, /thinking-cap wire fixture complete/);
          assert.equal(payloads.length, before + 1);
          assert.equal(payloads.at(-1)!.max_tokens, cap);
          assert.deepEqual(payloads.at(-1)!.thinking, { type: "enabled", budget_tokens: 10_976, display: "summarized" });
          assert.equal(budget.snapshot().model_calls, 1);
          assert.equal(budget.snapshot().reserved_output_tokens, cap,
            "a bounded thinking allocation remains inside the existing full output reservation");
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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
