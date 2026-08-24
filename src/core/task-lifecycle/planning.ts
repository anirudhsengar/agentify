import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import type { CodebaseMap } from "../audit/schema.ts";
import { listAgentIdentities } from "../memory/index.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { buildLearningContext } from "../learning/context.ts";
import type { LearningContextResult } from "../learning/contracts.ts";
import { discoverSpecialistPortfolio } from "../specialists/discovery.ts";
import { listTrackedFilesAtCommit, readGitHeadCommit } from "../specialists/evidence.ts";
import { routeSpecialistPortfolio } from "../specialists/routing.ts";
import type {
  ProcedureDefinition,
  SpecialistDefinition,
  SpecialistRoutingReport,
} from "../specialists/contracts.ts";
import {
  TASK_LIFECYCLE_SCHEMA_VERSION,
  TASK_RUNTIME_PROTECTED_PATHS,
  type OrchestratorPlan,
  type PlannerRefinementRequest,
  type PlanProcedureSelection,
  type PlanSpecialistSelection,
  type SpecialistConsultationRequest,
  type SpecialistConsultationResult,
  type TaskPlanningInput,
  type TaskPlanningResult,
  type ValidationCommandSpec,
} from "./contracts.ts";
import {
  digestTaskValue,
  normalizeTaskPaths,
  pathWithinTaskScope,
  redactTaskText,
  sortedTaskStrings,
} from "./serialization.ts";

function routedReasonText(reasons: ReadonlyArray<{ kind: string; signal: string; weight: number }>): string[] {
  return reasons.map((reason) => `${reason.kind}:${reason.signal} (weight ${reason.weight})`);
}

function selectedSpecialists(routing: SpecialistRoutingReport): PlanSpecialistSelection[] {
  return routing.selected_specialists.map((selection) => ({
    specialist_id: selection.specialist_id,
    score: selection.score,
    reasons: routedReasonText(selection.reasons),
  }));
}

function selectedProcedures(routing: SpecialistRoutingReport): PlanProcedureSelection[] {
  return routing.selected_procedures.map((selection) => ({
    procedure_id: selection.procedure_id,
    score: selection.score,
    reasons: routedReasonText(selection.reasons),
  }));
}

function learningContext(
  cwd: string,
  candidatePaths: ReadonlyArray<string>,
  specialistIds: ReadonlyArray<string>,
): LearningContextResult {
  return buildLearningContext(cwd, {
    candidate_paths: candidatePaths,
    specialist_ids: specialistIds,
    include_inactive: false,
    max_records: 32,
  });
}

function procedureById(
  procedures: ReadonlyArray<ProcedureDefinition>,
  procedureId: string,
): ProcedureDefinition | null {
  return procedures.find((procedure) => procedure.procedure_id === procedureId) ?? null;
}

function consultationFor(
  taskId: string,
  expectedBaseCommit: string,
  specialist: SpecialistDefinition,
  procedures: ReadonlyArray<ProcedureDefinition>,
): SpecialistConsultationResult {
  const selectedProcedures = procedures.filter((procedure) =>
    procedure.owner_specialist_id === specialist.specialist_id
  );
  const withoutDigest: SpecialistConsultationResult = {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: taskId,
    specialist_id: specialist.specialist_id,
    expected_base_commit: expectedBaseCommit,
    paths: normalizeTaskPaths([...specialist.owned_paths, ...specialist.observed_paths]),
    contracts: sortedTaskStrings(specialist.contracts),
    patterns: sortedTaskStrings(specialist.patterns),
    pitfalls: sortedTaskStrings(specialist.pitfalls),
    procedures: selectedProcedures.map((procedure) => procedure.procedure_id).sort(),
    validation: sortedTaskStrings([
      ...specialist.validation_commands,
      ...selectedProcedures.flatMap((procedure) => procedure.validation_commands),
    ]),
    risks: specialist.pitfalls.slice(0, 32).map((pitfall, index) => ({
      finding_id: `${specialist.specialist_id}-risk-${index + 1}`,
      statement: redactTaskText(pitfall, 4_000),
      evidence_paths: normalizeTaskPaths(specialist.evidence_paths.slice(0, 32)),
      severity: "warning" as const,
    })),
    related_specialists: sortedTaskStrings(specialist.related_specialists),
    unresolved_questions: [],
    result_digest: "",
  };
  withoutDigest.result_digest = digestTaskValue({ ...withoutDigest, result_digest: undefined });
  return withoutDigest;
}

