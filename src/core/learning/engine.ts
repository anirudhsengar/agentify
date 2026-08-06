import * as fs from "node:fs";
import * as path from "node:path";
import {
  acceptMemoryCandidate,
  hasRecognizedManifestMarker,
  listMemoryRecords,
  markMemoryStale,
  proposeMemoryCandidate,
  readTeamMemoryManifest,
  type MemoryCandidate,
  type MemoryCandidateDraft,
  type MemoryRecord,
} from "../memory/index.ts";
import { TeamMemoryError } from "../memory/contracts.ts";
import {
  errorCode,
  readRelativeJson,
  refreshManifestInternal,
  repositoryRoot,
  resolveExistingSafeFile,
  writeJsonAtomic,
} from "../memory/persistence.ts";
import { digestCanonical, sortedUniqueStrings } from "../memory/serialization.ts";
import { synchronizeRepositorySpecialists } from "../specialists/index.ts";
import { assessAcceptedMerge } from "./assessment.ts";
import type {
  AcceptedLearningCandidateResult,
  AcceptedMergeEvent,
  AcceptedTaskEvidence,
  LearningAssessment,
  LearningPolicy,
  LearningRuntimeOptions,
  MergeLearningJournal,
  MergeLearningPhase,
  MergeLearningReport,
  ProcessAcceptedMergeInput,
} from "./contracts.ts";
import { LEARNING_SCHEMA_VERSION } from "./contracts.ts";
import { acceptedChangedPaths, inspectAcceptedMerge } from "./git.ts";
import { isKnowledgeOnlyChange } from "./knowledge-paths.ts";
import {
  resolveLearningPolicy,
  validateAcceptedMergeEvent,
  validateAcceptedTaskEvidence,
  validateLearningJournal,
  validateLearningReport,
} from "./validation.ts";

function learningRunTag(commit: string): string {
  return `learning-run-${commit}`;
}

function learningJournalRelativePath(commit: string): string {
  return `.agentify/state-transactions/merge-learning-${commit}.json`;
}

function timestamp(options: LearningRuntimeOptions | undefined): string {
  return (options?.now ?? (() => new Date()))().toISOString();
}

function assertWithinDeadline(startedMs: number, policy: LearningPolicy): void {
  if (Date.now() - startedMs > policy.max_runtime_ms) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `merge learning exceeded the ${policy.max_runtime_ms}ms runtime limit`,
    );
  }
}

function createJournal(
  event: AcceptedMergeEvent,
  phase: MergeLearningPhase,
  startedAt: string,
  updatedAt: string,
): MergeLearningJournal {
  const withoutDigest = {
    format: "agentify_merge_learning_transaction" as const,
    schema_version: LEARNING_SCHEMA_VERSION,
    event_digest: digestCanonical(event),
    accepted_commit: event.accepted_commit,
    expected_repository_head: event.expected_repository_head,
    repository_id: event.repository_id,
    phase,
    started_at: startedAt,
    updated_at: updatedAt,
  };
  return {
    ...withoutDigest,
    journal_digest: digestCanonical(withoutDigest),
  };
}

function readJournalIfPresent(cwd: string, commit: string): MergeLearningJournal | null {
  const relativePath = learningJournalRelativePath(commit);
  try {
    return validateLearningJournal(readRelativeJson(cwd, relativePath));
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") return null;
    throw error;
  }
}

function writeJournal(
  cwd: string,
  event: AcceptedMergeEvent,
  phase: MergeLearningPhase,
  startedAt: string,
  options: LearningRuntimeOptions | undefined,
): MergeLearningJournal {
  const journal = createJournal(event, phase, startedAt, timestamp(options));
  writeJsonAtomic(
    cwd,
    learningJournalRelativePath(event.accepted_commit),
    journal,
    options?.memory,
  );
  options?.afterPhase?.(phase);
  return journal;
}

