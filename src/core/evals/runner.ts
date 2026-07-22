import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { EvalFailureCategory } from "./failure-taxonomy.ts";
import { SAFETY_FAILURE_CATEGORIES } from "./failure-taxonomy.ts";
import { evalRunPath, evalSuitePath, evalTaskPath } from "./paths.ts";
import { renderEvalReport } from "./report.ts";
import type { GraderResult } from "./schema/grader-result.ts";
import { GraderResultSchema } from "./schema/grader-result.ts";
import type { EvalResult } from "./schema/result.ts";
import { EvalResultSchema } from "./schema/result.ts";
import type { EvalSuite } from "./schema/suite.ts";
import { EvalSuiteSchema } from "./schema/suite.ts";
import type { EvalTask } from "./schema/task.ts";
import { EvalTaskSchema } from "./schema/task.ts";
import type { EvalTrial } from "./schema/trial.ts";
import { EvalTrialSchema } from "./schema/trial.ts";
import { appendJsonLine, readJsonLines, readValidatedJson, validateEvalValue, writeJsonAtomic, writeTextAtomic } from "./storage.ts";

export interface TrialPlanItem { run_id: string; task_id: string; trial_index: number }
const TrialPlanItemSchema = Type.Object({ run_id: Type.String(), task_id: Type.String(), trial_index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const RunStateSchema = Type.Object({ schema_version: Type.Literal("1"), run_id: Type.String(), suite_id: Type.String(), plan: Type.Array(TrialPlanItemSchema) }, { additionalProperties: false });
export interface ImportedTrialArtifact {
  task_id: string; trial_index: number; started_at: string; ended_at: string;
  inputs: Record<string, unknown>; environment_reference: string | null; execution_reference: string | null;
  transcript_reference: string | null; cost_usd: number; runtime_ms: number; output_references: string[];
  error: string | null;
}
export type GraderAdapter = (task: EvalTask, artifact: ImportedTrialArtifact, plan: TrialPlanItem) => Omit<GraderResult, "schema_version" | "run_id" | "task_id" | "trial_index" | "grader_id">;
export interface RunEvalOptions {
  stateDir: string; engagementId: string; suiteId: string; runId: string;
  mode: "imported" | "no-execution" | "execute"; importedArtifacts?: ImportedTrialArtifact[];
  graders?: Readonly<Record<string, GraderAdapter>>;
}

export function resolveTrialPlan(suite: EvalSuite, tasks: readonly EvalTask[], runId: string): TrialPlanItem[] {
  const ids = new Set<string>();
  for (const task of tasks) { if (ids.has(task.task_id)) throw new Error(`duplicate task ID: ${task.task_id}`); ids.add(task.task_id); }
  for (const reference of suite.task_references) if (!ids.has(reference)) throw new Error(`missing task reference: ${reference}`);
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return [...suite.task_references].sort().flatMap((taskId) => {
    const task = byId.get(taskId)!;
    if (task.suite_id !== suite.suite_id) throw new Error(`task ${taskId} belongs to suite ${task.suite_id}`);
    return Array.from({ length: suite.number_of_trials }, (_, trial_index) => ({ run_id: runId, task_id: taskId, trial_index }));
  });
}

export function aggregateEvalResult(suite: EvalSuite, tasks: readonly EvalTask[], trials: readonly EvalTrial[], runId: string): EvalResult {
  const completed = trials.filter((trial) => ["passed", "failed", "skipped", "error"].includes(trial.status));
  const passed = completed.filter((trial) => trial.passed === true);
  const failed = completed.filter((trial) => trial.status === "failed" || trial.status === "error");
  const skipped = completed.filter((trial) => trial.status === "skipped");
  const taskResults = suite.task_references.map((taskId) => completed.filter((trial) => trial.task_id === taskId));
  const taskPassed = taskResults.filter((values) => values.length === suite.number_of_trials && (suite.aggregation_policy.task_success === "all_trials" ? values.every((trial) => trial.passed) : values.some((trial) => trial.passed))).length;
  const firstTrials = taskResults.map((values) => values.find((trial) => trial.trial_index === 0)).filter((trial): trial is EvalTrial => trial !== undefined);
  const allK = suite.aggregation_policy.all_k;
  const failureDistribution: Partial<Record<EvalFailureCategory, number>> = {};
  for (const trial of completed) for (const category of trial.failure_categories) failureDistribution[category] = (failureDistribution[category] ?? 0) + 1;
  const missingGraders = [...new Set(completed.flatMap((trial) => suite.required_graders.filter((grader) => !trial.grader_results.some((result) => result.grader_id === grader))))].sort();
  const provenance = { synthetic: 0, historical: 0, live: 0 };
  for (const task of tasks) provenance[task.source_type] += 1;
  const safetyFailures = completed.filter((trial) => trial.failure_categories.some((category) => SAFETY_FAILURE_CATEGORIES.has(category))).length;
  const reasons: string[] = [];
  if (!suite.release_gate_eligible) reasons.push("suite is not designated as release-gate eligible");
  if (tasks.length > 0 && tasks.every((task) => task.source_type === "synthetic")) reasons.push("synthetic tasks alone cannot gate a release");
  if (completed.length !== suite.task_references.length * suite.number_of_trials) reasons.push("run is incomplete");
  if (missingGraders.length) reasons.push("required graders are missing");
  if (safetyFailures) reasons.push("run contains safety failures");
  const graderErrorCount = completed.flatMap((trial) => trial.grader_results).filter((grader) => grader.status === "error").length;
  if (graderErrorCount) reasons.push("one or more graders failed");
  if (failed.length || skipped.length) reasons.push("one or more trials did not pass");
  const result: EvalResult = {
    schema_version: "1", run_id: runId, suite_id: suite.suite_id, suite_version: suite.version,
    status: completed.length === suite.task_references.length * suite.number_of_trials ? "complete" : "partial",
    task_count: suite.task_references.length, planned_trials: suite.task_references.length * suite.number_of_trials, completed_trials: completed.length,
    passed_trials: passed.length, failed_trials: failed.length, skipped_trials: skipped.length,
    trial_pass_rate: completed.length ? passed.length / completed.length : 0,
    task_pass_rate: suite.task_references.length ? taskPassed / suite.task_references.length : 0,
    pass_at_1: firstTrials.length === suite.task_references.length && firstTrials.length > 0 ? firstTrials.filter((trial) => trial.passed).length / firstTrials.length : null,
    repeated_trial_success_rate: suite.task_references.length ? taskResults.filter((values) => values.some((trial) => trial.passed)).length / suite.task_references.length : 0,
    all_k_success_rate: allK === undefined ? null : (suite.task_references.length ? taskResults.filter((values) => values.filter((trial) => trial.trial_index < allK).length === allK && values.filter((trial) => trial.trial_index < allK).every((trial) => trial.passed)).length / suite.task_references.length : 0),
    total_cost_usd: completed.reduce((sum, trial) => sum + trial.cost_usd, 0), total_runtime_ms: completed.reduce((sum, trial) => sum + trial.runtime_ms, 0),
    failure_distribution: failureDistribution, missing_graders: missingGraders,
    grader_errors: graderErrorCount,
    safety_failures: safetyFailures, provenance_breakdown: provenance,
    release_gate_eligible: reasons.length === 0, release_gate_ineligibility_reasons: reasons,
  };
  return validateEvalValue<EvalResult>(EvalResultSchema, result, "eval result");
}

function skippedTrial(plan: TrialPlanItem, task: EvalTask, reason: string): EvalTrial {
  return { schema_version: "1", ...plan, started_at: new Date(0).toISOString(), ended_at: new Date(0).toISOString(), status: "skipped", inputs: task.workflow_input, environment_reference: null, execution_reference: null, transcript_reference: null, cost_usd: 0, runtime_ms: 0, output_references: [], error: reason, grader_results: [], passed: false, failure_categories: ["environment_failure"] };
}
export function runEvaluation(options: RunEvalOptions): EvalResult {
  if (options.mode === "execute") throw new Error("no supported execution adapter is available; use imported or no-execution mode");
  const suite = readValidatedJson<EvalSuite>(evalSuitePath(options.stateDir, options.engagementId, options.suiteId), EvalSuiteSchema, "eval suite");
  const tasks = suite.task_references.map((id) => readValidatedJson<EvalTask>(evalTaskPath(options.stateDir, options.engagementId, id), EvalTaskSchema, "eval task"));
  for (const task of tasks) if (task.source_type !== task.provenance.source_type) throw new Error(`task ${task.task_id} source_type does not match provenance`);
  const plan = resolveTrialPlan(suite, tasks, options.runId);
  const runDir = evalRunPath(options.stateDir, options.engagementId, options.runId);
  const runFile = path.join(runDir, "run.json");
  if (fs.existsSync(runFile)) {
    const prior = readValidatedJson<{ run_id: string; suite_id: string; plan: TrialPlanItem[] }>(runFile, RunStateSchema, "eval run");
    if (JSON.stringify(prior.plan) !== JSON.stringify(plan)) throw new Error("corrupt run state: persisted plan differs from deterministic plan");
  } else writeJsonAtomic(runFile, { schema_version: "1", run_id: options.runId, suite_id: suite.suite_id, plan });
  const trialsFile = path.join(runDir, "trials.jsonl");
  const gradersFile = path.join(runDir, "grader-results.jsonl");
  const existing = readJsonLines<EvalTrial>(trialsFile, EvalTrialSchema, "trials JSONL");
  const completedKeys = new Set(existing.map((trial) => `${trial.task_id}:${trial.trial_index}`));
  if (completedKeys.size !== existing.length) throw new Error("corrupt run state: duplicate completed trial records");
  const persistedGraders = readJsonLines<GraderResult>(gradersFile, GraderResultSchema, "grader-results JSONL");
  const graderKeys = new Set(persistedGraders.map((grader) => `${grader.task_id}:${grader.trial_index}:${grader.grader_id}`));
  for (const trial of existing) for (const grader of trial.grader_results) {
    const key = `${grader.task_id}:${grader.trial_index}:${grader.grader_id}`;
    if (!graderKeys.has(key)) { appendJsonLine(gradersFile, grader); graderKeys.add(key); }
  }
  const artifacts = new Map((options.importedArtifacts ?? []).map((artifact) => [`${artifact.task_id}:${artifact.trial_index}`, artifact]));
  for (const item of plan) {
    const key = `${item.task_id}:${item.trial_index}`; if (completedKeys.has(key)) continue;
    const task = tasks.find((candidate) => candidate.task_id === item.task_id)!;
    const artifact = artifacts.get(key);
    if (!artifact) { const trial = skippedTrial(item, task, "no imported artifact supplied"); appendJsonLine(trialsFile, trial); existing.push(trial); continue; }
    const graderResults: GraderResult[] = suite.required_graders.map((graderId) => {
      const adapter = options.graders?.[graderId];
      if (!adapter) return { schema_version: "1", ...item, grader_id: graderId, status: "error", passed: null, score: null, explanation: "grader adapter unavailable", failure_categories: ["grader_failure"], evidence_references: [], error: "grader adapter unavailable" };
      try { return validateEvalValue<GraderResult>(GraderResultSchema, { schema_version: "1", ...item, grader_id: graderId, ...adapter(task, artifact, item) }, "grader result"); }
      catch (error) { return { schema_version: "1", ...item, grader_id: graderId, status: "error", passed: null, score: null, explanation: "grader adapter failed", failure_categories: ["grader_failure"], evidence_references: [], error: error instanceof Error ? error.message : String(error) }; }
    });
    const isPassed = graderResults.length > 0 && graderResults.every((grader) => grader.status === "passed" && grader.passed === true);
    const categories = [...new Set(graderResults.flatMap((grader) => grader.failure_categories))];
    const trial: EvalTrial = validateEvalValue(EvalTrialSchema, { schema_version: "1", ...item, ...artifact, status: isPassed ? "passed" : "failed", grader_results: graderResults, passed: isPassed, failure_categories: categories }, "eval trial");
    appendJsonLine(trialsFile, trial); existing.push(trial);
    for (const grader of graderResults) { appendJsonLine(gradersFile, grader); graderKeys.add(`${grader.task_id}:${grader.trial_index}:${grader.grader_id}`); }
  }
  const result = aggregateEvalResult(suite, tasks, existing, options.runId);
  writeJsonAtomic(path.join(runDir, "summary.json"), result); writeJsonAtomic(path.join(runDir, "run.json"), { schema_version: "1", run_id: options.runId, suite_id: suite.suite_id, plan });
  writeTextAtomic(path.join(runDir, "report.md"), renderEvalReport(result));
  return result;
}
