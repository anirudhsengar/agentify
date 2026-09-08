import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { SafeRelativePathSchema } from "./primitives.ts";

export const ExplorerReceiptSchema = Type.Object({
  sequence: Type.Integer({ minimum: 1 }),
  mode: StringEnum(["concern_scout", "concern_tracer"] as const),
  success: Type.Boolean(),
  target_path: SafeRelativePathSchema,
  focus: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  expected_concern: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  report_concern: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  failure_kind: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  proposed_concerns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
    maxItems: 128,
  })),
  source_run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  observed_paths: Type.Optional(Type.Array(SafeRelativePathSchema, { minItems: 1, maxItems: 512 })),
});

export const ExplorerReceiptAttestationSchema = Type.Object({
  repository_commit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  run_id: Type.String({ minLength: 1, maxLength: 256 }),
  receipts: Type.Array(ExplorerReceiptSchema, { minItems: 1, maxItems: 256 }),
});

export type ExplorerReceiptRecord = Static<typeof ExplorerReceiptSchema>;
export type ExplorerReceiptAttestation = Static<typeof ExplorerReceiptAttestationSchema>;
