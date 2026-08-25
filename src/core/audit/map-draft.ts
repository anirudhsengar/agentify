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

function firstErrorReason(node: unknown, value: unknown): string {
  try {
    const errors = [...Value.Errors(node as never, value)];
    const first = errors[0] as { path?: string; instancePath?: string; message?: string } | undefined;
    if (!first) return "does not match the schema";
    const errorPath = first.path || first.instancePath || "/";
    return `${errorPath}: ${first.message ?? "does not match the schema"}`;
  } catch {
    return "does not match the schema";
  }
}

/**
 * Diagnostics collected while sanitizing a candidate map against the schema.
 * Sanitization repairs what it safely can; everything it drops is recorded
 * here so the tool result can tell the model exactly what happened to its
 * evidence instead of failing silently or succeeding silently.
 */
export interface SanitizeDiagnostics {
  /** Candidate data that did not match the schema and was not persisted. */
  dropped: string[];
}

const MAX_SANITIZE_DIAGNOSTICS = 8;

function noteDiagnostic(list: string[], path: string, detail: string): void {
  if (list.length >= MAX_SANITIZE_DIAGNOSTICS) return;
  list.push(`${path}: ${detail}`);
}

function sanitizeEvidence(
  node: unknown,
  candidate: unknown,
  fallback: unknown,
  path = "",
  diagnostics?: SanitizeDiagnostics,
): unknown {
  if (!isRecord(node)) return fallback;
  const options = node.anyOf;
  if (Array.isArray(options) && options.length > 0) {
    const matching = options.find((option) => schemaMatches(option, candidate));
    if (matching === undefined) {
      if (candidate !== undefined && diagnostics) {
        noteDiagnostic(diagnostics.dropped, path || "/", firstErrorReason(node, candidate));
      }
      return fallback;
    }
    return sanitizeEvidence(matching, candidate, fallback, path, diagnostics);
  }
  if (node.type === "object") {
    // When the candidate carries a brand-new top-level object the previous
    // map does not have — concern_evidence being the canonical case — the
    // fallback may be undefined or a non-object. Returning the fallback
    // silently drops the candidate; cloning a fresh {} base from the
    // candidate's own keys lets a new section survive materialization.
    if (!isRecord(candidate)) {
      if (candidate !== undefined && diagnostics) {
        noteDiagnostic(diagnostics.dropped, path || "/", firstErrorReason(node, candidate));
      }
      return fallback;
    }
    const base = isRecord(fallback) ? structuredClone(fallback) : {};
    const properties = isRecord(node.properties) ? node.properties : {};
    const output: Record<string, unknown> = { ...base };
    for (const [key, property] of Object.entries(properties)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (key in candidate) {
        output[key] = sanitizeEvidence(property, candidate[key], base[key], keyPath, diagnostics);
      }
      // A key the candidate omitted keeps the fallback's value. When the
      // fallback cannot supply it (a brand-new section), the key stays
      // missing and the final validation gate names it precisely — an
      // omitted `concerns` array must never be mistaken for an explicitly
      // recorded empty one.
    }
    return output;
  }
  if (node.type === "array") {
    if (!Array.isArray(candidate)) {
      if (candidate !== undefined && diagnostics) {
        noteDiagnostic(diagnostics.dropped, path || "/", "expected an array");
      }
      return fallback;
    }
    const items = node.items;
    if (items === undefined) return candidate;
    const kept: unknown[] = [];
    for (const [index, item] of candidate.entries()) {
      if (schemaMatches(items, item)) {
        kept.push(item);
      } else if (diagnostics) {
        noteDiagnostic(diagnostics.dropped, `${path || "/"}[${index}]`, firstErrorReason(items, item));
      }
    }
    return kept;
  }
  if (schemaMatches(node, candidate)) return candidate;
  if (candidate !== undefined && diagnostics) {
    noteDiagnostic(diagnostics.dropped, path || "/", firstErrorReason(node, candidate));
  }
  return fallback;
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

export function mergeEvidenceIntoGapDraft(
  evidence: Record<string, unknown>,
  diagnostics?: SanitizeDiagnostics,
): CodebaseMap {
  const draft = createGapDraftMap();
  const merged = mergeEvidenceIntoMap(evidence, draft, diagnostics);
  if (!merged.exploration_log.some((entry) => entry.action === "draft_bootstrap")) {
    merged.exploration_log.unshift(draft.exploration_log[0]!);
  }
  if (!Value.Check(CodebaseMapSchema, merged)) {
    throw new Error(
      "Internal error: bootstrap audit evidence does not satisfy CodebaseMapSchema"
        + formatSanitizeFailure(merged),
    );
  }
  return merged;
}

/**
 * Pad a concern's flow step lists to the schema minimum.
 *
 * `ConcernFlowSchema.steps` requires `minItems: 2`. A flow traced through a
 * single step is a real signal, not invalid data — the tracer genuinely
 * followed one hop. Discarding the entire concern is far more harmful than
 * noting the limitation. Carry the flow with a single duplicate step marked
 * as "single-step trace" so the model and the audit reader can see what
 * happened, while still satisfying the schema.
 */
function repairConcernFlows(concern: Record<string, unknown>): Record<string, unknown> {
  const flows = Array.isArray(concern.flows) ? concern.flows : [];
  const repairedFlows = flows.map((flow: unknown) => {
    if (flow === null || typeof flow !== "object") return flow;
    const f = { ...(flow as Record<string, unknown>) };
    if (Array.isArray(f.steps) && f.steps.length === 1) {
      const step = f.steps[0] as Record<string, unknown>;
      f.steps = [step, { ...step, what_happens: `${step.what_happens ?? "step"} (single-step trace: only one observation passed schema validation)` }];
    }
    return f;
  });
  return { ...concern, flows: repairedFlows };
}

/**
 * Format the first few schema errors of a sanitized map that still fails
 * validation. The model receives this text verbatim inside the tool error, so
 * each entry names the exact map path and what the schema expected there —
 * the difference between a one-shot repair and a blind retry loop.
 */
function formatSanitizeFailure(merged: unknown): string {
  const errors = [...Value.Errors(CodebaseMapSchema, merged)];
  if (errors.length === 0) return "";
  const lines = errors.slice(0, 5).map((error) => {
    const entry = error as { path?: string; instancePath?: string; message?: string };
    return `  - ${entry.path || entry.instancePath || "/"}: ${entry.message ?? "invalid"}`;
  });
  const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : "";
  return ` Sanitized map still fails validation with ${errors.length} error(s)${more}:\n${lines.join("\n")}`;
}

export function mergeEvidenceIntoMap(
  evidence: Record<string, unknown>,
  fallback: CodebaseMap,
  diagnostics?: SanitizeDiagnostics,
): CodebaseMap {
  // Repair concerns before sanitization: a flow traced to a single hop is
  // not invalid, but the schema's minItems: 2 step rule would otherwise filter
  // the entire concern out — silently dropping the very signal the audit is
  // meant to capture.
  if (evidence.concern_evidence && typeof evidence.concern_evidence === "object") {
    const ce = evidence.concern_evidence as Record<string, unknown>;
    if (Array.isArray(ce.concerns)) {
      ce.concerns = (ce.concerns as Array<Record<string, unknown>>).map(repairConcernFlows);
    }
  }
  const merged = sanitizeEvidence(CodebaseMapSchema, evidence, fallback, "", diagnostics) as CodebaseMap;
  if (!Value.Check(CodebaseMapSchema, merged)) {
    throw new Error(
      "Internal error: sanitized audit evidence does not satisfy CodebaseMapSchema"
        + formatSanitizeFailure(merged),
    );
  }
  // Submitting concerns and having every one filtered out is never the
  // model's intent — it is a schema-shape mismatch. Fail the write with the
  // per-item reasons so the model repairs and resubmits, rather than
  // persisting an empty list that specialist discovery reads as "this
  // repository has no concerns".
  const submittedConcerns =
    evidence.concern_evidence !== null
    && typeof evidence.concern_evidence === "object"
    && Array.isArray((evidence.concern_evidence as Record<string, unknown>).concerns)
      ? ((evidence.concern_evidence as Record<string, unknown>).concerns as unknown[]).length
      : 0;
  if (submittedConcerns > 0 && (merged.concern_evidence?.concerns.length ?? 0) === 0) {
    const reasons = diagnostics?.dropped.length
      ? ` Drop reasons: ${diagnostics.dropped.join("; ")}.`
      : "";
    throw new Error(
      `All ${submittedConcerns} submitted concern(s) failed schema validation and were dropped; `
        + `no concern evidence was persisted. Fix the named fields and resubmit.${reasons}`,
    );
  }
  return merged;
}
