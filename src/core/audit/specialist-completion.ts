import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "./schema/index.ts";
import {
  assessCoverageClosure,
  type CoverageClosureOptions,
  type CoverageClosureResult,
} from "./coverage.ts";

const URL_OR_EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|@)/i;
const PATH_FRAGMENT = /#.*$/;
const LINE_SUFFIX = /:(?:L)?\d+(?:-(?:L)?\d+)?$/i;
const DISPLAY_ANNOTATION_SUFFIX = /\s+\([^/\r\n]+\)$/;
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const PLACEHOLDER_QUESTION = /^(?:initial draft|todo|unknown|tbd|gather\b|not observed)/i;
const AGENTIFY_GENERATED_PATH = /^(?:\.agentify(?:\/|$)|\.github\/agentify(?:\/|$))/;
const WELL_KNOWN_FILE_NAMES = new Set([
  "dockerfile",
  "gemfile",
  "justfile",
  "license",
  "makefile",
  "procfile",
  "rakefile",
  "readme",
]);
const GENERIC_PLUMBING_FILES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "gemfile",
  "go.mod",
  "makefile",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "readme",
  "readme.md",
]);

export interface SpecialistEvidenceAssessment {
  complete: boolean;
  source: "concern_evidence" | "legacy_expert_evidence" | "absent";
  reasons: string[];
  high_signal_paths: string[];
  covered_paths: string[];
  exempted_paths: string[];
  uncovered_paths: string[];
}

export interface AuditCompletionResult {
  coverage: CoverageClosureResult;
  specialistEvidenceRecorded: boolean;
  complete: boolean;
}

