import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { COVERAGE_DIMENSIONS } from "../coverage.ts";
import {
  CodebaseMapSchema,
  PartialCodebaseMapSchema,
} from "./codebase-map.ts";

export const WriteMapParamsSchema = Type.Object({
  map: Type.Optional(CodebaseMapSchema),
  map_file: Type.Optional(
    Type.String({
      description:
        "Path (absolute or cwd-relative) to an already-existing JSON file containing the codebase map. Audit sessions cannot create this file; normally submit `map` inline with mode `auto`, which safely creates a private draft when needed. The tool reads, validates, and writes the canonical map to ./.pi/agentify/codebase_map.json.",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["inline", "file", "auto"] as const, {
      default: "auto",
      description:
        "Persist mode. `inline` (strict) errors if the inline map exceeds 100KB. `file` (strict) requires explicit `map_file`. `auto` (default and recommended) safely creates a private draft when an inline map exceeds the cap.",
    }),
  ),
});

export type WriteMapParams = Static<typeof WriteMapParamsSchema>;

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
