import * as path from "node:path";
import type { CodebaseMap } from "./schema/index.ts";
import {
  assessCoverageClosure,
  type CoverageClosureOptions,
} from "./coverage.ts";
import {
  assessSpecialistEvidence as assessMirrorSpecialistEvidence,
  reconcileSpecialistEvidence as reconcileMirrorSpecialistEvidence,
  type AuditCompletionResult,
  type SpecialistEvidenceAssessment,
} from "./specialist-completion-mirrors.ts";

export type {
  AuditCompletionResult,
  RejectedSpecialistConcern,
  SpecialistEvidenceAssessment,
} from "./specialist-completion-mirrors.ts";
export { specialistEvidenceRecorded } from "./specialist-completion-mirrors.ts";

const MIRROR_REASON_PREFIX =
  "tracked implementation/test subsystem mirrors are neither covered by a concern nor explicitly rejected: ";

function normalizeRejectionBase(value: string): string | null {
  const normalized = path.posix.normalize(
    value
      .trim()
      .replace(/^['"`]+|['"`,;]+$/g, "")
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, ""),
  );
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.startsWith("/")
  ) {
    return null;
  }
  return normalized;
}

function rejectionScope(value: string): { base: string; subtree: boolean } | null {
  const portable = value.trim().replaceAll("\\", "/");
  const subtree = portable.endsWith("/**") || portable.endsWith("/*") || portable.endsWith("/");
  const baseValue = subtree ? portable.replace(/\/(?:\*\*)?\*?\/?$/, "") : portable;
  const base = normalizeRejectionBase(baseValue);
  return base === null ? null : { base, subtree };
}

function rejectionCoversPath(
  rejection: NonNullable<CodebaseMap["concern_evidence"]>["not_concerns"][number],
  repositoryPath: string,
): boolean {
  const scope = rejectionScope(rejection.candidate);
  if (
    scope !== null
    && (
      repositoryPath === scope.base
      || (scope.subtree && repositoryPath.startsWith(`${scope.base}/`))
    )
  ) {
    return true;
  }
  return rejection.why_rejected.includes(repositoryPath);
}

/**
 * Apply explicit adjacent-concern rejections to repository-wide mirror
 * obligations. The underlying assessor already handles model-mentioned paths;
 * this layer closes the same contract for paths discovered independently from
 * the Git tree.
 */
export function assessSpecialistEvidence(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): SpecialistEvidenceAssessment {
  const assessed = assessMirrorSpecialistEvidence(map, options);
  if (
    assessed.source !== "concern_evidence"
    || assessed.uncovered_paths.length === 0
    || map.concern_evidence === undefined
    || map.concern_evidence.not_concerns.length === 0
  ) {
    return assessed;
  }

  const rejected = assessed.uncovered_paths.filter((repositoryPath) =>
    map.concern_evidence!.not_concerns.some((entry) =>
      rejectionCoversPath(entry, repositoryPath)
    )
  );
  if (rejected.length === 0) return assessed;

  const rejectedSet = new Set(rejected);
  const uncovered = assessed.uncovered_paths.filter((repositoryPath) =>
    !rejectedSet.has(repositoryPath)
  );
  const reasons = assessed.reasons.filter((reason) =>
    !reason.startsWith(MIRROR_REASON_PREFIX)
  );
  if (uncovered.length > 0) {
    reasons.push(
      `${MIRROR_REASON_PREFIX}${uncovered.slice(0, 12).join(", ")}${uncovered.length > 12 ? ", …" : ""}`,
    );
  }

  return {
    ...assessed,
    complete: reasons.length === 0 && uncovered.length === 0,
    reasons,
    exempted_paths: [...new Set([
      ...assessed.exempted_paths,
      ...rejected,
    ])].sort((left, right) => left.localeCompare(right)),
    uncovered_paths: uncovered,
  };
}

export function reconcileSpecialistEvidence(
  map: CodebaseMap,
  assessment: SpecialistEvidenceAssessment,
): CodebaseMap {
  return reconcileMirrorSpecialistEvidence(map, assessment);
}

export function assessAuditCompletion(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): AuditCompletionResult {
  const coverage = assessCoverageClosure(map, options);
  const specialistAssessment = assessSpecialistEvidence(map, options);
  return {
    coverage,
    specialistEvidenceRecorded: specialistAssessment.complete,
    complete: coverage.unresolved.length === 0 && specialistAssessment.complete,
  };
}