function normalizeRepositoryPath(value: unknown, cwd?: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .replace(/^['"`]+|['"`,;]+$/g, "")
    .replace(PATH_FRAGMENT, "")
    .replace(LINE_SUFFIX, "")
    .replace(DISPLAY_ANNOTATION_SUFFIX, "")
    .replaceAll("\\", "/")
    .trim();
  if (!trimmed || trimmed === "." || URL_OR_EXTERNAL.test(trimmed) || DRIVE_PREFIX.test(trimmed)) {
    return null;
  }
  const normalized = path.posix.normalize(trimmed).replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.startsWith("/")
  ) {
    return null;
  }

  if (cwd !== undefined) {
    const root = path.resolve(cwd);
    const absolute = path.resolve(root, ...normalized.split("/"));
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return normalized;
  }

  const basename = path.posix.basename(normalized).toLowerCase();
  if (!basename.includes(".") && !WELL_KNOWN_FILE_NAMES.has(basename)) return null;
  return normalized;
}

function addPath(paths: Set<string>, value: unknown, cwd?: string): void {
  const normalized = normalizeRepositoryPath(value, cwd);
  if (normalized !== null) paths.add(normalized);
}

function collectHighSignalPaths(map: CodebaseMap, cwd?: string): string[] {
  const paths = new Set<string>();
  for (const entry of map.skeleton.entry_points) addPath(paths, entry.path, cwd);
  for (const entry of map.skeleton.first_5_files_for_fresh_agent) addPath(paths, entry.path, cwd);
  for (const edge of map.module_graph.edges) {
    addPath(paths, edge.from, cwd);
    addPath(paths, edge.to, cwd);
  }
  for (const cluster of map.module_graph.parallelizable_subtrees) {
    for (const candidate of cluster) addPath(paths, candidate, cwd);
  }
  for (const candidate of map.module_graph.shared_abstractions) addPath(paths, candidate, cwd);
  for (const candidate of map.module_graph.shared_state) addPath(paths, candidate, cwd);
  if (map.module_graph.client_server_split !== null) {
    addPath(paths, map.module_graph.client_server_split.client, cwd);
    addPath(paths, map.module_graph.client_server_split.server, cwd);
  }
  addPath(paths, map.module_graph.monorepo_workspace?.config_file, cwd);

  const typeSurface = map.type_contract_surface;
  for (const entry of typeSurface.type_definitions ?? []) addPath(paths, entry.path, cwd);
  for (const entry of typeSurface.typescript_interfaces) addPath(paths, entry.path, cwd);
  for (const entry of typeSurface.pydantic_models) addPath(paths, entry.path, cwd);
  for (const entry of typeSurface.db_models) addPath(paths, entry.path, cwd);
  for (const entry of typeSurface.api_contracts ?? []) addPath(paths, entry.path, cwd);
  for (const candidate of typeSurface.one_type_trace?.flow ?? []) addPath(paths, candidate, cwd);

  for (const pitfall of map.pitfalls) {
    const loose = pitfall as typeof pitfall & { source_reference?: string };
    addPath(paths, loose.source_reference ?? pitfall.module, cwd);
  }
  addPath(paths, map.operational_surface.build.recipe_file, cwd);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function collectConcernPaths(map: CodebaseMap, cwd?: string): string[] {
  const paths = new Set<string>();
  for (const concern of map.concern_evidence?.concerns ?? []) {
    for (const touchpoint of concern.touchpoints) addPath(paths, touchpoint.path, cwd);
    for (const flow of concern.flows) {
      for (const step of flow.steps) addPath(paths, step.path, cwd);
    }
    for (const invariant of concern.invariants) addPath(paths, invariant.reference, cwd);
    for (const pitfall of concern.pitfalls) addPath(paths, pitfall.reference, cwd);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function pathsMentionedByRejections(map: CodebaseMap, candidates: readonly string[]): string[] {
  const mentioned = new Set<string>();
  const rejections = map.concern_evidence?.not_concerns ?? [];
  for (const candidate of candidates) {
    if (rejections.some((entry) => entry.why_rejected.includes(candidate))) mentioned.add(candidate);
  }
  return [...mentioned].sort((left, right) => left.localeCompare(right));
}

function isGenericPlumbing(candidate: string): boolean {
  const basename = path.posix.basename(candidate).toLowerCase();
  return GENERIC_PLUMBING_FILES.has(basename)
    || /^(?:index|main|lib)\.[a-z0-9]+$/i.test(basename);
}

function topLevelAreas(paths: readonly string[]): string[] {
  const areas = new Set<string>();
  for (const candidate of paths) {
    const slash = candidate.indexOf("/");
    areas.add(slash === -1 ? "(root)" : candidate.slice(0, slash));
  }
  return [...areas].sort((left, right) => left.localeCompare(right));
}

function substantiveQuestion(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 24 && !PLACEHOLDER_QUESTION.test(trimmed);
}

function singleSpecialtyJustified(map: CodebaseMap): boolean {
  return map.open_questions.some((question) =>
    substantiveQuestion(question)
    && /(?:single|one)\s+(?:cohesive\s+)?specialt|no\s+distinct\s+specialt|self-contained\s+specialt/i.test(question)
  );
}

function validateConcernShape(map: CodebaseMap, cwd: string | undefined, reasons: string[]): void {
  const seen = new Set<string>();
  for (const concern of map.concern_evidence?.concerns ?? []) {
    const key = concern.concern.trim().toLowerCase();
    if (seen.has(key)) reasons.push(`duplicate concern name: ${concern.concern}`);
    seen.add(key);

    if (concern.flows.length === 0) {
      reasons.push(`${concern.concern}: no end-to-end flow was recorded`);
    }
    for (const flow of concern.flows) {
      const verifiedSteps = new Set(
        flow.steps
          .map((step) => normalizeRepositoryPath(step.path, cwd))
          .filter((candidate): candidate is string => candidate !== null),
      );
      if (verifiedSteps.size < 2) {
        reasons.push(`${concern.concern}: flow '${flow.name}' does not contain two verified steps`);
      }
    }

    const coreTouchpoints = concern.touchpoints.filter((touchpoint) =>
      touchpoint.centrality === "core" && normalizeRepositoryPath(touchpoint.path, cwd) !== null
    );
    if (coreTouchpoints.length === 0) {
      reasons.push(`${concern.concern}: no verified core touchpoint was recorded`);
    }
  }
}

export function assessSpecialistEvidence(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): SpecialistEvidenceAssessment {
  if (map.concern_evidence === undefined) {
    const legacy = map.expert_evidence !== undefined;
    return {
      complete: legacy,
      source: legacy ? "legacy_expert_evidence" : "absent",
      reasons: legacy ? [] : ["concern_evidence is absent"],
      high_signal_paths: [],
      covered_paths: [],
      exempted_paths: [],
      uncovered_paths: [],
    };
  }

  const reasons: string[] = [];
  const cwd = options?.cwd;
  const highSignal = collectHighSignalPaths(map, cwd);
  const covered = collectConcernPaths(map, cwd);
  const exempted = pathsMentionedByRejections(map, highSignal);
  const coveredSet = new Set(covered);
  const exemptedSet = new Set(exempted);
  const uncovered = highSignal.filter((candidate) =>
    !coveredSet.has(candidate)
    && !exemptedSet.has(candidate)
    && !isGenericPlumbing(candidate)
  );

  if (
    map.meta.project_type.trim().length === 0
    || map.meta.project_type.trim().toLowerCase() === "unknown"
  ) {
    reasons.push("repository project_type is still unknown");
  }
  if (
    map.meta.languages.length === 0
    || map.meta.languages.some((language) => language.trim().toLowerCase() === "unknown")
  ) {
    reasons.push("repository languages/formats were not identified");
  }
  if (map.skeleton.top_level_tree.some((entry) => AGENTIFY_GENERATED_PATH.test(entry.trim()))) {
    reasons.push("repository topography includes Agentify-generated paths");
  }
  if (map.meta.lifecycle.agent_definitions.paths.some((entry) => AGENTIFY_GENERATED_PATH.test(entry.trim()))) {
    reasons.push("repository process evidence treats Agentify-generated identities as application architecture");
  }

  validateConcernShape(map, cwd, reasons);
  const concerns = map.concern_evidence.concerns;
  if (concerns.length === 0) {
    if (highSignal.length > 2) {
      reasons.push(`empty concern portfolio for a non-trivial repository (${highSignal.length} high-signal files)`);
    }
    if (map.concern_evidence.not_concerns.length === 0) {
      reasons.push("empty concern portfolio has no rejected candidates");
    }
    if (!map.open_questions.some(substantiveQuestion)) {
      reasons.push("empty concern portfolio has no substantive justification in open_questions");
    }
  }

  const areas = topLevelAreas(highSignal);
  const pathBackedRejections = map.concern_evidence.not_concerns.filter((entry) =>
    highSignal.some((candidate) => entry.why_rejected.includes(candidate))
  ).length;
  if (
    concerns.length === 1
    && highSignal.length >= 6
    && areas.length >= 3
    && pathBackedRejections < 2
    && !singleSpecialtyJustified(map)
  ) {
    reasons.push(
      "thin specialist portfolio: one concern spans a non-trivial multi-area repository without path-backed adjacent-concern rejections or a substantive single-specialty justification",
    );
  }

  if (uncovered.length > 0) {
    reasons.push(
      `high-signal repository files are neither covered by a concern nor explicitly rejected: ${uncovered.slice(0, 12).join(", ")}${uncovered.length > 12 ? ", …" : ""}`,
    );
  }

  return {
    complete: reasons.length === 0,
    source: "concern_evidence",
    reasons,
    high_signal_paths: highSignal,
    covered_paths: covered,
    exempted_paths: exempted,
    uncovered_paths: uncovered,
  };
}

/** Field-presence signal retained for write-map feedback and legacy callers. */
export function specialistEvidenceRecorded(map: CodebaseMap): boolean {
  return map.concern_evidence !== undefined || map.expert_evidence !== undefined;
}

export function assessAuditCompletion(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): AuditCompletionResult {
  const coverage = assessCoverageClosure(map, options);
  const specialistAssessment = assessSpecialistEvidence(map, options);
  return {
    coverage,
    specialistEvidenceRecorded: specialistAssessment.complete,
    complete: coverage.unresolved.length === 0 && specialistAssessment.complete,
  };
}
