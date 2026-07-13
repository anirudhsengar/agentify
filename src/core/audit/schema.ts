// schema.ts
//
// TypeBox schemas for the 10-dimension codebase map and the
// write_map custom tool. This is the contract between the
// exploration sub-agents and the audit renderer.
//
// The schema is the durable artifact that downstream tools consume.
// Every section is required; the tool injects defaults for
// schema_version and generated_at if missing.
//
// Top-level fields of CodebaseMapSchema:
//   schema_version        — always "1" for now
//   generated_at          — ISO 8601, set by the tool
//   meta                  — project identity + lifecycle + docs
//   skeleton              — top-level tree, entry points, mirror
//   module_graph          — edges, parallelizable subtrees, split
//   type_contract_surface — TS/Pydantic/ORM models, traces
//   conventions           — naming, errors, logging, file size
//   pitfalls              — 3-5 risks per major module
//   validation_surface    — test/lint/typecheck/E2E commands
//   operational_surface   — build/run/deploy, env, ports, shutdown
//   security_surface      — path/command/env classifications
//   coverage              — the gate: every area must reach "covered"
//   open_questions        — gaps the audit couldn't resolve
//   exploration_log       — append-only audit trail
//
// The `coverage` block is the gate — see Golden Rule #7 in
// AGENTS.md: no AGENTS.md is emitted unless every area is covered.
//
// Phase 2.9: each dimension schema is extended with the new fields
// from the gap report's coverage gaps. The expansion is additive:
// v1 maps (without the new fields) continue to parse as v2.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { COVERAGE_DIMENSIONS } from "./coverage.ts";
import { ConventionsSchema } from "./schema/conventions.ts";
import { MetaSchema } from "./schema/meta.ts";
import { ModuleGraphSchema } from "./schema/module-graph.ts";
import { PitfallSchema } from "./schema/pitfalls.ts";
import {
    ConfidenceSchema,
    CoverageStatusSchema,
    DimensionStatusSchema,
} from "./schema/primitives.ts";
import { SkeletonSchema } from "./schema/skeleton.ts";
import { TypeContractSurfaceSchema } from "./schema/type-contract.ts";
import { OperationalSurfaceSchema } from "./schema/operational-surface.ts";
import { SecuritySurfaceSchema } from "./schema/security-surface.ts";
import { ValidationSurfaceSchema } from "./schema/validation-surface.ts";
import {
    AlwaysOnDocsIntentSchema,
    ArtifactIntentsSchema,
    ExpertIntentSchema,
    ExtensionCandidateIntentSchema,
    FeatureAgentIntentSchema,
    PromptTemplateIntentSchema,
    ScaffoldRuntimeIntentSchema,
} from "./schema/artifact-intents.ts";
import {
    CoverageMatrixSchema,
    ExplorationLogEntrySchema,
    ExplorationLogSchema,
    OpenQuestionsSchema,
} from "./schema/coverage.ts";
import {
    CustomizationEvidenceSchema,
    ExpertEvidenceSchema,
} from "./schema/evidence.ts";

export { ConfidenceSchema, CoverageStatusSchema, DimensionStatusSchema };
export {
    AlwaysOnDocsIntentSchema,
    ArtifactIntentsSchema,
    CustomizationEvidenceSchema,
    ExpertEvidenceSchema,
    ExpertIntentSchema,
    ExtensionCandidateIntentSchema,
    FeatureAgentIntentSchema,
    PromptTemplateIntentSchema,
    ScaffoldRuntimeIntentSchema,
};
export type { ArtifactIntents, FeatureAgentIntent } from "./schema/artifact-intents.ts";
export type { CustomizationEvidence, ExpertEvidence } from "./schema/evidence.ts";

// ============================================================================
// The full CodebaseMap (the contract)
// ============================================================================

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
    // Phase 4.5 — schema migration history.
    schema_migration_history: Type.Optional(Type.Array(Type.Object({
        from: Type.String(),
        to: Type.String(),
        migrated_at: Type.String(),
        notes: Type.String(),
    }))),
    // Emergent list of custom-tool and
    // skill candidates derived by the LLM from the rest of the
    // map (D6 test/lint/typecheck, D7 scripts, scripts/ dir,
    // package.json scripts). Used by Phase 9.6 to emit
    // .pi/extensions/*.ts and .pi/skills/<name>/SKILL.md. v1
    // maps without this field continue to parse.
    customization_evidence: Type.Optional(CustomizationEvidenceSchema),
    // Agent-expert domains. Emergent list of
    // expert domains derived by the LLM from the per-feature
    // reports (Phase 2) and D3.stable_types. Used by Phase
    // 9.10 to emit .pi/prompts/experts/<domain>/{expertise.yaml,
    // question.md, self-improve.md, [plan.md],
    // [plan_build_improve.md]}. v1 maps without this field
    // continue to parse.
    expert_evidence: Type.Optional(ExpertEvidenceSchema),
    // Structured output contract for all user-facing generated
    // intelligence. The LLM records intent here; TypeScript renderers
    // produce files later, after coverage closes and before the
    // transactional apply writes anything user-facing.
    artifact_intents: Type.Optional(ArtifactIntentsSchema),
});

