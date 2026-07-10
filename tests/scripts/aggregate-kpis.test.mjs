#!/usr/bin/env node
// tests/scripts/aggregate-kpis.test.mjs — verify the aggregate-kpis script
// produces correct outputs and includes the Class 3 fleet surface.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "src/core/audit/scripts/aggregate-kpis.mjs");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testEmptyLogDir() {
  const d = tempDir("agentify-kpi-empty-");
  const out = execFileSync("node", [SCRIPT, "--log-dir", d], { encoding: "utf-8" });
  assert.match(out, /No runs found/);
  fs.rmSync(d, { recursive: true, force: true });
}

async function testSingleRun() {
  const d = tempDir("agentify-kpi-one-");
  // Write a minimal agentify run log with run_end + a few session events.
  const log = [
    { event: "agentify.run_start", ts: "2026-07-03T07:00:00Z" },
    { event: "agentify.session_event", payload: JSON.stringify({ event: { type: "tool_execution_start", toolName: "read" } }) },
    { event: "agentify.session_event", payload: JSON.stringify({ event: { type: "tool_execution_start", toolName: "bash" } }) },
    { event: "agentify.run_end", payload: JSON.stringify({ status: "success", duration_ms: 12000, total_cost_usd: 0.05, coverage: { covered: 9, gap: 1, total: 10 } }) },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(d, "run-1.jsonl"), log);

  const out = execFileSync("node", [SCRIPT, "--log-dir", d], { encoding: "utf-8" });
  assert.match(out, /Runs analyzed: \*\*1\*\*/);
  assert.match(out, /Success rate:\*\* 1\/1/);
  assert.match(out, /Mean cost:\*\* \$0\.0500/);
  assert.match(out, /read: 1/);
  assert.match(out, /bash: 1/);
  fs.rmSync(d, { recursive: true, force: true });
}

async function testIncludesClass3FleetSection() {
  // Set up a fake orchestrator dir + a fake workflow run, run the script
  // from a separate cwd so it reads our fake HOME. Also write a single
  // agentify run log so the script reaches the fleet section.
  const fakeHome = tempDir("agentify-kpi-fleet-");
  const logDir = path.join(fakeHome, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const runLog = JSON.stringify({ event: "agentify.run_start", ts: "2026-07-03T07:00:00Z" }) + "\n" +
    JSON.stringify({ event: "agentify.run_end", payload: JSON.stringify({ status: "success", duration_ms: 12000, total_cost_usd: 0.05, coverage: { covered: 9, gap: 1, total: 10 } }) }) + "\n";
  fs.writeFileSync(path.join(logDir, "run-1.jsonl"), runLog);

  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    // Pre-create orchestrator + workflow state.
    const orchRoot = path.join(fakeHome, ".agentify", "orchestrator");
    fs.mkdirSync(orchRoot, { recursive: true });
    // Two chat_ended events.
    fs.writeFileSync(
      path.join(orchRoot, "events.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), kind: "chat_ended", fields: { turns: 3, costUsd: 0.02 } }) + "\n" +
      JSON.stringify({ at: new Date().toISOString(), kind: "chat_ended", fields: { turns: 5, costUsd: 0.04 } }) + "\n",
    );
    // A workflow run.
    const wfDir = path.join(orchRoot, "workflows", "wf-test");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, "workflow_run.json"),
      JSON.stringify({ workflow_run_id: "wf-test", workflow_name: "scout_then_build", status: "completed", cost_usd: 0.10, started_at: new Date().toISOString() }),
    );
    // An AIW.
    const aiwDir = path.join(fakeHome, ".agentify", "aiw", "aiw-test");
    fs.mkdirSync(aiwDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiwDir, "aiw_state.json"),
      JSON.stringify({ aiw_id: "aiw-test", workflow_type: "plan_build", status: "running" }),
    );

    const out = execFileSync("node", [SCRIPT, "--log-dir", logDir], { encoding: "utf-8" });
    assert.match(out, /Class 3 fleet surface/, "should emit fleet section");
    assert.match(out, /Orchestrator chats:\*\* 2/, "should aggregate chat stats");
    assert.match(out, /Workflow runs:\*\* 1 . 1 completed/, "should aggregate workflow stats");
    assert.match(out, /AIWs:\*\* 1 . 1 running/, "should aggregate AIW stats");
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}

await testEmptyLogDir();
await testSingleRun();
await testIncludesClass3FleetSection();

console.log("aggregate-kpis tests passed.");