function removeJournal(cwd: string, commit: string): void {
  try {
    fs.unlinkSync(resolveExistingSafeFile(cwd, learningJournalRelativePath(commit)));
  } catch (error) {
    if (error instanceof TeamMemoryError && error.code === "not_found") return;
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

function assertJournalCompatible(
  journal: MergeLearningJournal,
  event: AcceptedMergeEvent,
): void {
  if (
    journal.event_digest !== digestCanonical(event)
    || journal.repository_id !== event.repository_id
    || journal.accepted_commit !== event.accepted_commit
    || journal.expected_repository_head !== event.expected_repository_head
  ) {
    throw new TeamMemoryError(
      "corrupt_state",
      `merge learning journal does not match accepted commit ${event.accepted_commit}`,
    );
  }
}

function completedLearningRecord(cwd: string, acceptedCommit: string): MemoryRecord | null {
  return listMemoryRecords(cwd, {
    kind: "orchestrator",
    tag: learningRunTag(acceptedCommit),
  }).find((record) =>
    record.kind === "orchestrator"
    && record.payload.routing_key === `merge-${acceptedCommit.slice(0, 32)}`
  ) ?? null;
}

function assertTaskEvidenceMatchesEvent(
  event: AcceptedMergeEvent,
  evidence: AcceptedTaskEvidence,
): void {
  if (
    event.pull_request_number !== null
    && evidence.pull_request_number !== null
    && event.pull_request_number !== evidence.pull_request_number
  ) {
    throw new TeamMemoryError(
      "invalid_input",
      "accepted task evidence pull request does not match the merge event",
    );
  }
  if (
    event.issue_number !== null
    && evidence.issue_number !== null
    && event.issue_number !== evidence.issue_number
  ) {
    throw new TeamMemoryError(
      "invalid_input",
      "accepted task evidence issue does not match the merge event",
    );
  }
}

function mergeCandidateInputs(
  assessment: LearningAssessment,
  externalDrafts: ReadonlyArray<MemoryCandidateDraft>,
  event: AcceptedMergeEvent,
  policy: LearningPolicy,
): MemoryCandidateDraft[] {
  const combined = [...assessment.generated_candidates, ...externalDrafts];
  if (combined.length + 1 > policy.max_candidates) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `merge learning proposed more than ${policy.max_candidates} candidates`,
    );
  }
  for (const draft of externalDrafts) {
    if (draft.kind === "policy") {
      throw new TeamMemoryError(
        "policy_violation",
        "automatic merge learning cannot propose policy memory",
      );
    }
    if (draft.supporting_commit !== event.accepted_commit) {
      throw new TeamMemoryError(
        "invalid_input",
        `candidate ${draft.candidate_id} is not bound to the accepted commit`,
      );
    }
    if (
      draft.source_type === "maintainer_instruction"
      || draft.source_type === "architecture_decision"
      || draft.source_type === "accepted_review_feedback"
      || draft.source_type === "validated_bootstrap"
    ) {
      throw new TeamMemoryError(
        "policy_violation",
        `automatic merge learning cannot trust candidate source ${draft.source_type}`,
      );
    }
    if (
      draft.evidence.length === 0
      || draft.evidence.some((entry) =>
        entry.commit_sha !== event.accepted_commit
        || entry.repository_path === null
        || entry.sha256 === null
      )
    ) {
      throw new TeamMemoryError(
        "invalid_input",
        `candidate ${draft.candidate_id} requires exact accepted-commit Git blob evidence`,
      );
    }
  }
  const byCandidate = new Map<string, MemoryCandidateDraft>();
  for (const draft of combined) {
    const existing = byCandidate.get(draft.candidate_id);
    if (existing && digestCanonical(existing) !== digestCanonical(draft)) {
      throw new TeamMemoryError(
        "invalid_input",
        `candidate ID ${draft.candidate_id} has conflicting learning proposals`,
      );
    }
    byCandidate.set(draft.candidate_id, draft);
  }
  return [...byCandidate.values()].sort((left, right) =>
    left.candidate_id.localeCompare(right.candidate_id)
  );
}

