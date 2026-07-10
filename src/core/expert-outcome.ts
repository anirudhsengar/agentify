import * as fs from "node:fs";
import * as path from "node:path";
import { parseExpertiseYaml, type ExpertiseYaml } from "./agent-expert.ts";

export type ExpertOutcomeMode = "plan" | "review" | "refresh";

export interface ExpertOutcomeReplay {
  mode: ExpertOutcomeMode;
  expertise: ExpertiseYaml;
  outputText: string;
}

export interface ExpertOutcomeScore {
  mode: ExpertOutcomeMode;
  score: number;
  maxScore: number;
  passed: boolean;
  coveredChecks: string[];
  missing: string[];
}

export interface ExpertOutcomeComparison {
  baseline: ExpertOutcomeScore;
  expertGuided: ExpertOutcomeScore;
  delta: number;
}

export interface ExpertOutcomePair {
  baseline: ExpertOutcomeReplay;
  expertGuided: ExpertOutcomeReplay;
}

export interface ExpertOutcomeEvidenceCase {
  id: string;
  mode: ExpertOutcomeMode;
  expertise: ExpertiseYaml;
  baselineText: string;
  expertGuidedText: string;
  minDelta?: number;
}

export interface ExpertOutcomeEvidenceCaseResult {
  id: string;
  mode: ExpertOutcomeMode;
  minDelta: number;
  passed: boolean;
  reasons: string[];
  comparison: ExpertOutcomeComparison;
}

export interface ExpertOutcomeEvidenceMetadata {
  repo: string;
  commitSha: string;
  capturedAt: string;
  provider: string;
  model: string;
}

export interface ExpertOutcomeEvidenceReport {
  passed: boolean;
  totalCases: number;
  passedCases: number;
  metadata: ExpertOutcomeEvidenceMetadata | null;
  cases: ExpertOutcomeEvidenceCaseResult[];
}

const PASSING_SCORE = 5;
const DEFAULT_MIN_DELTA = 3;

export function scoreExpertOutcome(replay: ExpertOutcomeReplay): ExpertOutcomeScore {
  const output = normalize(replay.outputText);
  const checks = outcomeChecks(replay.expertise, replay.mode);
  const coveredChecks: string[] = [];
  const missing: string[] = [];

  for (const check of checks) {
    if (check.matches(output)) {
      coveredChecks.push(check.id);
    } else {
      missing.push(check.id);
    }
  }

  return {
    mode: replay.mode,
    score: coveredChecks.length,
    maxScore: checks.length,
    passed: coveredChecks.length >= PASSING_SCORE && missing.length === 0,
    coveredChecks,
    missing,
  };
}

export function compareExpertOutcomePair(pair: ExpertOutcomePair): ExpertOutcomeComparison {
  const baseline = scoreExpertOutcome(pair.baseline);
  const expertGuided = scoreExpertOutcome(pair.expertGuided);
  return {
    baseline,
    expertGuided,
    delta: expertGuided.score - baseline.score,
  };
}

export function evaluateExpertOutcomeEvidence(
  cases: ExpertOutcomeEvidenceCase[],
  options: { minDelta?: number; metadata?: ExpertOutcomeEvidenceMetadata | null } = {},
): ExpertOutcomeEvidenceReport {
  const defaultMinDelta = options.minDelta ?? DEFAULT_MIN_DELTA;
  const results = cases.map((entry) => {
    const minDelta = entry.minDelta ?? defaultMinDelta;
    const comparison = compareExpertOutcomePair({
      baseline: {
        mode: entry.mode,
        expertise: entry.expertise,
        outputText: entry.baselineText,
      },
      expertGuided: {
        mode: entry.mode,
        expertise: entry.expertise,
        outputText: entry.expertGuidedText,
      },
    });
    const reasons: string[] = [];

    if (!comparison.expertGuided.passed) {
      reasons.push(`expert-guided output missed checks: ${comparison.expertGuided.missing.join(", ")}`);
    }
    if (comparison.delta < minDelta) {
      reasons.push(`delta ${comparison.delta} below required ${minDelta}`);
    }

    return {
      id: entry.id,
      mode: entry.mode,
      minDelta,
      passed: reasons.length === 0,
      reasons,
      comparison,
    };
  });

  const passedCases = results.filter((result) => result.passed).length;
  return {
    passed: results.length > 0 && passedCases === results.length,
    totalCases: results.length,
    passedCases,
    metadata: options.metadata ?? null,
    cases: results,
  };
}

