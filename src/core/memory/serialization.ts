import * as crypto from "node:crypto";
import type {
  AgentIdentity,
  EvidenceReference,
  MemoryCandidate,
  MemoryCandidateDraft,
  MemoryRecord,
} from "./schema.ts";
import { normalizeMemoryRepositoryPath } from "./paths.ts";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("memory JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      result[key] = toJsonValue(child);
    }
    return result;
  }
  throw new Error(`memory JSON contains an unsupported ${typeof value} value`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function digestCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function sortedUniqueStrings(
  values: ReadonlyArray<string>,
  normalize: (value: string) => string = (value) => value.trim(),
): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized.length > 0) unique.add(normalized);
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function normalizeEvidenceReference(reference: EvidenceReference): EvidenceReference {
  const repositoryPath = reference.repository_path === null
    ? null
    : normalizeMemoryRepositoryPath(reference.repository_path, "evidence repository path");
  const lineStart = reference.line_start;
  const lineEnd = reference.line_end;
  if (lineStart !== null && lineEnd !== null && lineEnd < lineStart) {
    throw new Error(`evidence ${reference.evidence_id} line_end precedes line_start`);
  }
  return {
    ...reference,
    repository_path: repositoryPath,
    description: reference.description.trim(),
    external_ref: reference.external_ref?.trim() || null,
    actor: reference.actor?.trim() || null,
  };
}

export function normalizeEvidence(
  evidence: ReadonlyArray<EvidenceReference>,
): EvidenceReference[] {
  const byId = new Map<string, EvidenceReference>();
  for (const entry of evidence) {
    const normalized = normalizeEvidenceReference(entry);
    const existing = byId.get(normalized.evidence_id);
    if (existing && canonicalJson(existing) !== canonicalJson(normalized)) {
      throw new Error(`evidence ID ${normalized.evidence_id} has conflicting definitions`);
    }
    byId.set(normalized.evidence_id, normalized);
  }
  return [...byId.values()].sort((left, right) => {
    const byIdOrder = left.evidence_id.localeCompare(right.evidence_id);
    if (byIdOrder !== 0) return byIdOrder;
    return canonicalJson(left).localeCompare(canonicalJson(right));
  });
}

function normalizePayload(candidate: MemoryCandidateDraft): MemoryCandidateDraft["payload"] {
  switch (candidate.kind) {
    case "codebase":
      return {
        ...candidate.payload,
        subject: candidate.payload.subject.trim(),
        paths: sortedUniqueStrings(
          candidate.payload.paths,
          (value) => normalizeMemoryRepositoryPath(value, "codebase path"),
        ),
        symbols: sortedUniqueStrings(candidate.payload.symbols),
        contracts: sortedUniqueStrings(candidate.payload.contracts),
        relationships: [...candidate.payload.relationships]
          .map((relationship) => ({
            ...relationship,
            from: relationship.from.trim(),
            to: relationship.to.trim(),
          }))
          .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
        validation_commands: sortedUniqueStrings(candidate.payload.validation_commands),
      };
    case "procedure":
      return {
        ...candidate.payload,
        name: candidate.payload.name.trim(),
        trigger_conditions: sortedUniqueStrings(candidate.payload.trigger_conditions),
        required_context_paths: sortedUniqueStrings(
          candidate.payload.required_context_paths,
          (value) => normalizeMemoryRepositoryPath(value, "procedure context path"),
        ),
        allowed_commands: sortedUniqueStrings(candidate.payload.allowed_commands),
        expected_file_patterns: sortedUniqueStrings(candidate.payload.expected_file_patterns),
        side_effects: sortedUniqueStrings(candidate.payload.side_effects),
        validation_commands: sortedUniqueStrings(candidate.payload.validation_commands),
        recovery_steps: [...candidate.payload.recovery_steps].map((value) => value.trim()),
      };
    case "episode":
      return {
        ...candidate.payload,
        attempts: [...candidate.payload.attempts]
          .map((attempt) => ({
            ...attempt,
            approach: attempt.approach.trim(),
            failure_category: attempt.failure_category?.trim() || null,
            signal: attempt.signal.trim(),
            correction: attempt.correction?.trim() || null,
          }))
          .sort((left, right) => left.sequence - right.sequence),
        review_feedback: sortedUniqueStrings(candidate.payload.review_feedback),
      };
    case "specialist":
      return {
        ...candidate.payload,
        domain: candidate.payload.domain.trim(),
        owned_paths: sortedUniqueStrings(
          candidate.payload.owned_paths,
          (value) => normalizeMemoryRepositoryPath(value, "specialist owned path"),
        ),
        observed_paths: sortedUniqueStrings(
          candidate.payload.observed_paths,
          (value) => normalizeMemoryRepositoryPath(value, "specialist observed path"),
        ),
        contracts: sortedUniqueStrings(candidate.payload.contracts),
        patterns: sortedUniqueStrings(candidate.payload.patterns),
        pitfalls: sortedUniqueStrings(candidate.payload.pitfalls),
        related_specialists: sortedUniqueStrings(candidate.payload.related_specialists),
        validation_commands: sortedUniqueStrings(candidate.payload.validation_commands),
      };
    case "orchestrator":
      return {
        ...candidate.payload,
        issue_signals: sortedUniqueStrings(candidate.payload.issue_signals),
        selected_specialists: sortedUniqueStrings(candidate.payload.selected_specialists),
        validation_policy: sortedUniqueStrings(candidate.payload.validation_policy),
      };
    case "policy":
      return {
        ...candidate.payload,
        rule: candidate.payload.rule.trim(),
        protected_paths: sortedUniqueStrings(
          candidate.payload.protected_paths,
          (value) => normalizeMemoryRepositoryPath(value, "policy protected path"),
        ),
        allowed_tools: sortedUniqueStrings(candidate.payload.allowed_tools),
        forbidden_actions: sortedUniqueStrings(candidate.payload.forbidden_actions),
        unit: candidate.payload.unit?.trim() || null,
      };
  }
}

