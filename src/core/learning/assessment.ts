import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import {
  listMemoryRecords,
  type MemoryCandidateDraft,
  type MemoryRecord,
} from "../memory/index.ts";
import {
  digestCanonical,
  recordPaths,
  sortedUniqueStrings,
} from "../memory/serialization.ts";
import {
  assessExpertiseInvalidation,
  discoverSpecialistPortfolio,
  pathMatchesScope,
  specialistSlug,
} from "../specialists/index.ts";
import { listTrackedFilesAtCommit } from "../specialists/evidence.ts";
import { readInstalledTrustedValidationArgv } from "../specialists/trusted-commands.ts";
import type { SpecialistPortfolio } from "../specialists/contracts.ts";
import type {
  AcceptedMergeChange,
  AcceptedMergeEvent,
  AcceptedTaskEvidence,
  LearningAssessment,
  LearningPolicy,
} from "./contracts.ts";
import { MAX_LEARNING_EVIDENCE_REFERENCES } from "./contracts.ts";
import {
  acceptedChangedPaths,
  buildAcceptedMergeEvidence,
} from "./git.ts";
import { learningAuthorshipTag } from "./authorship.ts";
import { isKnowledgeOnlyChange } from "./knowledge-paths.ts";

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${digestCanonical(value).slice(0, 32)}`.slice(0, 128);
}

function loadCurrentPortfolio(
  cwd: string,
  supportingCommit: string,
): SpecialistPortfolio | null {
  const map = loadCanonicalMapAt(cwd, AUDIT_STATE_RELATIVE_DIR);
  if (map === null) return null;
  return discoverSpecialistPortfolio(
    map,
    supportingCommit,
    listTrackedFilesAtCommit(cwd, supportingCommit),
    { trustedValidationArgv: readInstalledTrustedValidationArgv(cwd) },
  );
}

function recordIntersectsChanges(
  record: MemoryRecord,
  changedPaths: ReadonlyArray<string>,
): boolean {
  return changedPaths.some((changedPath) =>
    recordPaths(record).some((dependency) => pathMatchesScope(changedPath, dependency))
  );
}

function affectedCurrentMemory(
  cwd: string,
  changedPaths: ReadonlyArray<string>,
  portfolio: SpecialistPortfolio | null,
): MemoryRecord[] {
  const affectedSpecialists = new Set<string>();
  const affectedProcedures = new Set<string>();
  if (portfolio !== null) {
    const invalidation = assessExpertiseInvalidation(portfolio, changedPaths);
    for (const id of invalidation.specialist_ids) affectedSpecialists.add(id);
    for (const id of invalidation.procedure_ids) {
      affectedProcedures.add(`procedure-${specialistSlug(id)}`);
    }
  }
  return listMemoryRecords(cwd, { freshness: "current" })
    .filter((record) => record.kind !== "policy")
    .filter((record) =>
      recordIntersectsChanges(record, changedPaths)
      || (record.kind === "specialist" && affectedSpecialists.has(record.owning_agent_id))
      || (record.kind === "procedure"
        && record.tags.some((tag) => affectedProcedures.has(tag)))
    )
    .sort((left, right) => left.memory_id.localeCompare(right.memory_id));
}

function mergeSummaryCandidate(
  event: AcceptedMergeEvent,
  changes: ReadonlyArray<AcceptedMergeChange>,
  taskEvidence: AcceptedTaskEvidence | null,
  evidence: MemoryCandidateDraft["evidence"],
  portfolio: SpecialistPortfolio | null,
): MemoryCandidateDraft | null {
  const paths = acceptedChangedPaths(changes);
  if (paths.length === 0) return null;
  const affectedContracts = portfolio === null
    ? []
    : sortedUniqueStrings(portfolio.specialists
        .filter((specialist) => paths.some((changedPath) =>
          specialist.freshness_dependencies.some((dependency) =>
            pathMatchesScope(changedPath, dependency)
          )
        ))
        .flatMap((specialist) => specialist.invariants.map((invariant) => invariant.rule)));
  const semantic = {
    accepted_commit: event.accepted_commit,
    paths,
    contracts: affectedContracts,
    validation: taskEvidence?.validation.commands ?? [],
  };
  const memoryId = stableId("accepted-merge", semantic);
  const draft = {
    schema_version: "1" as const,
    memory_id: memoryId,
    kind: "codebase" as const,
    proposed_by_agent_id: "orchestrator",
    owning_agent_id: "orchestrator",
    statement: `Accepted commit ${event.accepted_commit.slice(0, 12)} changed ${changes.length} repository path(s).`,
    source_type: "merged_code" as const,
    supporting_commit: event.accepted_commit,
    evidence: [...evidence],
    confidence: "verified" as const,
    dependent_paths: paths,
    invalidation_conditions: [
      "Revalidate if the accepted commit is reverted or any recorded path changes again.",
    ],
    contradicts: [],
    human_attribution: null,
    tags: sortedUniqueStrings([
      "accepted-merge",
      `commit-${event.accepted_commit.slice(0, 16)}`,
      learningAuthorshipTag(event.author_kind),
    ]),
    proposed_at: event.accepted_at,
    payload: {
      subject: `accepted-merge-${event.accepted_commit.slice(0, 16)}`,
      paths,
      symbols: [],
      contracts: affectedContracts,
      relationships: [],
      validation_commands: sortedUniqueStrings(taskEvidence?.validation.commands ?? []),
    },
  };
  return {
    ...draft,
    candidate_id: stableId("candidate", draft),
  };
}

function reviewEvidence(
  event: AcceptedMergeEvent,
  taskEvidence: AcceptedTaskEvidence,
): MemoryCandidateDraft["evidence"] {
  return taskEvidence.review_feedback.map((feedback) => ({
    evidence_id: stableId("evidence-review", {
      accepted_commit: event.accepted_commit,
      source_ref: feedback.source_ref,
      statement: feedback.statement,
    }),
    source_type: "accepted_review_feedback" as const,
    repository_path: null,
    commit_sha: event.accepted_commit,
    sha256: null,
    line_start: null,
    line_end: null,
    external_ref: feedback.source_ref,
    description: feedback.statement,
    observed_at: feedback.accepted_at,
    actor: feedback.actor,
  }));
}

function episodeCandidate(
  event: AcceptedMergeEvent,
  taskEvidence: AcceptedTaskEvidence | null,
  mergeEvidence: MemoryCandidateDraft["evidence"],
  changedPaths: ReadonlyArray<string>,
): MemoryCandidateDraft | null {
  if (taskEvidence === null) return null;
  const attempts = taskEvidence.attempts.length > 0
    ? taskEvidence.attempts
    : [{
        sequence: 1,
        approach: "Accepted implementation",
        result: taskEvidence.validation.passed ? "succeeded" as const : "failed" as const,
        failure_category: taskEvidence.validation.passed ? null : "validation_failure",
        signal: taskEvidence.validation.commands.length > 0
          ? `Validation: ${taskEvidence.validation.commands.join(", ")}`
          : "Accepted task evidence",
        correction: null,
      }];
  const semantic = {
    task_id: taskEvidence.task_id,
    accepted_commit: event.accepted_commit,
    attempts,
    feedback: taskEvidence.review_feedback.map((entry) => entry.statement),
  };
  const memoryId = stableId("episode", semantic);
  const evidence = [...mergeEvidence, ...reviewEvidence(event, taskEvidence)]
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  const draft = {
    schema_version: "1" as const,
    memory_id: memoryId,
    kind: "episode" as const,
    proposed_by_agent_id: "orchestrator",
    owning_agent_id: "orchestrator",
    statement: `Accepted task ${taskEvidence.task_id} completed with ${attempts.length} recorded attempt(s).`,
    source_type: "merged_code" as const,
    supporting_commit: event.accepted_commit,
    evidence,
    confidence: taskEvidence.validation.passed ? "verified" as const : "high" as const,
    dependent_paths: [...changedPaths],
    invalidation_conditions: [],
    contradicts: [],
    human_attribution: null,
    tags: sortedUniqueStrings([
      "accepted-task-episode",
      `task-${specialistSlug(taskEvidence.task_id)}`,
      ...taskEvidence.selected_specialist_ids.map((id) => `specialist-${specialistSlug(id)}`),
    ]),
    proposed_at: event.accepted_at,
    payload: {
      task_id: specialistSlug(taskEvidence.task_id),
      issue_number: taskEvidence.issue_number,
      outcome: taskEvidence.validation.passed ? "success" as const : "partial" as const,
      attempts: attempts.map((attempt) => ({ ...attempt })),
      review_feedback: taskEvidence.review_feedback.map((entry) => entry.statement),
      generalization: taskEvidence.generalization,
      cost_usd: taskEvidence.cost_usd,
      runtime_ms: taskEvidence.runtime_ms,
    },
  };
  return {
    ...draft,
    candidate_id: stableId("candidate", draft),
  };
}

export function assessAcceptedMerge(input: {
  cwd: string;
  event: AcceptedMergeEvent;
  changes: AcceptedMergeChange[];
  taskEvidence: AcceptedTaskEvidence | null;
  policy: LearningPolicy;
}): LearningAssessment {
  const changedPaths = acceptedChangedPaths(input.changes);
  const evidence = buildAcceptedMergeEvidence(
    input.cwd,
    input.event,
    input.changes,
    Math.min(MAX_LEARNING_EVIDENCE_REFERENCES, input.policy.max_changed_files),
  );
  const portfolio = loadCurrentPortfolio(input.cwd, input.event.accepted_commit);
  const invalidation = portfolio === null
    ? { specialist_ids: [], procedure_ids: [], reasons: {} }
    : assessExpertiseInvalidation(portfolio, changedPaths);
  const affectedMemory = affectedCurrentMemory(input.cwd, changedPaths, portfolio);
  const generatedCandidates = [
    mergeSummaryCandidate(input.event, input.changes, input.taskEvidence, evidence, portfolio),
    episodeCandidate(input.event, input.taskEvidence, evidence, changedPaths),
  ].filter((candidate): candidate is MemoryCandidateDraft => candidate !== null);

  return {
    event_digest: digestCanonical(input.event),
    changes: input.changes,
    evidence,
    portfolio,
    invalidation,
    affected_memory: affectedMemory,
    generated_candidates: generatedCandidates,
    knowledge_only: isKnowledgeOnlyChange(input.changes),
  };
}