function admittedValidationCommands(
  policyCommands: ReadonlyArray<ValidationCommandSpec>,
  selectedProcedureDefinitions: ReadonlyArray<ProcedureDefinition>,
): ValidationCommandSpec[] {
  const procedureCommands = new Set(
    selectedProcedureDefinitions.flatMap((procedure) => procedure.validation_commands),
  );
  const admitted = policyCommands.filter((command) =>
    command.source === "repository-policy"
    || procedureCommands.has(command.argv.join(" "))
  );
  return admitted.map((command) => ({
    ...command,
    argv: [...command.argv],
  }));
}

function securityControls(protectedPaths: ReadonlyArray<string>) {
  return [
    {
      control_id: "authorized-issue",
      description: "Application work remains bound to the authorized issue, repository identity, and expected base commit.",
      enforcement: "policy" as const,
    },
    {
      control_id: "one-writable-builder",
      description: "Only one builder receives application-source write authority; orchestrator, specialists, and reviewer remain read-only.",
      enforcement: "policy" as const,
    },
    {
      control_id: "credential-separation",
      description: "Model processes receive no GitHub write credential; trusted workflow steps perform bounded mutations after schema validation.",
      enforcement: "policy" as const,
    },
    {
      control_id: "protected-paths",
      description: `Protected paths remain immutable: ${protectedPaths.join(", ") || "none configured"}.`,
      enforcement: "validation" as const,
    },
    {
      control_id: "independent-review",
      description: "The automated read-only reviewer must be role-separated from the builder and approve the stable validated commit.",
      enforcement: "review" as const,
    },
    {
      control_id: "draft-only-publication",
      description: "Publication may create one unmerged draft pull request only; merge, auto-merge, deployment, force-push, and default-branch application writes are forbidden.",
      enforcement: "validation" as const,
    },
  ];
}
export function loadCurrentSpecialistPortfolio(cwd: string) {
  const map = loadCanonicalMapAt(cwd, AUDIT_STATE_RELATIVE_DIR);
  if (map === null) throw new Error("canonical codebase map is unavailable for specialist routing");
  // Only the installed task policy establishes which commands were verified.
  // Without this the runtime would take commands straight from free-form audit
  // fields, so an audited `build.command` the repository never declared could
  // reach specialist definitions, procedures, and model context.
  const attested = attestedValidationCommands(cwd);
  if (attested.length === 0) {
    throw new Error(
      "no attested validation command is available for specialist routing; "
      + "the repository task policy must be configured before planning",
    );
  }
  // The map describes the commit that was audited, not whatever HEAD is now.
  // Stamping the current head onto a portfolio derived from an older map makes
  // a stale portfolio look current to every downstream freshness check.
  const auditedCommit = installedAuditCommit(cwd);
  if (auditedCommit === null) {
    throw new Error(
      "no installed specialist records establish which commit the repository knowledge was audited at; "
      + "rerun the installer before planning",
    );
  }
  const head = readGitHeadCommit(cwd);
  if (auditedCommit !== head) {
    const affected = changedPathsAffectingAudit(cwd, auditedCommit, head, map);
    if (affected.length > 0) {
      throw new Error(
        `specialist knowledge was audited at ${auditedCommit} and ${affected.length} path(s) it covers `
        + `changed since (${affected.slice(0, 5).join(", ")}); rerun the repository audit before planning`,
      );
    }
  }
  return discoverSpecialistPortfolio(
    map,
    auditedCommit,
    listTrackedFilesAtCommit(cwd, auditedCommit),
    attested,
  );
}

