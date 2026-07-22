import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { evalCommand, printEvalHelp } from "../../src/core/evals/cli.ts";
import { evalSuitePath, evalTaskPath, type EvalSuite, type EvalTask } from "../../src/core/evals/index.ts";
import type { AgentifyUi } from "../../src/core/types.ts";

class Capture extends Writable { value = ""; _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void { this.value += chunk.toString(); callback(); } }
const ui: AgentifyUi = { status() {}, info() {}, error() {}, async promptSelect(_m, choices) { return choices[0]!.value; }, async promptMultiSelect() { return []; }, async promptCheckboxList() { return []; }, async promptSecret() { return ""; } };
const timestamp = "2026-07-22T00:00:00.000Z";
function repo(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-eval-cli-")); fs.mkdirSync(path.join(root, ".git")); return root; }
function fixtures(root: string): void {
  const state = path.join(root, ".claude", "agentify");
  const suite: EvalSuite = { schema_version: "1", suite_id: "suite", version: "1", description: "CLI suite", task_references: ["task"], required_graders: ["deterministic"], number_of_trials: 1, concurrency_limit: 1, environment_requirements: [], aggregation_policy: { task_success: "all_trials" }, release_gate_eligible: true, release_policy: { minimum_task_count: 1, require_safety_checks: true, require_complete_traces: true, require_cost_runtime_reporting: true }, provenance: { source_reference: "spec:1", created_at: timestamp } };
  const task: EvalTask = { schema_version: "1", task_id: "task", suite_id: "suite", title: "Task", description: "Task", repository: { fixture: "fixture" }, workflow_input: {}, expected_outcomes: ["done"], forbidden_outcomes: [], required_escalations: [], allowed_actions: [], risk_tier: "low", maximum_runtime_ms: 100, maximum_cost_usd: 1, grader_configuration: { deterministic: { checks: [{ type: "command_status", command_id: "tests", category: "test", expected_exit_status: 0 }] } }, tags: [], evidence_references: [], source_type: "historical", provenance: { source_type: "historical", created_at: timestamp, source_reference: "ticket:1", historical_record_reference: "ticket:1" } };
  for (const [file, value] of [[evalSuitePath(state, "eng", "suite"), suite], [evalTaskPath(state, "eng", "task"), task]] as const) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
}
async function run(root: string, argv: string[]): Promise<{ code: number; out: string; err: string }> { const out = new Capture(); const err = new Capture(); const code = await evalCommand(argv, { cwd: root, configDir: path.join(root, "config"), ui, out, err, stdinIsTTY: false }); return { code, out: out.value, err: err.value }; }

test("eval help exposes only supported actions", async () => {
  const out = new Capture(); printEvalHelp(out); assert.match(out.value, /eval <run\|report\|validate>/); assert.doesNotMatch(out.value, /orchestrator|shadow/i);
  const root = repo(); try { assert.match((await run(root, ["unknown"])).err, /Valid: run, report, validate/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("eval validate, imported run, resume, and deterministic report", async () => {
  const root = repo(); try {
    fixtures(root); const valid = await run(root, ["validate"]); assert.equal(valid.code, 0); assert.match(valid.out, /eligible when a complete run passes/);
    const input = path.join(root, "artifacts.json"); fs.writeFileSync(input, JSON.stringify([{ task_id: "task", trial_index: 0, started_at: timestamp, ended_at: timestamp, inputs: {}, environment_reference: "env", execution_reference: "import", transcript_reference: "trace:1", cost_usd: 0.1, runtime_ms: 10, output_references: [], error: null, facts: { command_results: [{ command_id: "tests", category: "test", exit_status: 0 }] } }]));
    const first = await run(root, ["run", "--run-id", "run-1", "--input", input]); assert.equal(first.code, 0); assert.match(first.out, /Run ID: run-1/); assert.match(first.out, /Release-gate eligible: yes/);
    const resumed = await run(root, ["run", "--run-id", "run-1", "--input", input]); assert.equal(resumed.code, 0);
    const report1 = await run(root, ["report", "--run-id", "run-1", "--stdout"]); const report2 = await run(root, ["report", "--run-id", "run-1", "--stdout"]); assert.equal(report1.out, report2.out); assert.match(report1.out, /Safety failures: 0/); assert.match(report1.out, /Release-gate eligible: yes/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("eval run enforces limits and synthetic-only release evidence stays ineligible", async () => {
  const root = repo(); try {
    fixtures(root); const taskPath = evalTaskPath(path.join(root, ".claude", "agentify"), "eng", "task"); const synthetic = JSON.parse(fs.readFileSync(taskPath, "utf8")) as Record<string, unknown>; synthetic.source_type = "synthetic"; synthetic.provenance = { source_type: "synthetic", created_at: timestamp, source_reference: "fixture:1", generated_for_evaluation: true }; fs.writeFileSync(taskPath, JSON.stringify(synthetic));
    const valid = await run(root, ["validate"]); assert.match(valid.out, /synthetic-only evidence is insufficient/);
    const input = path.join(root, "artifacts.json"); fs.writeFileSync(input, JSON.stringify([{ task_id: "task", trial_index: 0, started_at: timestamp, ended_at: timestamp, inputs: {}, environment_reference: "env", execution_reference: "import", transcript_reference: "trace:1", cost_usd: 2, runtime_ms: 101, output_references: [], error: null, facts: { command_results: [{ command_id: "tests", category: "test", exit_status: 0 }] } }]));
    const result = await run(root, ["run", "--run-id", "limits", "--input", input]); assert.match(result.out, /Release-gate eligible: no/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
