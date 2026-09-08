import { Type, type Static } from "typebox";

export const AuditBudgetUsageSchema = Type.Object({
  elapsed_ms: Type.Integer({ minimum: 0 }),
  model_calls: Type.Integer({ minimum: 0 }),
  turns: Type.Integer({ minimum: 0 }),
  input_tokens: Type.Integer({ minimum: 0 }),
  output_tokens: Type.Integer({ minimum: 0 }),
  cost_usd: Type.Number({ minimum: 0 }),
  explorer_spawns: Type.Integer({ minimum: 0 }),
  coverage_recovery_passes: Type.Integer({ minimum: 0 }),
  semantic_repair_passes: Type.Integer({ minimum: 0 }),
  unreported_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  unreserved_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  reserved_input_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  reserved_output_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  reserved_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
});

export const AuditBudgetCheckpointSchema = Type.Object({
  repository_commit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
  run_count: Type.Integer({ minimum: 1, maximum: 1_024 }),
  usage: AuditBudgetUsageSchema,
  unresolved_fingerprints: Type.Array(Type.String({ pattern: "^[0-9a-f]{64}$" }), {
    maxItems: 256,
  }),
});

export type AuditBudgetCheckpoint = Static<typeof AuditBudgetCheckpointSchema>;
export type AuditBudgetUsage = Static<typeof AuditBudgetUsageSchema>;