/** The commit the installed specialist records were derived from. */
function installedAuditCommit(cwd: string): string | null {
  try {
    const commits = new Set(
      listAgentIdentities(cwd)
        .filter((identity) => identity.role === "specialist" && identity.status === "active")
        .map((identity) => identity.supporting_commit),
    );
    return commits.size === 1 ? [...commits][0]! : null;
  } catch {
    return null;
  }
}

/**
 * Paths that changed since the audit and that the recorded knowledge covers.
 * A change outside the audited surface does not invalidate the portfolio; a
 * change inside it does, and a newly added file is treated as invalidating
 * because no audit has ever seen it.
 */
function changedPathsAffectingAudit(
  cwd: string,
  auditedCommit: string,
  head: string,
  map: CodebaseMap,
): string[] {
  const diff = spawnSync(
    "git",
    ["-C", cwd, "diff", "--name-only", "--no-renames", `${auditedCommit}..${head}`],
    { encoding: "utf-8", windowsHide: true },
  );
  // An unresolvable range means the audit's base is gone; treat it as stale.
  if (diff.status !== 0) return ["<audited commit is unreachable>"];
  const changed = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (changed.length === 0) return [];
  const audited = new Set(listTrackedFilesAtCommit(cwd, auditedCommit));
  const covered = new Set([
    ...map.skeleton.entry_points.map((entry) => entry.path),
    ...map.module_graph.edges.flatMap((edge) => [edge.from, edge.to]),
    ...map.module_graph.shared_abstractions,
  ]);
  return changed.filter((candidate) =>
    !audited.has(candidate)
    || covered.has(candidate)
    || [...covered].some((scope) => candidate.startsWith(`${scope}/`))
  );
}

/** Validation commands the installer attested in the repository task policy. */
function attestedValidationCommands(cwd: string): string[] {
  const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
  if (!fs.existsSync(policyPath)) return [];
  try {
    const configuration = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
      configured?: unknown;
      policy?: { validation_commands?: unknown } | null;
    };
    if (configuration.configured !== true) return [];
    const entries = configuration.policy?.validation_commands;
    if (!Array.isArray(entries)) return [];
    const commands = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const argv = (entry as { argv?: unknown }).argv;
      if (
        !Array.isArray(argv)
        || argv.length === 0
        || !argv.every((argument) => typeof argument === "string" && argument.trim().length > 0)
      ) return [];
      return [argv.join(" ")];
    });
    return [...new Set(commands)].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}


export function buildPlannerRefinementRequest(input: {
  draft_plan: OrchestratorPlan;
}): PlannerRefinementRequest {
  const plan = input.draft_plan;
  return {
    task_id: plan.task_id,
    issue_number: plan.issue_number,
    expected_base_commit: plan.expected_base_commit,
    task_summary: plan.task_summary,
    acceptance_criteria: plan.acceptance_criteria.map((criterion) => ({ ...criterion })),
    candidate_paths: [...plan.in_scope_paths],
    excluded_paths: [...plan.excluded_paths],
    draft_implementation_steps: plan.implementation_steps.map((step) => ({
      ...step,
      in_scope_paths: [...step.in_scope_paths],
      required_procedure_ids: [...step.required_procedure_ids],
      validation_command_ids: [...step.validation_command_ids],
    })),
  };
}

