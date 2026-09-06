import assert from "node:assert/strict";
import test from "node:test";
import { summarizeInstallationEvents } from "../../scripts/live-installation.mjs";

const captured = [
  { event: "agentify.run_start", payload: { model: "MiniMax-M3" } },
  { event: "agentify.audit_budget", payload: { status: "exhausted", usage: {
    model_calls: 217, input_tokens: 7598731, output_tokens: 101655,
    cost_usd: 0.74645946, unreported_calls: 1, reserved_cost_usd: 0.0344106,
  } } },
  { event: "agentify.run_end", payload: { status: "error", exit_code: 1,
    error_message: "repository audit resource budget exhausted: input token reserve 334567 is below the serialized provider request bound of 379110" } },
];

test("live JSON-serialized payloads retain the actual model, usage, unknown reservation and failure", () => {
  const serialized = captured.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));
  const result = summarizeInstallationEvents(serialized);
  assert.equal(result.model, "MiniMax-M3");
  assert.deepEqual(result.budget, captured[1].payload);
  assert.deepEqual(result.terminals, [captured[2].payload]);
  assert.equal(result.terminals[0].status, "error", "decoding must not turn a failed installation into a pass");
});

test("object payloads produce the same report without modifying the source envelopes", () => {
  const before = JSON.stringify(captured);
  assert.deepEqual(summarizeInstallationEvents(captured),
    summarizeInstallationEvents(captured.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }))));
  assert.equal(JSON.stringify(captured), before);
});

test("malformed relevant payloads fail closed while unrelated summaries are not reparsed", () => {
  for (const payload of [null, [], "[]", "null", '\"nested string\"', "{incomplete"]) {
    assert.throws(() => summarizeInstallationEvents([{ event: "agentify.run_end", payload }]));
  }
  assert.deepEqual(summarizeInstallationEvents([{ event: "agentify.session_event", payload: "truncated summary" }]),
    { terminals: [], budget: null, model: null });
});

test("multiple terminal records remain visible and cannot be deduplicated into success", () => {
  const result = summarizeInstallationEvents([...captured, { event: "agentify.run_end", payload: JSON.stringify({ status: "success", exit_code: 0 }) }]);
  assert.equal(result.terminals.length, 2);
  assert.equal(result.terminals[0].exit_code, 1);
});
