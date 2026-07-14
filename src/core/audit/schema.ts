// Stable audit-schema compatibility façade.
//
// TypeBox declarations are owned by cohesive modules under ./schema/. This
// façade intentionally declares nothing: it preserves the established import
// path and reference identity while forwarding schema values and static types.

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
  ExtensionCandidateIntentSchema,
  FeatureAgentIntentSchema,
  PartialCodebaseMapSchema,
  PromptTemplateIntentSchema,
  ScaffoldRuntimeIntentSchema,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
} from "./schema/index.ts";
export type {
  ArtifactIntents,
  CodebaseMap,
  CustomizationEvidence,
  ExpertEvidence,
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
