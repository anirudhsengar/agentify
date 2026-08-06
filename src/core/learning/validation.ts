import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { TeamMemoryError } from "../memory/contracts.ts";
import { canonicalJson, sortedUniqueStrings } from "../memory/serialization.ts";
import type {
  AcceptedMergeEvent,
  AcceptedTaskEvidence,
  LearningPolicy,
  MergeLearningJournal,
  MergeLearningReport,
} from "./contracts.ts";
import {
  DEFAULT_LEARNING_RUNTIME_MS,
  MAX_LEARNING_ATTEMPTS,
  MAX_LEARNING_CANDIDATES,
  MAX_LEARNING_CHANGED_FILES,
  MAX_LEARNING_REVIEW_FEEDBACK,
} from "./contracts.ts";
import {
  AcceptedMergeEventSchema,
  AcceptedTaskEvidenceSchema,
  MergeLearningJournalSchema,
  MergeLearningReportSchema,
} from "./schema.ts";
import { digestCanonical } from "../memory/serialization.ts";

export function learningSchemaErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 12)
    .map((error) => {
      const detail = error as { path?: string; instancePath?: string; message: string };
      return `${detail.path || detail.instancePath || "(root)"}: ${detail.message}`;
    })
    .join("; ");
}

export function validateLearningSchema<T>(
  schema: TSchema,
  value: unknown,
  label: string,
): T {
  if (!Value.Check(schema, value)) {
    throw new TeamMemoryError(
      "invalid_input",
      `${label} failed schema validation: ${learningSchemaErrors(schema, value)}`,
    );
  }
  return value as T;
}

function assertNormalizedStrings(values: ReadonlyArray<string>, label: string): void {
  if (canonicalJson(sortedUniqueStrings(values)) !== canonicalJson(values)) {
    throw new TeamMemoryError("invalid_input", `${label} must be sorted, unique, and trimmed`);
  }
}

function assertFiniteTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TeamMemoryError("invalid_input", `${label} is not a valid timestamp`);
  }
}

export function validateAcceptedMergeEvent(value: unknown): AcceptedMergeEvent {
  const event = validateLearningSchema<AcceptedMergeEvent>(
    AcceptedMergeEventSchema,
    value,
    "accepted merge event",
  );
  if (event.accepted_commit === event.first_parent_commit) {
    throw new TeamMemoryError(
      "invalid_input",
      "accepted merge commit cannot equal its first parent",
    );
  }
  if (event.repository_id !== event.repository_id.trim()) {
    throw new TeamMemoryError("invalid_input", "repository ID must be trimmed");
  }
  if (event.actor !== event.actor.trim()) {
    throw new TeamMemoryError("invalid_input", "accepted merge actor must be trimmed");
  }
  assertFiniteTimestamp(event.accepted_at, "accepted_at");
  return event;
}

export function validateAcceptedTaskEvidence(value: unknown): AcceptedTaskEvidence {
  const evidence = validateLearningSchema<AcceptedTaskEvidence>(
    AcceptedTaskEvidenceSchema,
    value,
    "accepted task evidence",
  );
  assertNormalizedStrings(evidence.selected_specialist_ids, "selected specialist IDs");
  assertNormalizedStrings(evidence.selected_procedure_ids, "selected procedure IDs");
  assertNormalizedStrings(evidence.validation.commands, "validation commands");
  assertNormalizedStrings(evidence.validation.evidence_refs, "validation evidence refs");
  for (let index = 0; index < evidence.attempts.length; index += 1) {
    const attempt = evidence.attempts[index]!;
    if (attempt.sequence !== index + 1) {
      throw new TeamMemoryError(
        "invalid_input",
        "accepted task attempts must use contiguous sequence numbers starting at 1",
      );
    }
    if (attempt.result === "failed" && attempt.failure_category === null) {
      throw new TeamMemoryError(
        "invalid_input",
        `failed accepted task attempt ${attempt.sequence} requires a failure category`,
      );
    }
  }
  for (const feedback of evidence.review_feedback) {
    assertFiniteTimestamp(feedback.accepted_at, "review feedback accepted_at");
    if (
      feedback.actor !== feedback.actor.trim()
      || feedback.source_ref !== feedback.source_ref.trim()
      || feedback.statement !== feedback.statement.trim()
    ) {
      throw new TeamMemoryError("invalid_input", "review feedback must be trimmed");
    }
  }
  return evidence;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TeamMemoryError(
      "invalid_input",
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return resolved;
}

export function resolveLearningPolicy(
  input: Partial<LearningPolicy> | undefined,
): LearningPolicy {
  return {
    max_changed_files: boundedInteger(
      input?.max_changed_files,
      MAX_LEARNING_CHANGED_FILES,
      MAX_LEARNING_CHANGED_FILES,
      "max_changed_files",
    ),
    max_candidates: boundedInteger(
      input?.max_candidates,
      MAX_LEARNING_CANDIDATES,
      MAX_LEARNING_CANDIDATES,
      "max_candidates",
    ),
    max_attempts: boundedInteger(
      input?.max_attempts,
      MAX_LEARNING_ATTEMPTS,
      MAX_LEARNING_ATTEMPTS,
      "max_attempts",
    ),
    max_review_feedback: boundedInteger(
      input?.max_review_feedback,
      MAX_LEARNING_REVIEW_FEEDBACK,
      MAX_LEARNING_REVIEW_FEEDBACK,
      "max_review_feedback",
    ),
    max_runtime_ms: boundedInteger(
      input?.max_runtime_ms,
      DEFAULT_LEARNING_RUNTIME_MS,
      30 * 60 * 1000,
      "max_runtime_ms",
    ),
  };
}

export function validateLearningJournal(value: unknown): MergeLearningJournal {
  const journal = validateLearningSchema<MergeLearningJournal>(
    MergeLearningJournalSchema,
    value,
    "merge learning journal",
  );
  const { journal_digest: _digest, ...withoutDigest } = journal;
  if (digestCanonical(withoutDigest) !== journal.journal_digest) {
    throw new TeamMemoryError("corrupt_state", "merge learning journal digest mismatch");
  }
  if (Date.parse(journal.updated_at) < Date.parse(journal.started_at)) {
    throw new TeamMemoryError(
      "corrupt_state",
      "merge learning journal updated_at precedes started_at",
    );
  }
  return journal;
}

export function validateLearningReport(value: unknown): MergeLearningReport {
  return validateLearningSchema<MergeLearningReport>(
    MergeLearningReportSchema,
    value,
    "merge learning report",
  );
}
