import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  EVAL_FAILURE_CATEGORIES, EvalResultSchema, EvalSuiteSchema, EvalTaskSchema, EvalTrialSchema,
  GraderResultSchema, aggregateEvalResult, appendJsonLine, evalRunPath, evalSuitePath, evalTaskPath,
  readJsonLines, renderEvalReport, resolveTrialPlan, runEvaluation, writeJsonAtomic,
  type EvalSuite, type EvalTask, type EvalTrial,
} from "../../src/core/evals/index.ts";

const timestamp = "2026-07-22T00:00:00.000Z";
function suite(overrides: Partial<EvalSuite> = {}): EvalSuite { return { schema_version: "1", suite_id: "fde", version: "1.0", description: "Supported FDE checks", task_references: ["task-a"], required_graders: ["deterministic"], number_of_trials: 2, concurrency_limit: 1, environment_requirements: [], aggregation_policy: { task_success: "any_trial", all_k: 2 }, release_gate_eligible: true, provenance: { source_reference: "spec:FDE", created_at: timestamp }, ...overrides }; }
function task(id = "task-a", source: "synthetic" | "historical" | "live" = "historical"): EvalTask {
  const provenance = source === "synthetic" ? { source_type: source, created_at: timestamp, source_reference: "fixture:a", generated_for_evaluation: true as const } : source === "historical" ? { source_type: source, created_at: timestamp, source_reference: "ticket:a", historical_record_reference: "ticket:a" } : { source_type: source, created_at: timestamp, source_reference: "live:a", authorization_reference: "approval:a" };
  return { schema_version: "1", task_id: id, suite_id: "fde", title: "Fix issue", description: "Fix the supplied issue", repository: { fixture: "fixtures/repo" }, workflow_input: { issue: "broken" }, expected_outcomes: ["tests pass"], forbidden_outcomes: ["unsafe write"], required_escalations: ["ask before deployment"], allowed_actions: ["edit fixture"], risk_tier: "medium", maximum_runtime_ms: 1_000, maximum_cost_usd: 1, grader_configuration: { deterministic: {} }, tags: ["fde"], evidence_references: ["ticket:a"], source_type: source, provenance };
}
function trial(index: number, passed: boolean, categories: EvalTrial["failure_categories"] = []): EvalTrial { return { schema_version: "1", run_id: "run-1", task_id: "task-a", trial_index: index, started_at: timestamp, ended_at: timestamp, status: passed ? "passed" : "failed", inputs: {}, environment_reference: "env:a", execution_reference: "exec:a", transcript_reference: "audit:a", cost_usd: 0.25, runtime_ms: 100, output_references: [], error: null, grader_results: [{ schema_version: "1", run_id: "run-1", task_id: "task-a", trial_index: index, grader_id: "deterministic", status: passed ? "passed" : "failed", passed, score: passed ? 1 : 0, explanation: "deterministic", failure_categories: categories, evidence_references: [], error: null }], passed, failure_categories: categories }; }
function root(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-evals-")); }

test("all eval schemas are strict and reject invalid limits, statuses, and arbitrary failures", () => {
  const values = [task(), suite(), trial(0, true), trial(0, true).grader_results[0], aggregateEvalResult(suite(), [task()], [trial(0, true), trial(1, true)], "run-1")];
  const schemas = [EvalTaskSchema, EvalSuiteSchema, EvalTrialSchema, GraderResultSchema, EvalResultSchema];
  values.forEach((value, index) => { assert.equal(Value.Check(schemas[index]!, value), true); assert.equal(Value.Check(schemas[index]!, { ...value, unknown: true }), false); });
  assert.equal(Value.Check(EvalTaskSchema, { ...task(), maximum_cost_usd: -1 }), false);
  assert.equal(Value.Check(EvalTaskSchema, { ...task(), maximum_runtime_ms: 0 }), false);
  assert.equal(Value.Check(EvalSuiteSchema, { ...suite(), number_of_trials: 0 }), false);
  assert.equal(Value.Check(EvalTrialSchema, { ...trial(0, false), failure_categories: ["made_up"] }), false);
  assert.equal(Value.Check(EvalTaskSchema, { ...task("task-a", "historical"), provenance: { source_type: "historical", created_at: timestamp, source_reference: "x" } }), false);
  assert.deepEqual([...EVAL_FAILURE_CATEGORIES].sort(), [...new Set(EVAL_FAILURE_CATEGORIES)].sort());
});

test("planning is stable and rejects missing and duplicate task IDs, including empty suites", () => {
  assert.deepEqual(resolveTrialPlan(suite(), [task()], "run-1"), resolveTrialPlan(suite(), [task()], "run-1"));
  assert.deepEqual(resolveTrialPlan(suite({ task_references: [] }), [], "run-1"), []);
  assert.throws(() => resolveTrialPlan(suite(), [], "run-1"), /missing task reference/);
  assert.throws(() => resolveTrialPlan(suite(), [task(), task()], "run-1"), /duplicate task ID/);
});

test("aggregation formulas expose partial, safety, grader failure, cost, and provenance", () => {
  const result = aggregateEvalResult(suite(), [task()], [trial(0, true), trial(1, false, ["unsafe_action", "grader_failure"])], "run-1");
  assert.equal(result.trial_pass_rate, 0.5); assert.equal(result.task_pass_rate, 1); assert.equal(result.pass_at_1, 1);
  assert.equal(result.repeated_trial_success_rate, 1); assert.equal(result.all_k_success_rate, 0);
  assert.equal(result.total_cost_usd, 0.5); assert.equal(result.total_runtime_ms, 200); assert.equal(result.safety_failures, 1);
  assert.equal(result.failure_distribution.unsafe_action, 1); assert.equal(result.release_gate_eligible, false);
  const partial = aggregateEvalResult(suite(), [task()], [trial(0, true)], "run-1");
  assert.equal(partial.status, "partial"); assert.equal(partial.pass_at_1, 1); assert.equal(partial.all_k_success_rate, 0);
  assert.equal(aggregateEvalResult(suite({ task_references: [] }), [], [], "empty").trial_pass_rate, 0);
  assert.equal(aggregateEvalResult(suite(), [task("task-a", "synthetic")], [trial(0, true), trial(1, true)], "run-1").release_gate_eligible, false);
});

test("JSONL appends are intact and truncated or invalid records are corrupt", () => {
  const state = root(); const file = path.join(state, "records.jsonl");
  try { appendJsonLine(file, trial(0, true)); appendJsonLine(file, trial(1, false)); assert.equal(readJsonLines(file, EvalTrialSchema, "trials").length, 2); fs.appendFileSync(file, "{\"partial\":"); assert.throws(() => readJsonLines(file, EvalTrialSchema, "trials"), /incomplete JSONL append/); }
  finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("imported mode persists deterministic evidence and resumes without rerunning completed trials", () => {
  const state = root();
  try {
    writeJsonAtomic(evalSuitePath(state, "eng", "fde"), suite()); writeJsonAtomic(evalTaskPath(state, "eng", "task-a"), task());
    const artifact = (trial_index: number) => ({ task_id: "task-a", trial_index, started_at: timestamp, ended_at: timestamp, inputs: {}, environment_reference: "env:a", execution_reference: "import:a", transcript_reference: "audit:a", cost_usd: 0.1, runtime_ms: 10, output_references: ["out:a"], error: null });
    let calls = 0; const graders = { deterministic: () => { calls += 1; return { status: "passed" as const, passed: true, score: 1, explanation: "ok", failure_categories: [], evidence_references: [], error: null }; } };
    const options = { stateDir: state, engagementId: "eng", suiteId: "fde", runId: "run-1", mode: "imported" as const, importedArtifacts: [artifact(0), artifact(1)], graders };
    const first = runEvaluation(options); assert.equal(first.passed_trials, 2); assert.equal(calls, 2);
    const runDir = evalRunPath(state, "eng", "run-1");
    const report = fs.readFileSync(path.join(runDir, "report.md"), "utf8"); assert.equal(report, renderEvalReport(first));
    fs.unlinkSync(path.join(runDir, "grader-results.jsonl"));
    assert.deepEqual(runEvaluation(options), first); assert.equal(calls, 2);
    assert.equal(readJsonLines(path.join(runDir, "grader-results.jsonl"), GraderResultSchema, "graders").length, 2);
    const runFile = path.join(runDir, "run.json"); fs.writeFileSync(runFile, "{broken"); assert.throws(() => runEvaluation(options), /corrupt eval run/);
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("no-execution records skipped trials, missing graders fail visibly, and execution is unavailable", () => {
  const state = root();
  try {
    writeJsonAtomic(evalSuitePath(state, "eng", "fde"), suite({ number_of_trials: 1 })); writeJsonAtomic(evalTaskPath(state, "eng", "task-a"), task());
    const skipped = runEvaluation({ stateDir: state, engagementId: "eng", suiteId: "fde", runId: "skip", mode: "no-execution" }); assert.equal(skipped.skipped_trials, 1);
    const artifact = { task_id: "task-a", trial_index: 0, started_at: timestamp, ended_at: timestamp, inputs: {}, environment_reference: null, execution_reference: null, transcript_reference: null, cost_usd: 0, runtime_ms: 0, output_references: [], error: null };
    const failed = runEvaluation({ stateDir: state, engagementId: "eng", suiteId: "fde", runId: "grader-error", mode: "imported", importedArtifacts: [artifact] }); assert.equal(failed.grader_errors, 1); assert.equal(failed.failure_distribution.grader_failure, 1);
    assert.throws(() => runEvaluation({ stateDir: state, engagementId: "eng", suiteId: "fde", runId: "execute", mode: "execute" }), /no supported execution adapter/);
    writeJsonAtomic(evalTaskPath(state, "eng", "task-a"), { ...task(), source_type: "synthetic" }); assert.throws(() => runEvaluation({ stateDir: state, engagementId: "eng", suiteId: "fde", runId: "bad-provenance", mode: "no-execution" }), /does not match provenance/);
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});
