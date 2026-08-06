import type { AcceptedTaskEvidence } from "../../learning/contracts.ts";
import type {
  BuilderResult,
  DurableTaskState,
  OrchestratorPlan,
  ReviewerVerdict,
  ValidationResult,
} from "../contracts.ts";
import { redactTaskText, sortedTaskStrings } from "../serialization.ts";

export function buildAcceptedTaskEvidence(input: {
  state: DurableTaskState;
  plan: OrchestratorPlan;
  builder: BuilderResult;
  validation: ValidationResult;
  reviewer: ReviewerVerdict;
  pull_request_number: number | null;
  source_artifact_url: string;
}): AcceptedTaskEvidence {
  const feedback = input.reviewer.findings
    .filter((finding) => finding.required_change !== null || input.reviewer.verdict === "approved")
    .slice(0, 32)
    .map((finding) => ({
      actor: input.reviewer.reviewer_agent_id,
      source_ref: `reviewer:${input.reviewer.verdict_digest}:${finding.finding_id}`,
      accepted_at: input.reviewer.reviewed_at,
      statement: redactTaskText(finding.required_change ?? finding.statement, 4_000),
    }));
  const validationCommands = sortedTaskStrings(input.validation.commands.map((command) => {
    const spec = input.plan.validation_commands.find((candidate) => candidate.command_id === command.command_id);
    return spec ? spec.argv.join(" ") : command.command_id;
  }));
  const validationEvidenceRefs = sortedTaskStrings(
    input.validation.commands.map((command) => `sha256:${command.output_digest}`),
  );
  return {
    schema_version: "1",
    task_id: input.state.task_id,
    issue_number: input.state.issue_number,
    pull_request_number: input.pull_request_number,
    issue_url: `https://github.com/${input.state.repository.full_name}/issues/${input.state.issue_number}`,
    plan_digest: input.plan.plan_digest,
    selected_specialist_ids: sortedTaskStrings(
      input.plan.selected_specialists.map((selection) => selection.specialist_id),
    ),
    selected_procedure_ids: sortedTaskStrings(
      input.plan.selected_procedures.map((selection) => selection.procedure_id),
    ),
    risk_category: input.plan.risk_category,
    validation: {
      commands: validationCommands,
      passed: input.validation.policy_verdict === "passed",
      evidence_refs: validationEvidenceRefs,
    },
    review_feedback: feedback,
    attempts: input.builder.attempts.map((attempt) => ({ ...attempt })),
    generalization: "candidate",
    cost_usd: input.state.budget.measured_cost_usd + input.state.budget.estimated_cost_usd,
    runtime_ms: Math.max(0, Date.parse(input.validation.completed_at) - Date.parse(input.state.budget.started_at)),
    source_artifact_url: input.source_artifact_url,
  };
}
