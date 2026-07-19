import { Value } from "typebox/value";
import { COVERAGE_DIMENSIONS, CodebaseMapSchema, type CodebaseMap } from "./schema.ts";

type SchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function draftValue(node: unknown): unknown {
  if (!isRecord(node)) return null;
  const enumValues = node.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const options = node.anyOf;
  if (Array.isArray(options) && options.length > 0) {
    const nullable = options.find((option) => isRecord(option) && option.type === "null");
    return draftValue(nullable ?? options[0]);
  }
  if (node.type === "object") {
    const properties = isRecord(node.properties) ? node.properties : {};
    const required = Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === "string") : [];
    const value: Record<string, unknown> = {};
    for (const key of required) value[key] = draftValue(properties[key]);
    return value;
  }
  if (node.type === "array") return [];
  if (node.type === "string") return "unknown";
  if (node.type === "number" || node.type === "integer") return 0;
  if (node.type === "boolean") return false;
  if (node.type === "null") return null;
  return null;
}

export function createGapDraftMap(): CodebaseMap {
  const draft = draftValue(CodebaseMapSchema) as CodebaseMap;
  draft.schema_version = "1";
  draft.generated_at = new Date().toISOString();
  draft.coverage = Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, {
    status: "gap",
    confidence: "low",
    evidence_summary: "Not yet explored; do not treat this dimension as closed.",
  }])) as CodebaseMap["coverage"];
  draft.open_questions = ["Initial draft: gather repository evidence before closing coverage."];
  draft.exploration_log = [{
    ts: draft.generated_at,
    action: "draft_bootstrap",
    target: ".",
    observation: "Created an honest gap-marked map to receive incremental audit evidence.",
  }];
  if (!Value.Check(CodebaseMapSchema, draft)) {
    throw new Error("Internal error: generated audit draft does not satisfy CodebaseMapSchema");
  }
  return draft;
}
