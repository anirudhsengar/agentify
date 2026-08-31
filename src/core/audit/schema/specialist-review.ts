import { Type, type Static } from "typebox";
import { SafeRelativePathSchema } from "./primitives.ts";

export function createSpecialistReviewSubmissionSchema(claimIds: readonly string[]) {
  const claimId = Type.String({ enum: [...claimIds],
    description: "Exact supplied claim ID, never the claim text or a description of it." });
  return Type.Object({
    checked_claims: Type.Array(claimId, { maxItems: 512,
      description: "IDs actually checked. Include every supplied ID only for a null finding." }),
    finding: Type.Union([Type.Null(), Type.Object({
      claim: claimId,
      path: SafeRelativePathSchema,
      excerpt: Type.String({ minLength: 1, maxLength: 1_024,
        description: "One contiguous verbatim source excerpt. One line or expression is sufficient. Never join separate locations, insert ellipses, or change relative indentation." }),
      reason: Type.String({ minLength: 1, maxLength: 1_024,
        description: "Why this excerpt falsifies or fails to support the named assertion." }),
    }, { additionalProperties: false })]),
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
  }, { additionalProperties: false }), { maxItems: 128 }),
}, { additionalProperties: false });

export type SpecialistReviewSubmission = Static<ReturnType<typeof createSpecialistReviewSubmissionSchema>>;
export type SpecialistReviewAttestation = Static<typeof SpecialistReviewAttestationSchema>;