export function loadExpertOutcomeEvidenceFile(filePath: string): ExpertOutcomeEvidenceReport {
  const manifestPath = path.resolve(filePath);
  const manifestDir = path.dirname(manifestPath);
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = parseEvidenceManifest(raw, manifestPath);
  const cases = manifest.cases.map((entry) => {
    const expertisePath = resolveManifestPath(manifestDir, entry.expertisePath);
    const baselinePath = resolveManifestPath(manifestDir, entry.baselineTranscriptPath);
    const expertGuidedPath = resolveManifestPath(manifestDir, entry.expertGuidedTranscriptPath);
    return {
      id: entry.id,
      mode: entry.mode,
      expertise: parseExpertiseYaml(expertisePath),
      baselineText: fs.readFileSync(baselinePath, "utf-8"),
      expertGuidedText: fs.readFileSync(expertGuidedPath, "utf-8"),
      minDelta: entry.minDelta,
    };
  });
  return evaluateExpertOutcomeEvidence(cases, { metadata: manifest.metadata });
}

interface EvidenceManifest {
  version: 1;
  metadata: ExpertOutcomeEvidenceMetadata;
  cases: EvidenceManifestCase[];
}

interface EvidenceManifestCase {
  id: string;
  mode: ExpertOutcomeMode;
  expertisePath: string;
  baselineTranscriptPath: string;
  expertGuidedTranscriptPath: string;
  minDelta?: number;
}

interface OutcomeCheck {
  id: string;
  matches(output: string): boolean;
}

function parseEvidenceManifest(raw: string, source: string): EvidenceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source}: invalid JSON (${errorMessage(error)})`);
  }

  const record = requireRecord(parsed, source);
  const version = record["version"];
  if (version !== 1) {
    throw new Error(`${source}: version must be 1`);
  }

  const casesValue = record["cases"];
  if (!Array.isArray(casesValue) || casesValue.length === 0) {
    throw new Error(`${source}: cases must be a non-empty array`);
  }

  return {
    version: 1,
    metadata: parseEvidenceManifestMetadata(record, source),
    cases: casesValue.map((entry, index) => parseEvidenceManifestCase(entry, `${source}: cases[${index}]`)),
  };
}

function parseEvidenceManifestMetadata(record: Record<string, unknown>, source: string): ExpertOutcomeEvidenceMetadata {
  return {
    repo: requireRepo(record["repo"], `${source}: repo`),
    commitSha: requireCommitSha(record["commit_sha"], `${source}: commit_sha`),
    capturedAt: requireIsoTimestamp(record["captured_at"], `${source}: captured_at`),
    provider: requireNonEmptyString(record["provider"], `${source}: provider`),
    model: requireNonEmptyString(record["model"], `${source}: model`),
  };
}

function parseEvidenceManifestCase(value: unknown, context: string): EvidenceManifestCase {
  const record = requireRecord(value, context);
  const mode = requireMode(record["mode"], `${context}.mode`);
  const minDelta = optionalPositiveInteger(record["min_delta"], `${context}.min_delta`);
  return {
    id: requireNonEmptyString(record["id"], `${context}.id`),
    mode,
    expertisePath: requireNonEmptyString(record["expertise_path"], `${context}.expertise_path`),
    baselineTranscriptPath: requireNonEmptyString(
      record["baseline_transcript_path"],
      `${context}.baseline_transcript_path`,
    ),
    expertGuidedTranscriptPath: requireNonEmptyString(
      record["expert_guided_transcript_path"],
      `${context}.expert_guided_transcript_path`,
    ),
    minDelta,
  };
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requireMode(value: unknown, context: string): ExpertOutcomeMode {
  if (value === "plan" || value === "review" || value === "refresh") return value;
  throw new Error(`${context}: expected plan, review, or refresh`);
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: expected non-empty string`);
  }
  return value;
}

