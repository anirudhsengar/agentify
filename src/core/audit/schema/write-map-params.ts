import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { COVERAGE_DIMENSIONS } from "../coverage.ts";
import { EvidenceCitationSchema } from "./primitives.ts";

const SerializedMapTransportSchema = Type.String({
  description:
    "JSON-serialized map transport. Use an inline object normally; Agentify parses this form and applies the same strict map validation.",
});

const InlineMapTransportSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: "Map transport envelope. Agentify normalizes provider encodings and strictly validates the complete map before persistence.",
});

const MapTransportSchema = Type.Union([InlineMapTransportSchema, SerializedMapTransportSchema]);
const DeltaTransportSchema = Type.Record(Type.String(), Type.Unknown(), {
  description:
    "Incremental map update transport. Agentify merges this into the canonical map and strictly validates the complete result. " +
    "Keep this object small: include only the top-level keys (e.g. `skeleton`, `coverage`, `pitfalls`) needed for the one dimension you are closing. " +
    "Never put the entire map here; use `write_map` for a complete replacement.",
});

const ObservedTypeContractSchema = Type.Object({
  kind: StringEnum(["typescript_interface", "pydantic_model"] as const, {
    description: "Canonical contract collection that owns this observed definition.",
  }),
  path: Type.String({
    description: "Repository-relative path containing the observed contract definition.",
  }),
  name: Type.String({
    description: "Exact interface, model, or schema name observed in the repository.",
  }),
  fields: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 64,
    description: "One or more real field names observed on the contract.",
  }),
}, {
  description:
    "Structured D3 evidence. With dimension=D3_type_contract, Agentify inserts this entry into type_contract_surface before applying the closure gate. Use this when a generic delta risks recording only a coverage annotation.",
});

export const WriteMapParamsSchema = Type.Object({
  map: Type.Optional(MapTransportSchema),
  codebase_map: Type.Optional(MapTransportSchema),
  map_file: Type.Optional(
    Type.String({
      description:
        "Path (absolute or cwd-relative) to an already-existing JSON file containing the codebase map. Audit sessions cannot create this file; normally submit `map` inline with mode `auto`, which safely creates a private draft when needed. The tool reads, validates, and writes the canonical map to the explicitly configured audit state directory (currently .agentify/runtime/audit/codebase_map.json).",
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

/**
 * Aliases a model may pass for a delta that records concern evidence. Audit
 * prompts name the missing gate "specialist evidence", and models observed in
 * the wild copy that label into `dimension`; rejecting the write there strands
 * the entire audit because the concern payload never lands. The aliases close
 * no coverage dimension and normalize to an omitted `dimension`.
 */
export const NON_CLOSING_DELTA_DIMENSIONS = ["specialist_evidence", "concern_evidence"] as const;

export const WriteMapDeltaParamsSchema = Type.Object({
  dimension: Type.Optional(
    StringEnum([...COVERAGE_DIMENSIONS, ...NON_CLOSING_DELTA_DIMENSIONS], {
      description:
        "The coverage dimension this delta closes. If provided, the corresponding coverage entry is set to `covered` with the delta's `confidence` and `evidence_summary`. " +
        "For a concern-evidence delta, omit `dimension` entirely (or pass `specialist_evidence`): concern evidence closes no coverage dimension.",
    }),
  ),
  confidence: Type.Optional(
    StringEnum(["high", "medium", "low"] as const, {
      description: "Confidence level for the delta. Used for the dimension's coverage entry.",
    }),
  ),
  evidence_summary: Type.Optional(
    Type.String({
      description:
        "1-2 sentence evidence summary stored with the coverage record and consumed by trusted closure, specialist-discovery, and task-planning code.",
    }),
  ),
  evidence: Type.Optional(
    Type.Array(EvidenceCitationSchema, {
      description:
        "Citations to real repository paths that support the dimension coverage claim. " +
        "Required when `dimension` is provided and the claim is `covered`; the installer gate verifies these citations.",
    }),
  ),
  observed_type_contract: Type.Optional(ObservedTypeContractSchema),
  delta: Type.Union([DeltaTransportSchema, SerializedMapTransportSchema]),
  merge_strategy: Type.Optional(
    StringEnum(["shallow_overwrite", "deep_merge", "append"] as const, {
      description:
        "How to merge the delta into the canonical map. When omitted, ordinary deltas use `shallow_overwrite` while deltas containing concern_evidence use `append` so bounded checkpoints are monotonic. `deep_merge` recursively merges objects; explicit `shallow_overwrite` replaces matching top-level keys; `append` pushes onto existing arrays.",
    }),
  ),
});

export type WriteMapDeltaParams = Static<typeof WriteMapDeltaParamsSchema>;