export function buildSpecialistConsultationRequest(input: {
  portfolio: TaskPlanningInput["portfolio"];
  plan: OrchestratorPlan;
  specialist_id: string;
}): SpecialistConsultationRequest {
  if (input.portfolio.supporting_commit !== input.plan.expected_base_commit) {
    throw new Error("specialist consultation portfolio is stale for the approved plan base");
  }
  if (!input.plan.selected_specialists.some((selection) => selection.specialist_id === input.specialist_id)) {
    throw new Error(`specialist ${input.specialist_id} is outside the approved routing plan`);
  }
  const specialist = input.portfolio.specialists.find((candidate) =>
    candidate.specialist_id === input.specialist_id
  );
  if (!specialist) throw new Error(`approved specialist ${input.specialist_id} is unavailable`);
  const selectedProcedureIds = new Set(
    input.plan.selected_procedures.map((selection) => selection.procedure_id),
  );
  const selectedProcedures = input.portfolio.procedures
    .filter((procedure) =>
      selectedProcedureIds.has(procedure.procedure_id)
      && (procedure.owner_specialist_id === input.specialist_id
        || procedure.required_context_paths.some((scope) =>
          input.plan.in_scope_paths.some((candidate) =>
            pathWithinTaskScope(candidate, scope) || pathWithinTaskScope(scope, candidate)
          )
        ))
    )
    .slice(0, 64);
  return {
    task_id: input.plan.task_id,
    issue_number: input.plan.issue_number,
    expected_base_commit: input.plan.expected_base_commit,
    specialist,
    selected_procedures: selectedProcedures,
    bounded_context_paths: normalizeTaskPaths([
      ...input.plan.in_scope_paths,
      ...specialist.owned_paths,
      ...specialist.observed_paths,
      ...selectedProcedures.flatMap((procedure) => procedure.required_context_paths),
    ]).slice(0, 128),
    task_summary: input.plan.task_summary,
    acceptance_criteria: input.plan.acceptance_criteria.map((criterion) => ({ ...criterion })),
  };
}

