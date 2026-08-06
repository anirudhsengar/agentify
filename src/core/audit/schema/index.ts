// Internal schema boundary. This module re-exports canonical declaration
// objects without wrapping, cloning, or recomposing them.
export {
  AlwaysOnDocsIntentSchema,
  ArtifactIntentsSchema,
  ExpertIntentSchema,
  ExtensionCandidateIntentSchema,
  FeatureAgentIntentSchema,
  PromptTemplateIntentSchema,
  ScaffoldRuntimeIntentSchema,
} from "./artifact-intents.ts";
export type {
  ArtifactIntents,
  FeatureAgentIntent,
} from "./artifact-intents.ts";
export {
  CodebaseMapSchema,
  PartialCodebaseMapSchema,
} from "./codebase-map.ts";
export type {
  CodebaseMap,
  PartialCodebaseMap,
} from "./codebase-map.ts";
export {
  CustomizationEvidenceSchema,
  ExpertEvidenceSchema,
} from "./evidence.ts";
export type {
  CustomizationEvidence,
  ExpertEvidence,
} from "./evidence.ts";
export {
  ConfidenceSchema,
  CoverageStatusSchema,
  DimensionStatusSchema,
} from "./primitives.ts";
export {
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
} from "./write-map-params.ts";
export type {
  WriteMapDeltaParams,
  WriteMapParams,
} from "./write-map-params.ts";
