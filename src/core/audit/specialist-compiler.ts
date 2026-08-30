import type { CoverageClosureOptions } from "./coverage.ts";
import type { CodebaseMap } from "./schema/index.ts";
import {
  assessSpecialistEvidence,
  removeTrustedInferredAttachments,
  reconcileAuxiliaryDuplicateConcerns,
  reconcileExplicitlyRetainedCandidates,
  reconcileScoutConcernIdentities,
  reconcileSpecialistEvidence,
  type SpecialistEvidenceAssessment,
} from "./specialist-completion.ts";

const MAX_SPECIALIST_COMPILATION_ITERATIONS = 8;

export type SpecialistCompilationStatus =
  | "compiled"
  | "incomplete"
  | "non-convergent";

export type SpecialistCompilationPhase =
  | "evidence"
  | "post-normalization"
  | "fixed-point";

export interface SpecialistCompilationResult {
  status: SpecialistCompilationStatus;
  complete: boolean;
  phase: SpecialistCompilationPhase;
  map: CodebaseMap;
  assessment: SpecialistEvidenceAssessment;
  iterations: number;
  normalized: boolean;
  reasons: string[];
}

function mapFingerprint(map: CodebaseMap): string {
  return JSON.stringify(map);
}

/**
 * Compile model-authored concern evidence into the exact deterministic map that
 * may be installed.
 *
 * A pre-normalization assessment is not sufficient: reconciliation can attach
 * shared implementation/test context and thereby create new core-ownership
 * obligations. Compilation therefore validates, normalizes, validates the
 * normalized result, and repeats until normalization is idempotent.
 */
export function compileSpecialistEvidence(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): SpecialistCompilationResult {
  let current = map;
  let normalized = false;
  let inferredAttachmentsRecomputed = false;
  const seen = new Set<string>();

  for (let iteration = 1; iteration <= MAX_SPECIALIST_COMPILATION_ITERATIONS; iteration += 1) {
    const withCanonicalConcernIdentities = reconcileScoutConcernIdentities(current);
    if (withCanonicalConcernIdentities !== current) {
      current = withCanonicalConcernIdentities;
      normalized = true;
      continue;
    }
    const withoutRetainedCandidates = reconcileExplicitlyRetainedCandidates(current);
    if (withoutRetainedCandidates !== current) {
      current = withoutRetainedCandidates;
      normalized = true;
      continue;
    }
    const withoutTrustedAttachments = inferredAttachmentsRecomputed
      ? current
      : removeTrustedInferredAttachments(current);
    inferredAttachmentsRecomputed = true;
    if (withoutTrustedAttachments !== current) {
      const baseAssessment = assessSpecialistEvidence(withoutTrustedAttachments, options);
      if (baseAssessment.complete) {
        const rebuilt = reconcileSpecialistEvidence(withoutTrustedAttachments, baseAssessment);
        if (mapFingerprint(rebuilt) !== mapFingerprint(current)) {
          current = rebuilt;
          normalized = true;
          continue;
        }
      }
    }
    const assessment = assessSpecialistEvidence(current, options);
    if (!assessment.complete) {
      const repaired = reconcileAuxiliaryDuplicateConcerns(current, assessment);
      if (repaired !== current) {
        current = repaired;
        normalized = true;
        continue;
      }
      return {
        status: "incomplete",
        complete: false,
        phase: normalized ? "post-normalization" : "evidence",
        map: current,
        assessment,
        iterations: iteration,
        normalized,
        reasons: [...assessment.reasons],
      };
    }

    const fingerprint = mapFingerprint(current);
    if (seen.has(fingerprint)) {
      return {
        status: "non-convergent",
        complete: false,
        phase: "post-normalization",
        map: current,
        assessment,
        iterations: iteration,
        normalized,
        reasons: [
          "specialist normalization entered a cycle before reaching an idempotent fixed point",
        ],
      };
    }
    seen.add(fingerprint);

    const reconciled = reconcileSpecialistEvidence(current, assessment);
    if (reconciled === current) {
      return {
        status: "compiled",
        complete: true,
        phase: "fixed-point",
        map: current,
        assessment,
        iterations: iteration,
        normalized,
        reasons: [],
      };
    }

    normalized = true;
    const reconciledFingerprint = mapFingerprint(reconciled);
    const postNormalization = assessSpecialistEvidence(reconciled, options);
    if (!postNormalization.complete) {
      return {
        status: "incomplete",
        complete: false,
        phase: "post-normalization",
        map: reconciled,
        assessment: postNormalization,
        iterations: iteration,
        normalized: true,
        reasons: [...postNormalization.reasons],
      };
    }

    if (reconciledFingerprint === fingerprint) {
      return {
        status: "compiled",
        complete: true,
        phase: "fixed-point",
        map: reconciled,
        assessment: postNormalization,
        iterations: iteration,
        normalized: true,
        reasons: [],
      };
    }

    current = reconciled;
  }

  const assessment = assessSpecialistEvidence(current, options);
  return {
    status: "non-convergent",
    complete: false,
    phase: "post-normalization",
    map: current,
    assessment,
    iterations: MAX_SPECIALIST_COMPILATION_ITERATIONS,
    normalized,
    reasons: [
      `specialist normalization did not reach an idempotent fixed point after ${MAX_SPECIALIST_COMPILATION_ITERATIONS} iterations`,
    ],
  };
}
