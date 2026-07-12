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

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type Expect<Value extends true> = Value;

type RequiredKeys<Value> = {
  [Key in keyof Value]-?: Record<string, never> extends Pick<Value, Key> ? never : Key;
}[keyof Value];

export type CodebaseMapAliasParity = Expect<
  Equal<CodebaseMap, Static<typeof CodebaseMapSchema>>
>;
export type PartialCodebaseMapAliasParity = Expect<
  Equal<PartialCodebaseMap, Static<typeof PartialCodebaseMapSchema>>
>;
export type WriteMapParamsAliasParity = Expect<
  Equal<WriteMapParams, Static<typeof WriteMapParamsSchema>>
>;
export type WriteMapDeltaParamsAliasParity = Expect<
  Equal<WriteMapDeltaParams, Static<typeof WriteMapDeltaParamsSchema>>
>;

export type CompleteRequiredKeys = Expect<
  Equal<
    RequiredKeys<CodebaseMap>,
    | "meta"
    | "skeleton"
    | "module_graph"
    | "type_contract_surface"
    | "conventions"
    | "pitfalls"
    | "validation_surface"
    | "operational_surface"
    | "security_surface"
    | "coverage"
    | "open_questions"
    | "exploration_log"
  >
>;
export type PartialRequiredKeys = Expect<Equal<RequiredKeys<PartialCodebaseMap>, never>>;
export type WriteMapRequiredKeys = Expect<Equal<RequiredKeys<WriteMapParams>, never>>;
export type WriteMapDeltaRequiredKeys = Expect<
  Equal<RequiredKeys<WriteMapDeltaParams>, "delta">
>;

export type SchemaVersionLiteral = Expect<
  Equal<CodebaseMap["schema_version"], "1" | undefined>
>;
export type CoverageStatusLiteral = Expect<
  Equal<CodebaseMap["coverage"]["D1_topography"]["status"], "covered" | "gap">
>;
export type ConfidenceLiteral = Expect<
  Equal<CodebaseMap["coverage"]["D1_topography"]["confidence"], "high" | "medium" | "low">
>;
export type ModuleEdgeKindLiteral = Expect<
  Equal<CodebaseMap["module_graph"]["edges"][number]["kind"], "import" | "state" | "rpc">
>;
export type WriteModeLiteral = Expect<
  Equal<WriteMapParams["mode"], "inline" | "file" | "auto" | undefined>
>;
export type MergeStrategyLiteral = Expect<
  Equal<
    WriteMapDeltaParams["merge_strategy"],
    "shallow_overwrite" | "deep_merge" | "append" | undefined
  >
>;
export type DeltaDimensionLiteral = Expect<
  Equal<
    Exclude<WriteMapDeltaParams["dimension"], undefined>,
    | "D1_topography"
    | "D2_module_boundaries"
    | "D3_type_contract"
    | "D4_conventions"
    | "D5_pitfalls"
    | "D6_validation"
    | "D7_operational"
    | "D8_security"
    | "D9_process"
    | "D10_documentation"
  >
>;

export const acceptedWriteMapModes: ReadonlyArray<NonNullable<WriteMapParams["mode"]>> = [
  "inline",
  "file",
  "auto",
];

export const acceptedMergeStrategies: ReadonlyArray<
  NonNullable<WriteMapDeltaParams["merge_strategy"]>
> = ["shallow_overwrite", "deep_merge", "append"];

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

export const invalidWriteMode: WriteMapParams = {
  // @ts-expect-error Contract freeze: no additional persistence modes are accepted.
  mode: "stream",
};

export const invalidMergeStrategy: WriteMapDeltaParams = {
  delta: {},
  // @ts-expect-error Contract freeze: merge strategy literals must not drift.
  merge_strategy: "replace",
};

// @ts-expect-error Contract freeze: write_map_delta always requires delta.
export const missingDelta: WriteMapDeltaParams = {};
