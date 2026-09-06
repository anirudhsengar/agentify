import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { PiSdkRuntime, providerFailureSummary } from "../../src/core/pi-sdk-runtime.ts";
import { createReadOnlyExecutionPolicy } from "../../src/core/security/execution-policy.ts";

const FIXTURE_ERROR = "fixture provider unavailable";

function success(response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ id: "response_fixture", choices: [{
    index: 0, delta: { role: "assistant", content: "fixture complete" }, finish_reason: "stop",
  }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
}

async function fixture(
  respond: (response: ServerResponse, requestNumber: number) => void,
  options: { recovery: boolean; abortOnRetry?: boolean; failAdmissionAfter?: number },
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-provider-failure-"));
  const requests: Array<Record<string, unknown>> = [];
  const retries: string[] = [];
  let admissions = 0;
  let toolCalls = 0;
  const controller = new AbortController();
  const admissionError = new Error("fixture admission guard");
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    respond(response, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
        apiKey: "local-test-placeholder", models: [{ id: "failure-fixture", contextWindow: 32768, maxTokens: 128 }] },
    } }));
    // Fast local transport retries only; no production retry or budget changes.
    fs.writeFileSync(path.join(cwd, "settings.json"), JSON.stringify({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    }));
    const tools = [{ name: "write_map_delta", label: "Checkpoint", description: "Fixture checkpoint.", parameters: Type.Object({}),
      async execute() {
        toolCalls += 1;
        return { content: [{ type: "text" as const, text: "recorded" }], details: {} };
      } }];
    const outcome = new PiSdkRuntime().runSession({
      cwd, configDir: cwd,
      config: { schemaVersion: 1, thinkingLevel: "off", models: { primary: { provider: "openai", model: "failure-fixture" } } },
      systemPrompt: "Local deterministic provider-failure test.", userPrompt: "Inspect fixture evidence.",
      tools: ["write_map_delta"], customTools: tools, timeoutMs: 10_000, signal: controller.signal,
      onProviderRequest() {
        if (options.failAdmissionAfter !== undefined && admissions >= options.failAdmissionAfter) throw admissionError;
        admissions += 1;
      },
      onEvent(event) {
        if (event.type === "auto_retry_start") {
          retries.push(event.errorMessage);
          if (options.abortOnRetry) controller.abort();
        }
      },
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
      ...(options.recovery ? { recoveryPromptIfToolNotCalled: {
        requiredToolName: "write_map_delta", userPrompt: "Submit the map now.", maxAttempts: 2,
      } } : {}),
    });
    try {
      const result = await outcome;
      return { result, error: undefined, requests, admissions, toolCalls, retries, admissionError };
    } catch (error) {
      return { result: undefined, error, requests, admissions, toolCalls, retries, admissionError };
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function failure(status: number) {
  return (response: ServerResponse): void => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: FIXTURE_ERROR, type: "fixture_error" } }));
  };
}

test("actual SDK permanent provider errors stop before map-recovery prompts", async () => {
  const outcome = await fixture(failure(400), { recovery: true });
  assert.ok(outcome.error instanceof Error);
  assert.match(outcome.error.message, /provider session failed \(openai\).*fixture provider unavailable/);
  assert.equal(outcome.requests.length, 1, "no new prompts or retries for a permanent error");
  assert.equal(outcome.admissions, 1);
  assert.equal(outcome.toolCalls, 0);
});

test("actual SDK exhausted retries surface the provider error instead of starting new recovery series", async () => {
  const outcome = await fixture(failure(503), { recovery: true });
  assert.ok(outcome.error instanceof Error);
  assert.match(outcome.error.message, /provider session failed \(openai\).*fixture provider unavailable/);
  assert.equal(outcome.requests.length, 2, "one initial call and one configured SDK retry, not six calls");
  assert.equal(outcome.admissions, 2, "each provider request is still admitted/accounted");
  assert.equal(outcome.retries.length, 1);
  assert.equal(outcome.toolCalls, 0);
});

test("a successful actual SDK retry clears the earlier error", async () => {
  const outcome = await fixture((response, index) => index === 1 ? failure(503)(response) : success(response), { recovery: false });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.aborted, false);
  assert.equal(outcome.requests.length, 2);
  assert.equal(outcome.admissions, 2);
  assert.equal(outcome.retries.length, 1);
});

test("successful prose still receives structured-output recovery", async () => {
  const outcome = await fixture(success, { recovery: true });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.aborted, false);
  assert.equal(outcome.requests.length, 3, "existing bounded recovery remains available after successful responses");
});

test("cancellation during an SDK retry retains cancellation rather than resurfacing an earlier error", async () => {
  const outcome = await fixture(failure(503), { recovery: true, abortOnRetry: true });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.aborted, true);
  assert.equal(outcome.requests.length, 1);
});

test("admission errors retain precedence over earlier provider failures", async () => {
  const outcome = await fixture(failure(503), { recovery: true, failAdmissionAfter: 1 });
  assert.equal(outcome.error, outcome.admissionError);
  assert.equal(outcome.requests.length, 1, "the rejected second request never reaches the server");
});

test("provider failure summaries redact before bounding and never stringify unknown objects", () => {
  const secret = "synthetic-private-key-value";
  const message = `503 ${secret} ${Buffer.from(secret).toString("base64")} sk-12345678901234567890 Authorization: Bearer opaquevalue\n\u001b[31m`;
  const summary = providerFailureSummary(message, [secret]);
  assert.match(summary, /^503/);
  for (const value of [secret, Buffer.from(secret).toString("base64"), "sk-12345678901234567890", "opaquevalue", "\u001b"]) {
    assert.equal(summary.includes(value), false);
  }
  assert.match(providerFailureSummary("a".repeat(5_000)), /\[TRUNCATED\]$/);
  assert.ok(providerFailureSummary("a".repeat(5_000)).length <= 2_000);
  assert.match(providerFailureSummary({ toString() { throw new Error("untrusted conversion"); } }), /without diagnostic details/);
  assert.match(providerFailureSummary("  "), /without diagnostic details/);
});