function knowledgeOnlyReport(
  event: AcceptedMergeEvent,
  changes: MergeLearningReport["changes"],
): MergeLearningReport {
  return validateLearningReport({
    schema_version: LEARNING_SCHEMA_VERSION,
    status: "knowledge-only",
    event_digest: digestCanonical(event),
    accepted_commit: event.accepted_commit,
    expected_repository_head: event.expected_repository_head,
    changes,
    invalidation: {
      stale_memory_ids: [],
      already_inactive_memory_ids: [],
      expertise: { specialist_ids: [], procedure_ids: [], reasons: {} },
    },
    candidates: [],
    specialist_sync: "not-requested",
    learning_run_memory_id: `knowledge-noop-${event.accepted_commit.slice(0, 32)}`,
    metrics: {
      changed_file_count: changes.length,
      candidate_count: 0,
      stale_memory_count: 0,
      accepted_memory_count: 0,
      elapsed_ms: 0,
      cost_usd: null,
    },
  });
}

function staleAffectedMemory(
  cwd: string,
  assessment: LearningAssessment,
  event: AcceptedMergeEvent,
  options: LearningRuntimeOptions | undefined,
): { stale: string[]; inactive: string[] } {
  const stale: string[] = [];
  const inactive: string[] = [];
  for (const affected of assessment.affected_memory) {
    let current: MemoryRecord | null = null;
    try {
      current = listMemoryRecords(cwd).find((record) => record.memory_id === affected.memory_id) ?? null;
    } catch (error) {
      if (error instanceof TeamMemoryError && error.code === "not_found") continue;
      throw error;
    }
    if (current === null) continue;
    if (current.freshness !== "current") {
      inactive.push(current.memory_id);
      continue;
    }
    const next = markMemoryStale(cwd, current.memory_id, {
      actor: "knowledge-maintainer",
      expectedRevision: current.revision,
      evidence: assessment.evidence,
      supportingCommit: event.accepted_commit,
      reason: `accepted commit ${event.accepted_commit} changed a freshness dependency`,
      options: options?.memory,
    });
    stale.push(next.memory_id);
  }
  return {
    stale: sortedUniqueStrings(stale),
    inactive: sortedUniqueStrings(inactive),
  };
}

function acceptDrafts(
  cwd: string,
  drafts: ReadonlyArray<MemoryCandidateDraft>,
  options: LearningRuntimeOptions | undefined,
): AcceptedLearningCandidateResult[] {
  const results: AcceptedLearningCandidateResult[] = [];
  for (const draft of drafts) {
    const alreadyAccepted = listMemoryRecords(cwd)
      .some((record) => record.accepted_candidate_ids.includes(draft.candidate_id));
    const candidate: MemoryCandidate = proposeMemoryCandidate(draft);
    const record = acceptMemoryCandidate(
      cwd,
      candidate,
      "knowledge-maintainer",
      `accept learning candidate ${candidate.candidate_id}`,
      options?.memory,
    );
    results.push({
      candidate_id: candidate.candidate_id,
      memory_id: record.memory_id,
      kind: record.kind,
      owning_agent_id: record.owning_agent_id,
      status: alreadyAccepted ? "already-accepted" : "accepted",
    });
  }
  return results.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
}

