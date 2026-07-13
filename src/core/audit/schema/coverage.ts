import { Type } from "typebox";
import { DimensionStatusSchema } from "./primitives.ts";

// ============================================================================
// Coverage matrix (the gate)
// ============================================================================

export const CoverageMatrixSchema = Type.Object({
    D1_topography: DimensionStatusSchema,
    D2_module_boundaries: DimensionStatusSchema,
    D3_type_contract: DimensionStatusSchema,
    D4_conventions: DimensionStatusSchema,
    D5_pitfalls: DimensionStatusSchema,
    D6_validation: DimensionStatusSchema,
    D7_operational: DimensionStatusSchema,
    D8_security: DimensionStatusSchema,
    D9_process: DimensionStatusSchema,
    D10_documentation: DimensionStatusSchema,
});

// ============================================================================
// Open questions and exploration log
// ============================================================================

export const OpenQuestionsSchema = Type.Array(Type.String());

export const ExplorationLogEntrySchema = Type.Object({
    ts: Type.String({ description: "ISO 8601 timestamp" }),
    action: Type.String(),
    target: Type.String(),
    observation: Type.String(),
});

export const ExplorationLogSchema = Type.Array(ExplorationLogEntrySchema);

