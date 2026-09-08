import { Type, type Static } from "typebox";
import { SafeRelativePathSchema } from "./primitives.ts";

const SpecialistReviewFindingSchema = Type.Object({
  claim: Type.String({ minLength: 1, maxLength: 256 }),
  path: SafeRelativePathSchema,
  excerpt: Type.String({ minLength: 1, maxLength: 1_024,
    description: "One contiguous verbatim source excerpt. One line or expression is sufficient. Never join separate locations, insert ellipses, or change relative indentation." }),
  reason: Type.String({ minLength: 1, maxLength: 1_024,
    description: "Why this excerpt falsifies or fails to support the named assertion." }),
}, { additionalProperties: false });

/** Ephemeral reading notes, never a claim decision or persistent attestation. */
export const SourceObservationSubmissionSchema = Type.Object({
  observations: Type.Array(Type.Object({
    path: SafeRelativePathSchema,
    // Use a number with an integral constraint: SDK integer conversion would
    // otherwise truncate a fractional citation before application validation.
    start_line: Type.Number({ minimum: 1, multipleOf: 1,
      description: "Inclusive one-based line number in the supplied source view." }),
    end_line: Type.Number({ minimum: 1, multipleOf: 1,
      description: "Inclusive end line in the same source view. Choose at most 1024 source characters." }),
    behavior: Type.String({ minLength: 1, maxLength: 1_024,
      description: "What the quoted executable code does, including a concrete boundary or absent-input case. Do not infer missing context." }),
  }, { additionalProperties: false }), { maxItems: 4,
    description: "Up to four source-backed observations. Use an empty array when no behavior can be established from this view." }),
}, { additionalProperties: false });

export type SourceObservation = Pick<Static<typeof SourceObservationSubmissionSchema>["observations"][number], "path" | "behavior">
  & { excerpt: string };

export function createSpecialistReviewSubmissionSchema(claimIds: readonly string[], findingIds: readonly string[] = claimIds) {
  const claimId = Type.String({ enum: [...claimIds],
    description: "Exact supplied claim ID, never the claim text or a description of it." });
  const findingId = Type.String({ enum: [...findingIds],
    description: "Exact original claim ID. Auxiliary clause-check IDs are not valid finding targets; name their original_claim instead." });
  return Type.Object({
    verdict: Type.String({ enum: ["supported", "unsupported"],
      description: "Explicit review decision. supported requires every supplied claim ID checked and no finding. unsupported requires one exact-source finding." }),
    checked_claims: Type.Array(claimId, { maxItems: 512,
      description: "IDs actually checked. Include every supplied ID for the supported verdict." }),
    finding: Type.Optional(Type.Object({
      ...SpecialistReviewFindingSchema.properties,
      claim: findingId,
    }, { additionalProperties: false,
      description: "Required for unsupported: claim, path, excerpt and reason. Omit the entire finding property for supported; never send an empty object or null.",
    })),
    additional_findings: Type.Optional(Type.Array(Type.Object({
      ...SpecialistReviewFindingSchema.properties,
      claim: findingId,
    }, { additionalProperties: false }), { maxItems: 2,
      description: "Up to two further independent findings after finding. Empty or omitted for supported. Stop after three total findings." })),
  }, { additionalProperties: false });
}

export const SpecialistReviewAttestationSchema = Type.Object({
  repository_commit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  records: Type.Array(Type.Object({
    concern: Type.String({ minLength: 1, maxLength: 256 }),
    digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    run_id: Type.String({ minLength: 1, maxLength: 256 }),
    // Null means a complete typed review of every claim, not missing review.
    failure: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 2_048 })]),
    // Application-owned: incomplete execution may retry once in a later run.
    retryable: Type.Optional(Type.Boolean()),
    // Application-owned source finding; never reconstructed from failure prose.
    finding: Type.Optional(SpecialistReviewFindingSchema),
    additional_findings: Type.Optional(Type.Array(SpecialistReviewFindingSchema, { maxItems: 2 })),
  }, { additionalProperties: false }), { maxItems: 128 }),
}, { additionalProperties: false });

/** Canonical application result, after validating the explicit wire verdict. */
export type SpecialistReviewSubmission = {
  checked_claims: string[];
  finding: Static<typeof SpecialistReviewFindingSchema> | null;
  additional_findings?: Array<Static<typeof SpecialistReviewFindingSchema>>;
};
export type SpecialistReviewAttestation = Static<typeof SpecialistReviewAttestationSchema>;