export type CodebaseMap = Static<typeof CodebaseMapSchema>;

// ============================================================================
// PartialCodebaseMapSchema — for write_map_delta (Phase 1.2)
// ============================================================================

/**
 * A version of the codebase map where every top-level field is
 * optional. Used by the `write_map_delta` custom tool to merge
 * partial updates from `gap_filler` sub-agents into the canonical
 * map. The shape of each top-level section is the same as the
 * canonical schema; only the "required-ness" is relaxed.
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
    // Also optional on the partial schema so
    // write_map_delta can update customization_evidence incrementally.
    customization_evidence: Type.Optional(CustomizationEvidenceSchema),
    // Also optional on the partial schema
    // so write_map_delta can update expert_evidence incrementally.
    expert_evidence: Type.Optional(ExpertEvidenceSchema),
    artifact_intents: Type.Optional(ArtifactIntentsSchema),
});

export type PartialCodebaseMap = Static<typeof PartialCodebaseMapSchema>;

// ============================================================================
// write_map tool parameters
// ============================================================================

export const WriteMapParamsSchema = Type.Object({
    map: Type.Optional(CodebaseMapSchema),
    map_file: Type.Optional(
        Type.String({
            description:
                "Path (absolute or cwd-relative) to a JSON file containing the codebase map. Use for large maps (> 3KB) or when the LLM has built the JSON via the `write` tool. The tool reads, validates, and writes the canonical map to ./.pi/agentify/codebase_map.json.",
        }),
    ),
    mode: Type.Optional(
        StringEnum(["inline", "file", "auto"] as const, {
            default: "auto",
            description:
                "Persist mode. `inline` (strict) errors if the inline map exceeds 100KB. `file` (strict) requires explicit `map_file`. `auto` (default) falls back to file-based persistence transparently when inline exceeds the cap.",
        }),
    ),
});

export type WriteMapParams = Static<typeof WriteMapParamsSchema>;

// ============================================================================
// write_map_delta tool parameters (Phase 1.2)
// ============================================================================

export const WriteMapDeltaParamsSchema = Type.Object({
    dimension: Type.Optional(
        StringEnum(COVERAGE_DIMENSIONS, {
            description: "The dimension this delta closes. If provided, the corresponding coverage entry is set to `covered` with the delta's `confidence` and `evidence_summary`.",
        }),
    ),
    confidence: Type.Optional(
        StringEnum(["high", "medium", "low"] as const, {
            description: "Confidence level for the delta. Used for the dimension's coverage entry.",
        }),
    ),
    evidence_summary: Type.Optional(
        Type.String({
            description: "1-2 sentence summary of what was found. Used verbatim in AGENTS.md.",
        }),
    ),
    delta: PartialCodebaseMapSchema,
    merge_strategy: Type.Optional(
        StringEnum(["shallow_overwrite", "deep_merge", "append"] as const, {
            default: "shallow_overwrite",
            description:
                "How to merge the delta into the canonical map. `shallow_overwrite` (default) replaces matching top-level keys. `deep_merge` recursively merges objects. `append` pushes onto existing arrays.",
        }),
    ),
});

export type WriteMapDeltaParams = Static<typeof WriteMapDeltaParamsSchema>;

// ============================================================================
// Non-schema behavior compatibility façade
// ============================================================================

export { COVERAGE_DIMENSIONS };
export {
    AGENTS_MD_MAX_LINES,
    MIN_PITFALLS_FOR_COVERED,
    assessCoverageClosure,
    extractCoverageSummary,
} from "./coverage.ts";
export type {
    CoverageClosureResult,
    CoverageDimension,
    CoverageSummary,
} from "./coverage.ts";
export { applyMapDefaults } from "./map-defaults.ts";
export type { AppliedMapDefaults } from "./map-defaults.ts";
export {
    resolveApiContracts,
    resolveFrameworks,
    resolveLifecyclePresence,
    resolveProductionCredentials,
    resolveSyncedTypes,
} from "./schema-compatibility.ts";
export type {
    FrameworkMetaCompatibilityInput,
    FrameworkSkeletonCompatibilityInput,
    LifecycleCompatibilityInput,
    ResolvedApiContracts,
    ResolvedFrameworks,
    ResolvedLifecyclePresence,
    ResolvedProductionCredential,
    ResolvedSyncedTypes,
    SecurityCompatibilityInput,
    TypeContractCompatibilityInput,
} from "./schema-compatibility.ts";
