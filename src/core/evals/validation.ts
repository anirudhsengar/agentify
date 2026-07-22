import * as fs from "node:fs";
import { createSupportedGraderAdapters, validateGraderConfiguration } from "./graders.ts";
import { evalSuitePath, evalTaskPath } from "./paths.ts";
import type { EvalSuite } from "./schema/suite.ts";
import { EvalSuiteSchema } from "./schema/suite.ts";
import type { EvalTask } from "./schema/task.ts";
import { EvalTaskSchema } from "./schema/task.ts";
import { readValidatedJson } from "./storage.ts";

export interface ValidatedEvalSuite { suite: EvalSuite; tasks: EvalTask[]; releaseEligibilityWarnings: string[] }
export function loadAndValidateEvalSuite(stateDir: string, engagementId: string, suiteId: string): ValidatedEvalSuite {
  const suite = readValidatedJson<EvalSuite>(evalSuitePath(stateDir, engagementId, suiteId), EvalSuiteSchema, "eval suite");
  if (suite.aggregation_policy.all_k !== undefined && suite.aggregation_policy.all_k > suite.number_of_trials) throw new Error("all_k cannot exceed number_of_trials");
  const seen = new Set<string>(); const tasks = suite.task_references.map((reference) => {
    const file = evalTaskPath(stateDir, engagementId, reference); if (!fs.existsSync(file)) throw new Error(`missing task reference: ${reference}`);
    const task = readValidatedJson<EvalTask>(file, EvalTaskSchema, "eval task");
    if (seen.has(task.task_id)) throw new Error(`duplicate task ID: ${task.task_id}`); seen.add(task.task_id);
    if (task.task_id !== reference || task.suite_id !== suite.suite_id) throw new Error(`task reference mismatch: ${reference}`);
    if (task.source_type !== task.provenance.source_type) throw new Error(`task ${task.task_id} source_type does not match provenance`);
    validateGraderConfiguration(task, suite.required_graders); return task;
  });
  const adapters = createSupportedGraderAdapters();
  for (const grader of suite.required_graders) if (!(grader in adapters)) throw new Error(`grader adapter unavailable: ${grader}`);
  const warnings: string[] = [];
  if (!suite.release_gate_eligible) warnings.push("suite is not designated for release gating");
  if (tasks.length === 0) warnings.push("suite contains no tasks");
  if (tasks.length > 0 && tasks.every((task) => task.source_type === "synthetic")) warnings.push("synthetic-only evidence is insufficient for external release proof");
  if (suite.release_policy?.minimum_task_count !== undefined && tasks.length < suite.release_policy.minimum_task_count) warnings.push(`minimum task count is ${suite.release_policy.minimum_task_count}`);
  return { suite, tasks, releaseEligibilityWarnings: warnings };
}