function requireRepo(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} must be owner/name`);
  }
  const repo = value;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`${context} must be owner/name`);
  }
  return repo;
}

function requireCommitSha(value: unknown, context: string): string {
  const commitSha = requireNonEmptyString(value, context);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(`${context} must be a 40-character git SHA`);
  }
  return commitSha;
}

function requireIsoTimestamp(value: unknown, context: string): string {
  const timestamp = requireNonEmptyString(value, context);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${context} must be an ISO timestamp`);
  }
  return timestamp;
}

function optionalPositiveInteger(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${context}: expected non-negative integer`);
  }
  return value;
}

function resolveManifestPath(manifestDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(manifestDir, value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeChecks(expertise: ExpertiseYaml, mode: ExpertOutcomeMode): OutcomeCheck[] {
  const checks: OutcomeCheck[] = [
    {
      id: "file-reference",
      matches: (output) => includesAny(output, expertiseFileRefs(expertise)),
    },
    {
      id: "pattern-knowledge",
      matches: (output) => includesAny(output, patternTerms(expertise)),
    },
    {
      id: "pitfall-risk",
      matches: (output) => includesAny(output, pitfallTerms(expertise)),
    },
    {
      id: "validation-command",
      matches: (output) => includesAny(output, validationTerms(expertise)),
    },
  ];

  if (mode === "plan") {
    checks.push({
      id: "stale-knowledge",
      matches: (output) => includesAny(output, ["stale", "staleness", "re-read", "reread", "contradict"]),
    });
  } else if (mode === "review") {
    checks.push({
      id: "review-verdict",
      matches: (output) => includesAny(output, ["verdict", "approve", "approved", "request changes", "blocker"]),
    });
  } else {
    checks.push({
      id: "refresh-artifact",
      matches: (output) => includesAny(output, ["expertise.yaml", "last_updated", "last updated"]),
    });
    checks.push({
      id: "stale-knowledge",
      matches: (output) => includesAny(output, ["stale", "removed", "preserved durable", "durable knowledge", "re-read"]),
    });
  }

  return checks;
}

function expertiseFileRefs(expertise: ExpertiseYaml): string[] {
  const keyFiles = expertise.overview?.key_files ?? [];
  const keyTypes = expertise.key_types ?? [];
  const patterns = expertise.patterns ?? [];
  const pitfalls = expertise.pitfalls ?? [];
  const testPaths = expertise.testing?.test_paths ?? [];
  return unique([
    ...keyFiles.map((file) => file.path),
    ...keyTypes.map((type) => type.path),
    ...patterns.map((pattern) => pattern.example_ref ?? ""),
    ...pitfalls.map((pitfall) => pitfall.reference ?? ""),
    ...testPaths,
  ].flatMap((value) => [value, stripLineRef(value)]));
}

function patternTerms(expertise: ExpertiseYaml): string[] {
  return unique((expertise.patterns ?? []).flatMap((pattern) => [
    pattern.name,
    pattern.description ?? "",
    pattern.example_ref ?? "",
  ]));
}

function pitfallTerms(expertise: ExpertiseYaml): string[] {
  return unique((expertise.pitfalls ?? []).flatMap((pitfall) => [
    pitfall.risk,
    pitfall.consequence ?? "",
    pitfall.reference ?? "",
  ]));
}

function validationTerms(expertise: ExpertiseYaml): string[] {
  return unique([
    expertise.testing?.command ?? "",
    ...(expertise.testing?.test_paths ?? []),
  ]);
}

function includesAny(output: string, terms: string[]): boolean {
  return terms.some((term) => term.length > 0 && output.includes(normalize(term)));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripLineRef(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
