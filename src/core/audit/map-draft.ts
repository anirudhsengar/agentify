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

function schemaMatches(node: unknown, value: unknown): boolean {
  try {
    return Value.Check(node as never, value);
  } catch {
    return false;
  }
}

function sanitizeEvidence(node: unknown, candidate: unknown, fallback: unknown): unknown {
  if (!isRecord(node)) return fallback;
  const options = node.anyOf;
  if (Array.isArray(options) && options.length > 0) {
    const matching = options.find((option) => schemaMatches(option, candidate));
    return matching === undefined ? fallback : sanitizeEvidence(matching, candidate, fallback);
  }
  if (node.type === "object") {
    if (!isRecord(candidate) || !isRecord(fallback)) return fallback;
    const properties = isRecord(node.properties) ? node.properties : {};
    const output = structuredClone(fallback);
    for (const [key, property] of Object.entries(properties)) {
      if (key in candidate) output[key] = sanitizeEvidence(property, candidate[key], output[key]);
    }
    return output;
  }
  if (node.type === "array") {
    if (!Array.isArray(candidate)) return fallback;
    const items = node.items;
    return items === undefined ? candidate : candidate.filter((item) => schemaMatches(items, item));
  }
  return schemaMatches(node, candidate) ? candidate : fallback;
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

export function mergeEvidenceIntoGapDraft(evidence: Record<string, unknown>): CodebaseMap {
  const draft = createGapDraftMap();
  return mergeEvidenceIntoMap(evidence, draft);
}

export function mergeEvidenceIntoMap(
  evidence: Record<string, unknown>,
  fallback: CodebaseMap,
): CodebaseMap {
  const merged = sanitizeEvidence(CodebaseMapSchema, evidence, fallback) as CodebaseMap;
  if (!Value.Check(CodebaseMapSchema, merged)) {
    throw new Error("Internal error: sanitized audit evidence does not satisfy CodebaseMapSchema");
  }
  return merged;
}
