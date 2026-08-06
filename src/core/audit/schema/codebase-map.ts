import { Type, type Static } from "typebox";
import { COVERAGE_DIMENSIONS } from "../coverage.ts";
import { ArtifactIntentsSchema } from "./artifact-intents.ts";
import { ConventionsSchema } from "./conventions.ts";
import {
  CoverageMatrixSchema,
  ExplorationLogEntrySchema,
  ExplorationLogSchema,
  OpenQuestionsSchema,
} from "./coverage.ts";
import {
  CustomizationEvidenceSchema,
  ExpertEvidenceSchema,
} from "./evidence.ts";
import { MetaSchema } from "./meta.ts";
import { ModuleGraphSchema } from "./module-graph.ts";
import { OperationalSurfaceSchema } from "./operational-surface.ts";
import { PitfallSchema } from "./pitfalls.ts";
import { DimensionStatusSchema } from "./primitives.ts";
import { SecuritySurfaceSchema } from "./security-surface.ts";
import { SkeletonSchema } from "./skeleton.ts";
import { TypeContractSurfaceSchema } from "./type-contract.ts";
import { ValidationSurfaceSchema } from "./validation-surface.ts";

// The complete 10-dimension audit map contract. Property order is load-bearing:
// schema serialization and validation error ordering are frozen by golden tests.
export const CodebaseMapSchema = Type.Object({
  schema_version: Type.Optional(Type.Literal("1", {
    description: 'Set by the write_map tool. Always "1" for now.',
  })),
  generated_at: Type.Optional(Type.String({
    description: "ISO 8601 timestamp. Set by the write_map tool.",
  })),
  meta: MetaSchema,
  skeleton: SkeletonSchema,
  module_graph: ModuleGraphSchema,
  type_contract_surface: TypeContractSurfaceSchema,
  conventions: ConventionsSchema,
  pitfalls: Type.Array(PitfallSchema),
  validation_surface: ValidationSurfaceSchema,
  operational_surface: OperationalSurfaceSchema,
  security_surface: SecuritySurfaceSchema,
  coverage: CoverageMatrixSchema,
  open_questions: OpenQuestionsSchema,
  exploration_log: Type.Array(ExplorationLogEntrySchema),
  schema_migration_history: Type.Optional(Type.Array(Type.Object({
    from: Type.String(),
    to: Type.String(),
    migrated_at: Type.String(),
    notes: Type.String(),
  }))),
  customization_evidence: Type.Optional(CustomizationEvidenceSchema),
  expert_evidence: Type.Optional(ExpertEvidenceSchema),
  artifact_intents: Type.Optional(ArtifactIntentsSchema),
});

export type CodebaseMap = Static<typeof CodebaseMapSchema>;

/**
 * Complete-map top-level composition with every field made optional for
 * write_map_delta. Nested contracts are unchanged; only top-level requiredness
 * is relaxed.
 */
export const PartialCodebaseMapSchema = Type.Object({
  schema_version: Type.Optional(Type.Literal("1")),
  generated_at: Type.Optional(Type.String()),
  meta: Type.Optional(MetaSchema),
  skeleton: Type.Optional(SkeletonSchema),
  module_graph: Type.Optional(ModuleGraphSchema),
  type_contract_surface: Type.Optional(TypeContractSurfaceSchema),
  conventions: Type.Optional(ConventionsSchema),
  pitfalls: Type.Optional(Type.Array(PitfallSchema)),
  validation_surface: Type.Optional(ValidationSurfaceSchema),
  operational_surface: Type.Optional(OperationalSurfaceSchema),
  security_surface: Type.Optional(SecuritySurfaceSchema),
  coverage: Type.Optional(
    Type.Object(
      COVERAGE_DIMENSIONS.reduce<Record<string, typeof DimensionStatusSchema>>(
        (acc, dim) => {
          acc[dim] = DimensionStatusSchema;
          return acc;
        },
        {},
      ),
    ),
  ),
  open_questions: Type.Optional(OpenQuestionsSchema),
  exploration_log: Type.Optional(ExplorationLogSchema),
  customization_evidence: Type.Optional(CustomizationEvidenceSchema),
  expert_evidence: Type.Optional(ExpertEvidenceSchema),
  artifact_intents: Type.Optional(ArtifactIntentsSchema),
});

export type PartialCodebaseMap = Static<typeof PartialCodebaseMapSchema>;