function learningRunDraft(
  event: AcceptedMergeEvent,
  assessment: LearningAssessment,
  taskEvidence: AcceptedTaskEvidence | null,
  staleMemoryIds: ReadonlyArray<string>,
  acceptedCandidates: ReadonlyArray<AcceptedLearningCandidateResult>,
): MemoryCandidateDraft {
  const changedPaths = acceptedChangedPaths(assessment.changes);
  const selectedSpecialists = sortedUniqueStrings([
    ...assessment.invalidation.specialist_ids,
    ...(taskEvidence?.selected_specialist_ids ?? []),
  ]);
  const semantic = {
    accepted_commit: event.accepted_commit,
    event_digest: assessment.event_digest,
    changed_paths: changedPaths,
    stale_memory_ids: [...staleMemoryIds],
    accepted_candidate_ids: acceptedCandidates.map((entry) => entry.candidate_id),
  };
  const memoryId = `learning-${digestCanonical(semantic).slice(0, 32)}`;
  const draft = {
    schema_version: "1" as const,
    memory_id: memoryId,
    kind: "orchestrator" as const,
    proposed_by_agent_id: "orchestrator",
    owning_agent_id: "orchestrator",
    statement: `Knowledge-maintainer processing completed for accepted commit ${event.accepted_commit.slice(0, 12)}.`,
    source_type: "merged_code" as const,
    supporting_commit: event.accepted_commit,
    evidence: [...assessment.evidence],
    confidence: "verified" as const,
    dependent_paths: changedPaths,
    invalidation_conditions: [],
    contradicts: [],
    human_attribution: null,
    tags: sortedUniqueStrings([
      "learning-run",
      learningRunTag(event.accepted_commit),
      event.author_kind === "agentify" ? "agentify-authored" : "human-authored",
    ]),
    proposed_at: event.accepted_at,
    payload: {
      routing_key: `merge-${event.accepted_commit.slice(0, 32)}`,
      issue_signals: sortedUniqueStrings([
        ...changedPaths.map((value) => `changed:${value}`),
        ...staleMemoryIds.map((value) => `stale:${value}`),
      ]).slice(0, 128),
      selected_specialists: selectedSpecialists.slice(0, 64),
      risk_category: taskEvidence?.risk_category ?? "low",
      outcome: "successful" as const,
      validation_policy: sortedUniqueStrings(
        taskEvidence?.validation.commands.length
          ? taskEvidence.validation.commands
          : ["accepted commit and Git evidence verified"],
      ).slice(0, 64),
      cost_usd: taskEvidence?.cost_usd ?? null,
      runtime_ms: taskEvidence?.runtime_ms ?? null,
    },
  };
  return {
    ...draft,
    candidate_id: `candidate-${digestCanonical(draft).slice(0, 32)}`,
  };
}

function specialistSyncStatus(
  cwd: string,
  assessment: LearningAssessment,
): MergeLearningReport["specialist_sync"] {
  if (assessment.portfolio === null) return "map-absent";
  const stateMapChanged = assessment.changes.some((change) =>
    change.path.endsWith("/codebase_map.json") || change.path.endsWith("/codebase-map.json")
  );
  if (!stateMapChanged) return "not-requested";
  const result = synchronizeRepositorySpecialists(cwd);
  return result.status === "synchronized"
    ? "synchronized"
    : result.status === "memory_absent"
      ? "memory-absent"
      : "map-absent";
}

function alreadyProcessedReport(
  event: AcceptedMergeEvent,
  changes: MergeLearningReport["changes"],
  record: MemoryRecord,
): MergeLearningReport {
  return validateLearningReport({
    schema_version: LEARNING_SCHEMA_VERSION,
    status: "already-processed",
    event_digest: digestCanonical(event),
    accepted_commit: event.accepted_commit,
    expected_repository_head: event.expected_repository_head,
    changes,
    invalidation: {
      stale_memory_ids: [],
      already_inactive_memory_ids: [],
      expertise: { specialist_ids: [], procedure_ids: [], reasons: {} },
    },
    candidates: [],
    specialist_sync: "not-requested",
    learning_run_memory_id: record.memory_id,
    metrics: {
      changed_file_count: changes.length,
      candidate_count: 0,
      stale_memory_count: 0,
      accepted_memory_count: 0,
      elapsed_ms: 0,
      cost_usd: null,
    },
  });
}