export function buildOrchestratorPlan(
  input: TaskPlanningInput,
  dependencies: {
    learningContext?: typeof learningContext;
  } = {},
): TaskPlanningResult {
  if (input.portfolio.supporting_commit !== input.expected_base_commit) {
    throw new Error("specialist portfolio is stale for the expected task base commit");
  }
  const candidatePaths = normalizeTaskPaths(input.candidate_paths);
  const policyWritePaths = normalizeTaskPaths(input.policy.allowed_write_paths, "policy write path");
  const protectedPaths = normalizeTaskPaths([
    ...TASK_RUNTIME_PROTECTED_PATHS,
    ...input.policy.protected_paths,
    ...input.excluded_paths,
  ]);
  if (candidatePaths.length === 0) {
    throw new Error("orchestrator plan has no bounded application write scope");
  }
  for (const candidatePath of candidatePaths) {
    if (!policyWritePaths.some((scope) => pathWithinTaskScope(candidatePath, scope))) {
      throw new Error(`orchestrator plan path ${candidatePath} is outside repository policy write authority`);
    }
    const protectedOverlap = protectedPaths.find((scope) =>
      pathWithinTaskScope(candidatePath, scope) || pathWithinTaskScope(scope, candidatePath)
    );
    if (protectedOverlap) {
      throw new Error(`orchestrator plan path ${candidatePath} overlaps protected runtime path ${protectedOverlap}`);
    }
  }
  const routing = routeSpecialistPortfolio(input.portfolio, {
    task_description: input.task_summary,
    candidate_paths: candidatePaths,
    contracts: input.acceptance_criteria.map((criterion) => criterion.statement),
    risk_category: input.risk_category,
    prior_successful_specialist_ids: input.prior_successful_specialist_ids,
  });
  const specialistIds = routing.selected_specialists.map((selection) => selection.specialist_id);
  const procedureIds = routing.selected_procedures.map((selection) => selection.procedure_id);
  const definitions = input.portfolio.specialists.filter((specialist) =>
    specialistIds.includes(specialist.specialist_id)
  );
  const selectedProcedureDefinitions = procedureIds
    .map((procedureId) => procedureById(input.portfolio.procedures, procedureId))
    .filter((procedure): procedure is ProcedureDefinition => procedure !== null);
  const memory = (dependencies.learningContext ?? learningContext)(
    input.cwd,
    candidatePaths,
    specialistIds,
  );
  const consultations = definitions.map((specialist) =>
    consultationFor(input.task_id, input.expected_base_commit, specialist, selectedProcedureDefinitions)
  );
  const validationCommands = admittedValidationCommands(
    input.policy.validation_commands,
    selectedProcedureDefinitions,
  );
  if (validationCommands.length === 0) {
    throw new Error("orchestrator plan has no policy-admitted deterministic validation command");
  }
  const estimatedModelCalls = Math.min(
    input.policy.maximum_model_calls,
    3 + definitions.length + (2 * input.policy.maximum_fix_cycles),
  );
  const estimatedPerCall = input.policy.maximum_cost_usd / input.policy.maximum_model_calls;
  const estimatedCost = Math.min(
    input.policy.maximum_cost_usd,
    Number((estimatedModelCalls * estimatedPerCall).toFixed(6)),
  );
  const withoutDigest: OrchestratorPlan = {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: input.task_id,
    repository: { ...input.repository },
    issue_number: input.issue_number,
    expected_base_commit: input.expected_base_commit,
    task_summary: redactTaskText(input.task_summary, 8_000),
    acceptance_criteria: input.acceptance_criteria.map((criterion) => ({
      ...criterion,
      statement: redactTaskText(criterion.statement, 4_000),
      verification: redactTaskText(criterion.verification, 4_000),
    })),
    in_scope_paths: candidatePaths,
    excluded_paths: normalizeTaskPaths(input.excluded_paths),
    selected_specialists: selectedSpecialists(routing),
    selected_procedures: selectedProcedures(routing),
    implementation_steps: input.implementation_steps.map((step) => ({
      ...step,
      description: redactTaskText(step.description, 4_000),
      in_scope_paths: normalizeTaskPaths(step.in_scope_paths),
      required_procedure_ids: sortedTaskStrings(step.required_procedure_ids),
      validation_command_ids: sortedTaskStrings(step.validation_command_ids),
    })),
    validation_commands: validationCommands,
    security_controls: securityControls(protectedPaths),
    risk_category: input.risk_category,
    migration_implications: input.risk_category === "high" || input.risk_category === "critical"
      ? ["Escalate any schema, dependency, infrastructure, or data migration before builder mutation."]
      : [],
    documentation_expectations: ["Update maintained architecture or operator documentation when behavior or trust boundaries change."],
    approval_required: input.policy.approval_required,
    estimated_model_calls: estimatedModelCalls,
    estimated_cost_usd: estimatedCost,
    escalation_conditions: sortedTaskStrings([
      "expected base commit changes",
      "plan or policy digest changes",
      "protected path or dependency changes are required",
      "validation is unavailable or mutates the repository",
      "reviewer returns blocked or unsafe",
      "budget, deadline, retry, or fix-cycle bound is exhausted",
      ...input.portfolio.warnings,
      ...routing.unmatched_signals.map((signal) => `unmatched routing signal: ${signal}`),
    ]),
    memory_record_ids: memory.records.filter((record) => record.freshness === "current").map((record) => record.memory_id).sort(),
    memory_excerpts: memory.records.filter((record) => record.freshness === "current").map((record) => ({
      memory_id: record.memory_id,
      kind: record.kind,
      owning_agent_id: record.owning_agent_id,
      statement: redactTaskText(record.statement, 4_000),
      freshness: "current" as const,
      context_role: record.kind === "episode" ? "prior-episode" as const : "active-guidance" as const,
      relevant_payload: redactTaskText(JSON.stringify(record.payload), 8_000),
      evidence_ids: record.evidence.map((entry) => entry.evidence_id).sort().slice(0, 32),
      evidence_paths: normalizeTaskPaths(record.evidence.flatMap((entry) => entry.repository_path === null ? [] : [entry.repository_path])).slice(0, 64),
      supporting_commit: record.supporting_commit,
    })).sort((left, right) => left.memory_id.localeCompare(right.memory_id)),
    routing_digest: routing.task_digest,
    policy_digest: input.policy.policy_digest,
    created_at: input.now,
    plan_digest: "",
  };
  withoutDigest.plan_digest = digestTaskValue({ ...withoutDigest, plan_digest: undefined });
  return { plan: withoutDigest, routing, consultations };
}
