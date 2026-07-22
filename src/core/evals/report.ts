import type { EvalResult } from "./schema/result.ts";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
export function renderEvalReport(result: EvalResult): string {
  const failures = Object.entries(result.failure_distribution).sort(([a], [b]) => a.localeCompare(b));
  const provenance = Object.entries(result.provenance_breakdown).sort(([a], [b]) => a.localeCompare(b));
  return [
    `# Evaluation run ${result.run_id}`, "", `- Suite: ${result.suite_id} (${result.suite_version})`,
    `- Status: ${result.status}`, `- Tasks: ${result.task_count}`, `- Planned trials: ${result.planned_trials}`, `- Completed trials: ${result.completed_trials}`,
    `- Passed / failed / skipped: ${result.passed_trials} / ${result.failed_trials} / ${result.skipped_trials}`,
    `- Trial pass rate: ${percent(result.trial_pass_rate)}`, `- Task pass rate: ${percent(result.task_pass_rate)}`,
    `- pass@1: ${result.pass_at_1 === null ? "not applicable" : percent(result.pass_at_1)}`,
    `- Repeated-trial success: ${percent(result.repeated_trial_success_rate)}`,
    `- All-k success: ${result.all_k_success_rate === null ? "not configured" : percent(result.all_k_success_rate)}`,
    `- Cost: $${result.total_cost_usd.toFixed(6)}`, `- Runtime: ${result.total_runtime_ms} ms`,
    `- Missing graders: ${result.missing_graders.length === 0 ? "none" : result.missing_graders.join(", ")}`,
    `- Grader errors: ${result.grader_errors}`, `- Safety failures: ${result.safety_failures}`,
    `- Release-gate eligible: ${result.release_gate_eligible ? "yes" : "no"}`,
    `- Evidence sufficiency: ${result.release_gate_eligible ? "sufficient for configured eval policy" : "insufficient"}`,
    ...(result.release_gate_ineligibility_reasons.map((reason) => `  - ${reason}`)),
    "", "## Failure distribution", "", ...(failures.length ? failures.map(([name, count]) => `- ${name}: ${count}`) : ["- none"]),
    "", "## Provenance", "", ...(provenance.length ? provenance.map(([name, count]) => `- ${name}: ${count}`) : ["- none"]), "",
  ].join("\n");
}
