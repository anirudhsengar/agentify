import type { Static } from "typebox";
import {
  CodebaseMapSchema,
  PartialCodebaseMapSchema,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
  type CodebaseMap,
  type PartialCodebaseMap,
  type WriteMapDeltaParams,
  type WriteMapParams,
} from "../../src/core/audit/schema.ts";

export function codebaseMapAliasToStatic(
  value: CodebaseMap,
): Static<typeof CodebaseMapSchema> {
  return value;
}

export function codebaseMapStaticToAlias(
  value: Static<typeof CodebaseMapSchema>,
): CodebaseMap {
  return value;
}

export function partialCodebaseMapAliasToStatic(
  value: PartialCodebaseMap,
): Static<typeof PartialCodebaseMapSchema> {
  return value;
}

export function partialCodebaseMapStaticToAlias(
  value: Static<typeof PartialCodebaseMapSchema>,
): PartialCodebaseMap {
  return value;
}

export function writeMapParamsAliasToStatic(
  value: WriteMapParams,
): Static<typeof WriteMapParamsSchema> {
  return value;
}

export function writeMapParamsStaticToAlias(
  value: Static<typeof WriteMapParamsSchema>,
): WriteMapParams {
  return value;
}

export function writeMapDeltaParamsAliasToStatic(
  value: WriteMapDeltaParams,
): Static<typeof WriteMapDeltaParamsSchema> {
  return value;
}

export function writeMapDeltaParamsStaticToAlias(
  value: Static<typeof WriteMapDeltaParamsSchema>,
): WriteMapDeltaParams {
  return value;
}

export type FrozenSchemaVersionType = CodebaseMap["schema_version"];
export type FrozenCoverageType = CodebaseMap["coverage"];
export type FrozenArtifactIntentsType = CodebaseMap["artifact_intents"];
export type FrozenWriteModeType = WriteMapParams["mode"];
export type FrozenMergeStrategyType = WriteMapDeltaParams["merge_strategy"];
export type FrozenDeltaDimensionType = WriteMapDeltaParams["dimension"];

export const minimalValidWriteMapParams: WriteMapParams = {};
export const minimalValidWriteMapDeltaParams: WriteMapDeltaParams = { delta: {} };
export const representativeWriteMapDeltaParams: WriteMapDeltaParams = {
  dimension: "D8_security",
  confidence: "high",
  evidence_summary: "Security surface was inspected.",
  delta: {
    open_questions: [],
  },
  merge_strategy: "deep_merge",
};