export function processAcceptedMerge(
  input: ProcessAcceptedMergeInput,
): MergeLearningReport {
  const startedMs = Date.now();
  const event = validateAcceptedMergeEvent(input.event);
  const taskEvidence = input.task_evidence === undefined || input.task_evidence === null
    ? null
    : validateAcceptedTaskEvidence(input.task_evidence);
  if (taskEvidence !== null) assertTaskEvidenceMatchesEvent(event, taskEvidence);
  const policy = resolveLearningPolicy(input.policy);

  if (!hasRecognizedManifestMarker(input.cwd)) {
    throw new TeamMemoryError("not_initialized", "persistent team memory is not initialized");
  }
  const manifest = readTeamMemoryManifest(input.cwd);
  if (manifest.repository_id !== event.repository_id) {
    throw new TeamMemoryError(
      "policy_violation",
      `merge event targets ${event.repository_id}, but memory belongs to ${manifest.repository_id}`,
    );
  }

  const changes = inspectAcceptedMerge(input.cwd, event, policy);
  if (isKnowledgeOnlyChange(changes)) {
    removeJournal(input.cwd, event.accepted_commit);
    return knowledgeOnlyReport(event, changes);
  }
  const completed = completedLearningRecord(input.cwd, event.accepted_commit);
  if (completed !== null) {
    removeJournal(input.cwd, event.accepted_commit);
    return alreadyProcessedReport(event, changes, completed);
  }

  const existingJournal = readJournalIfPresent(input.cwd, event.accepted_commit);
  const startedAt = existingJournal?.started_at ?? timestamp(input.options);
  if (existingJournal !== null) assertJournalCompatible(existingJournal, event);
  writeJournal(input.cwd, event, "bound", startedAt, input.options);
  assertWithinDeadline(startedMs, policy);

  const assessment = assessAcceptedMerge({
    cwd: input.cwd,
    event,
    changes,
    taskEvidence,
    policy,
  });
  writeJournal(input.cwd, event, "assessed", startedAt, input.options);
  assertWithinDeadline(startedMs, policy);

  const stale = assessment.knowledge_only
    ? { stale: [], inactive: [] }
    : staleAffectedMemory(input.cwd, assessment, event, input.options);
  writeJournal(input.cwd, event, "invalidated", startedAt, input.options);
  assertWithinDeadline(startedMs, policy);

  const drafts = mergeCandidateInputs(
    assessment,
    input.candidate_drafts ?? [],
    event,
    policy,
  );
  const accepted = assessment.knowledge_only
    ? []
    : acceptDrafts(input.cwd, drafts, input.options);
  writeJournal(input.cwd, event, "candidates-accepted", startedAt, input.options);
  assertWithinDeadline(startedMs, policy);

  const syncStatus = assessment.knowledge_only
    ? "not-requested"
    : specialistSyncStatus(input.cwd, assessment);
  writeJournal(input.cwd, event, "specialists-refreshed", startedAt, input.options);
  assertWithinDeadline(startedMs, policy);

  const runCandidate = proposeMemoryCandidate(learningRunDraft(
    event,
    assessment,
    taskEvidence,
    stale.stale,
    accepted,
  ));
  const runRecord = acceptMemoryCandidate(
    input.cwd,
    runCandidate,
    "knowledge-maintainer",
    `record completed merge learning for ${event.accepted_commit}`,
    input.options?.memory,
  );
  writeJournal(input.cwd, event, "recorded", startedAt, input.options);
  refreshManifestInternal(input.cwd, input.options?.memory);
  removeJournal(input.cwd, event.accepted_commit);

  const report: MergeLearningReport = {
    schema_version: LEARNING_SCHEMA_VERSION,
    status: assessment.knowledge_only ? "knowledge-only" : "processed",
    event_digest: assessment.event_digest,
    accepted_commit: event.accepted_commit,
    expected_repository_head: event.expected_repository_head,
    changes: assessment.changes,
    invalidation: {
      stale_memory_ids: stale.stale,
      already_inactive_memory_ids: stale.inactive,
      expertise: assessment.invalidation,
    },
    candidates: [
      ...accepted,
      {
        candidate_id: runCandidate.candidate_id,
        memory_id: runRecord.memory_id,
        kind: runRecord.kind,
        owning_agent_id: runRecord.owning_agent_id,
        status: "accepted",
      },
    ],
    specialist_sync: syncStatus,
    learning_run_memory_id: runRecord.memory_id,
    metrics: {
      changed_file_count: assessment.changes.length,
      candidate_count: accepted.length + 1,
      stale_memory_count: stale.stale.length,
      accepted_memory_count: accepted.length + 1,
      elapsed_ms: Math.max(0, Date.now() - startedMs),
      cost_usd: taskEvidence?.cost_usd ?? null,
    },
  };
  return validateLearningReport(report);
}

export function assertNoLearningJournal(cwd: string): void {
  const directory = path.join(repositoryRoot(cwd), ".agentify", "state-transactions");
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const remaining = entries.filter((entry) => entry.startsWith("merge-learning-"));
  if (remaining.length > 0) {
    throw new TeamMemoryError(
      "corrupt_state",
      `merge learning left transaction journal(s): ${remaining.join(", ")}`,
    );
  }
}
