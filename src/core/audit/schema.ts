// Stable audit-schema façade.
//
// TypeBox declarations are owned by cohesive modules under ./schema/. This
// module intentionally declares nothing: it provides one import path while
// forwarding schema values, algorithms, and static types from their owners.

export {
  AlwaysOnDocsIntentSchema,
  ArtifactIntentsSchema,
  CodebaseMapSchema,
  ConfidenceSchema,
  CoverageStatusSchema,
  CustomizationEvidenceSchema,
  DimensionStatusSchema,
  ExpertEvidenceSchema,
  ExpertIntentSchema,
  ExplorerReceiptAttestationSchema,
  ExplorerReceiptSchema,
  ExtensionCandidateIntentSchema,
  FeatureAgentIntentSchema,
  PartialCodebaseMapSchema,
  PromptTemplateIntentSchema,
  ScaffoldRuntimeIntentSchema,
  NON_CLOSING_DELTA_DIMENSIONS,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
} from "./schema/index.ts";
export type {
  ArtifactIntents,
  CodebaseMap,
  CustomizationEvidence,
  ExpertEvidence,
  ExplorerReceiptAttestation,
  ExplorerReceiptRecord,
  FeatureAgentIntent,
  PartialCodebaseMap,
  WriteMapDeltaParams,
  WriteMapParams,
} from "./schema/index.ts";

export { COVERAGE_DIMENSIONS } from "./coverage.ts";
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
export {
  assessAuditCompletion,
  assessSpecialistEvidence,
  reconcileSpecialistEvidence,
  specialistEvidenceRecorded,
} from "./specialist-completion.ts";
export type {
  AuditCompletionResult,
  RejectedSpecialistConcern,
  RepositoryBehaviorCluster,
  SpecialistEvidenceAssessment,
} from "./specialist-completion.ts";
export { compileSpecialistEvidence } from "./specialist-compiler.ts";
export type {
  SpecialistCompilationPhase,
  SpecialistCompilationResult,
  SpecialistCompilationStatus,
} from "./specialist-compiler.ts";
export { applyMapDefaults } from "./map-defaults.ts";
export type { AppliedMapDefaults } from "./map-defaults.ts";
