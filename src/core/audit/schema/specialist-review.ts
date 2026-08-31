import { Type, type Static } from "typebox";
import { SafeRelativePathSchema } from "./primitives.ts";

export const SpecialistReviewSubmissionSchema = Type.Object({
  checked_claims: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 512 }),
  finding: Type.Union([Type.Null(), Type.Object({
    claim: Type.String({ minLength: 1, maxLength: 256 }),
    path: SafeRelativePathSchema,
    excerpt: Type.String({ minLength: 1, maxLength: 1_024 }),
    reason: Type.String({ minLength: 1, maxLength: 1_024 }),
  }, { additionalProperties: false })]),
}, { additionalProperties: false });

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

export type SpecialistReviewSubmission = Static<typeof SpecialistReviewSubmissionSchema>;
export type SpecialistReviewAttestation = Static<typeof SpecialistReviewAttestationSchema>;