function semanticMemoryValue(value: {
  kind: MemoryCandidate["kind"] | MemoryRecord["kind"];
  owning_agent_id: string;
  statement: string;
  payload: MemoryCandidate["payload"] | MemoryRecord["payload"];
  dependent_paths: string[];
  invalidation_conditions: string[];
  tags: string[];
}): unknown {
  return {
    kind: value.kind,
    owning_agent_id: value.owning_agent_id,
    statement: value.statement,
    payload: value.payload,
    dependent_paths: value.dependent_paths,
    tags: value.tags,
  };
}

export function createMemoryCandidateValue(input: MemoryCandidateDraft): MemoryCandidate {
  const normalizedWithoutDigest = {
    ...input,
    statement: input.statement.trim(),
    evidence: normalizeEvidence(input.evidence),
    dependent_paths: sortedUniqueStrings(
      input.dependent_paths,
      (value) => normalizeMemoryRepositoryPath(value, "memory dependent path"),
    ),
    invalidation_conditions: sortedUniqueStrings(input.invalidation_conditions),
    contradicts: sortedUniqueStrings(input.contradicts),
    tags: sortedUniqueStrings(input.tags),
    payload: normalizePayload(input),
    human_attribution: input.human_attribution === null
      ? null
      : {
          ...input.human_attribution,
          actor: input.human_attribution.actor.trim(),
          source_ref: input.human_attribution.source_ref.trim(),
        },
  } as Omit<MemoryCandidate, "candidate_digest">;
  return {
    ...normalizedWithoutDigest,
    candidate_digest: digestCanonical(normalizedWithoutDigest),
  } as MemoryCandidate;
}

export function semanticDigestForCandidate(candidate: MemoryCandidate): string {
  const { candidate_digest: _candidateDigest, ...withoutDigest } = candidate;
  return digestCanonical(semanticMemoryValue(withoutDigest));
}

export function semanticDigestForRecord(record: MemoryRecord): string {
  return digestCanonical(semanticMemoryValue(record));
}

export function contentDigestForRecord(
  record: Omit<MemoryRecord, "content_digest">,
): string {
  return digestCanonical(record);
}

export function contentDigestForIdentity(
  identity: Omit<AgentIdentity, "content_digest">,
): string {
  return digestCanonical(identity);
}

export function eventDigest<T extends { event_digest: string }>(
  event: Omit<T, "event_digest">,
): string {
  return digestCanonical(event);
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
] as const;

export function assertNoPersistedSecrets(value: unknown): void {
  const serialized = canonicalJson(value);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error("memory content resembles a credential or private key and cannot be persisted");
    }
  }
}

export function recordPaths(record: MemoryRecord): string[] {
  const paths = new Set(record.dependent_paths);
  switch (record.kind) {
    case "codebase":
      for (const value of record.payload.paths) paths.add(value);
      break;
    case "procedure":
      for (const value of record.payload.required_context_paths) paths.add(value);
      break;
    case "specialist":
      for (const value of record.payload.owned_paths) paths.add(value);
      for (const value of record.payload.observed_paths) paths.add(value);
      break;
    case "policy":
      for (const value of record.payload.protected_paths) paths.add(value);
      break;
    case "episode":
    case "orchestrator":
      break;
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}
