import type {
  ReadinessReasonCode,
  TaskReadinessDecision,
  TaskReadinessInput,
  TaskReadinessReason,
  TaskRiskCategory,
} from "./contracts.ts";
import { normalizeTaskPaths, redactTaskText } from "./serialization.ts";

const FORBIDDEN_REQUESTS: ReadonlyArray<{
  code: ReadinessReasonCode;
  pattern: RegExp;
  message: string;
}> = [
  {
    code: "forbidden_merge",
    pattern: /\b(?:please\s+|then\s+|automatically\s+|auto[- ]?)merge\b|\bmerge\s+(?:the\s+)?(?:pull request|pr|branch)\b/i,
    message: "Agentify cannot merge or enable auto-merge for application changes.",
  },
  {
    code: "forbidden_deployment",
    pattern: /\bdeploy\s+(?:this|it|the change|to production|prod)\b|\bproduction deployment\b/i,
    message: "Agentify cannot deploy application changes.",
  },
  {
    code: "forbidden_credential_exposure",
    pattern: /\b(?:show|print|return|expose|upload|commit)\b[^.\n]{0,80}\b(?:secret|token|credential|api key|private key)\b/i,
    message: "Agentify cannot expose or commit credentials.",
  },
  {
    code: "forbidden_policy_expansion",
    pattern: /\b(?:disable|bypass|expand|weaken|remove)\b[^.\n]{0,80}\b(?:policy|guard|protected path|permission|approval)\b/i,
    message: "Model output cannot expand or weaken repository policy.",
  },
  {
    code: "forbidden_history_rewrite",
    pattern: /\b(?:force[- ]push|git\s+reset\s+--hard|rewrite\s+(?:git\s+)?history|filter-branch)\b/i,
    message: "Agentify cannot perform destructive history rewrites or force-push.",
  },
  {
    code: "forbidden_default_branch_write",
    pattern: /\b(?:push|commit|apply)\b[^.\n]{0,80}\b(?:directly\s+to\s+)?(?:main|master|default branch)\b/i,
    message: "Application changes cannot be written directly to the default branch.",
  },
];

function withoutExplicitNegations(value: string): string {
  return value
    .replace(/\b(?:do not|don't|never|must not|cannot|can't)\s+(?:automatically\s+|auto[- ]?)?merge\b/gi, "")
    .replace(/\b(?:do not|don't|never|must not|cannot|can't)\s+deploy\b/gi, "")
    .replace(/\b(?:do not|don't|never|must not|cannot|can't)\s+force[- ]push\b/gi, "")
    .replace(/\b(?:no|without)\s+(?:merge|deployment|credential exposure|policy expansion)\b/gi, "");
}

function riskCategory(input: TaskReadinessInput): TaskRiskCategory {
  const text = `${input.issue_text}\n${input.proposed_paths.join("\n")}`.toLowerCase();
  if (/\b(?:credential|secret|authorization|permission|production|deploy|payment)\b/.test(text)) {
    return "critical";
  }
  if (
    /(?:^|\/)(?:\.github\/workflows|migrations?|infrastructure|security|auth|database)(?:\/|$)/m.test(text)
    || /\b(?:dependency|lockfile|schema migration|breaking change)\b/.test(text)
  ) {
    return "high";
  }
  if (/\b(?:api contract|configuration|generated file|package)\b/.test(text)) return "medium";
  return "low";
}

function pushReason(reasons: TaskReadinessReason[], code: ReadinessReasonCode, message: string): void {
  if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, message });
}

export function assessTaskReadiness(input: TaskReadinessInput): TaskReadinessDecision {
  const reasons: TaskReadinessReason[] = [];
  const questions: string[] = [];
  if (!input.issue_open) pushReason(reasons, "issue_closed", "The GitHub issue is closed.");
  if (!input.actor_authorized) {
    pushReason(reasons, "unauthorized_actor", "The queue actor lacks trusted repository write permission.");
  }
  if (input.repository.repository_id !== input.installation_repository_id) {
    pushReason(reasons, "repository_mismatch", "The issue repository does not match the Agentify installation.");
  }
  if (input.active_task_id) {
    pushReason(reasons, "active_task_conflict", `Active task ${input.active_task_id} already owns this issue.`);
  }
  if (input.conflicting_pull_request !== null) {
    pushReason(
      reasons,
      "pull_request_conflict",
      `Pull request #${input.conflicting_pull_request} already claims this issue.`,
    );
  }
  if (input.expected_base_commit !== input.current_base_commit) {
    pushReason(reasons, "stale_base", "The expected base commit is no longer the current trusted base.");
  }
  if (input.acceptance_criteria.length === 0) {
    pushReason(reasons, "missing_acceptance_criteria", "No verifiable acceptance criteria were supplied.");
    questions.push("What exact observable conditions must be true for this issue to be accepted?");
  }
  const proposedPaths = normalizeTaskPaths(input.proposed_paths, "proposed task path");
  if (proposedPaths.length === 0) {
    pushReason(reasons, "missing_scope", "No bounded application path scope was supplied.");
    questions.push("Which repository paths are in scope, and which paths must remain excluded?");
  }
  if (input.validation_commands.length === 0) {
    pushReason(reasons, "missing_validation", "No application-owned validation command is available.");
    questions.push("Which deterministic install, build, typecheck, test, lint, or security commands validate the task?");
  }
  if (!input.protected_path_policy_known) {
    pushReason(reasons, "protected_path_policy_unknown", "Protected-path policy is unavailable.");
    questions.push("Which paths are protected from autonomous application writes?");
  }
  if (!input.validation_services_attested) {
    pushReason(
      reasons,
      "unsafe_secret_or_service_requirement",
      "Required secrets or external services are not test-safe for autonomous validation.",
    );
  }
  if (!input.validation_policy_current) {
    pushReason(
      reasons,
      "validation_policy_stale",
      "The attested validation command, package manifest, or lockfile has changed.",
    );
  }
  if (!Number.isFinite(input.available_budget_usd) || input.available_budget_usd <= 0) {
    pushReason(reasons, "budget_unavailable", "No positive bounded task budget is available.");
  }

  const requestText = withoutExplicitNegations(input.issue_text);
  for (const forbidden of FORBIDDEN_REQUESTS) {
    if (forbidden.pattern.test(requestText)) pushReason(reasons, forbidden.code, forbidden.message);
  }

  const refusalCodes = new Set<ReadinessReasonCode>([
    "forbidden_merge",
    "forbidden_deployment",
    "forbidden_credential_exposure",
    "forbidden_policy_expansion",
    "forbidden_history_rewrite",
    "forbidden_default_branch_write",
  ]);
  const clarificationCodes = new Set<ReadinessReasonCode>([
    "missing_acceptance_criteria",
    "missing_scope",
    "missing_validation",
    "protected_path_policy_unknown",
  ]);
  let disposition: TaskReadinessDecision["disposition"] = "ready";
  if (reasons.some((reason) => refusalCodes.has(reason.code))) disposition = "refused";
  else if (reasons.some((reason) => reason.code === "stale_base")) disposition = "stale-base";
  else if (reasons.some((reason) => clarificationCodes.has(reason.code))) disposition = "needs-information";
  else if (reasons.length > 0) disposition = "blocked";

  return {
    disposition,
    reasons: reasons.map((reason) => ({ ...reason, message: redactTaskText(reason.message, 1_000) })),
    clarification_questions: questions.map((question) => redactTaskText(question, 1_000)),
    risk_category: riskCategory(input),
  };
}
