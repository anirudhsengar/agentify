import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentifyLog } from "../../src/core/audit/log.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testStreamingUpdatesAreNotPersisted(): Promise<void> {
  const configDir = tempDir("agentify-log-");
  try {
    const log = new AgentifyLog({ cwd: configDir, configDir });
    log.sessionEvent({
      pi_event_type: "message_update",
      event: { type: "message_update", repeated_payload: "x".repeat(100_000) },
    });
    log.sessionEvent({
      pi_event_type: "tool_execution_start",
      event: { type: "tool_execution_start", toolName: "write_map" },
    });
    const logPath = log.logPath;
    await log.close();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      event: string;
      payload: string;
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.event, "agentify.session_event");
    assert.match(lines[0]?.payload ?? "", /tool_execution_start/);
    assert.doesNotMatch(lines[0]?.payload ?? "", /repeated_payload/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testOnlyProviderResponsesCountAsTurns(): Promise<void> {
  const configDir = tempDir("agentify-log-provider-turns-");
  try {
    const log = new AgentifyLog({ cwd: configDir, configDir });
    const recordMessageEnd = (log as unknown as {
      recordMessageEnd?: (role: string, usage?: { input?: number; output?: number }) => void;
    }).recordMessageEnd;
    assert.equal(typeof recordMessageEnd, "function", "the log must own provider-response classification");
    recordMessageEnd!.call(log, "user");
    recordMessageEnd!.call(log, "toolResult");
    recordMessageEnd!.call(log, "assistant", { input: 3, output: 2 });
    log.runEnd({ exit_code: 0, status: "success" });
    log.runEnd({ exit_code: -1, status: "error" });
    const logPath = log.logPath;
    await log.close();

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      event: string;
      payload: string;
    });
    const terminal = lines.find((entry) => entry.event === "agentify.run_end");
    assert.equal(lines.filter((entry) => entry.event === "agentify.run_end").length, 1);
    assert.ok(terminal);
    const payload = JSON.parse(terminal.payload) as {
      total_turns: number;
      total_input_tokens: number;
      total_output_tokens: number;
    };
    assert.deepEqual(payload, {
      ...payload,
      total_turns: 1,
      total_input_tokens: 3,
      total_output_tokens: 2,
    });
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

await testStreamingUpdatesAreNotPersisted();
await testOnlyProviderResponsesCountAsTurns();
// Reduced from live narrative reviews whose audit payload became {type:"unknown"}.
const reviewDir = tempDir("agentify-log-review-");
try {
  const log = new AgentifyLog({ cwd: reviewDir, configDir: reviewDir });
  const review = { type: "specialist_review_result", concern: "Deadline normalization",
    digest: "a".repeat(64), repository_commit: "b".repeat(40), retryable: false,
    failure: "Numeric strings are accepted; example ghp_FAKEFIXTUREONLY", source: "x".repeat(100_000) };
  log.sessionEvent({ pi_event_type: review.type, event: review });
  await log.close();
  const raw = fs.readFileSync(log.logPath, "utf8");
  const record = JSON.parse(JSON.parse(raw).payload) as { event: Record<string, unknown> };
  assert.deepEqual(record.event, { type: review.type, concern: review.concern, digest: review.digest,
    repository_commit: review.repository_commit, retryable: false,
    failure: "Numeric strings are accepted; example [REDACTED:github-pat]" });
  assert.ok(Buffer.byteLength(raw) < 1_024, "review logs retain identity and outcome, not whole source");
} finally {
  fs.rmSync(reviewDir, { recursive: true, force: true });
}
const reservationCases: Array<Record<string, number>> = [{}, { unreported_calls: 1, unreserved_calls: 0,
  reserved_input_tokens: 100, reserved_output_tokens: 20, reserved_cost_usd: 0.5 }];
for (const bounds of reservationCases) {
const aggregateDir = tempDir("agentify-log-aggregate-");
try {
  const log = new AgentifyLog({ cwd: aggregateDir, configDir: aggregateDir });
  log.recordMessageEnd("assistant", { input: 3, output: 2, cost: { total: 0.01 } });
  // The persisted lineage includes explorers and previous invocations, unlike
  // the parent-session counters. Preserve that distinction at the terminal.
  const usage = { model_calls: 9, turns: 8, input_tokens: 41, output_tokens: 19, cost_usd: 0.08, ...bounds };
  log.auditBudget({ status: "within", limits: { maxModelCalls: 10 }, usage });
  usage.model_calls = 999;
  log.runEnd({ exit_code: 0, status: "success" });
  await log.close();
  const terminal = fs.readFileSync(log.logPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { event: string; payload: string })
    .find((entry) => entry.event === "agentify.run_end");
  assert.ok(terminal);
  const payload = JSON.parse(terminal.payload) as Record<string, unknown>;
  assert.equal(payload.total_usage_scope, "parent_sessions_this_invocation");
  assert.deepEqual(payload.aggregate_usage, { ...usage, model_calls: 9 });
  assert.equal(payload.aggregate_usage_scope, "repository_commit_lineage");
  assert.equal(payload.unanswered_model_calls, 1);
  assert.equal(payload.aggregate_cost_status, "incomplete_provider_usage");
  assert.equal(payload.aggregate_cost_upper_bound_usd, bounds.unreserved_calls === 0 ? 0.58 : undefined);
  assert.equal(payload.aggregate_input_upper_bound, bounds.unreserved_calls === 0 ? 141 : undefined);
  assert.equal(payload.aggregate_output_upper_bound, bounds.unreserved_calls === 0 ? 39 : undefined);
  const inspection = execFileSync(process.execPath, [
    path.resolve("src/core/audit/scripts/inspect-log.mjs"), log.logPath,
  ], { encoding: "utf8" });
  assert.match(inspection, /lineage_usage:.*"model_calls":9/);
  assert.match(inspection, /cost_status:.*incomplete_provider_usage/);
} finally {
  fs.rmSync(aggregateDir, { recursive: true, force: true });
}
}
console.log("audit log tests passed (4/4).");
