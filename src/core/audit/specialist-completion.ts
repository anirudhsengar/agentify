import { spawnSync } from "node:child_process";
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
const GLOB_SIGNAL = /[*?\[\]{}]/;
const GIT_PATH_CHUNK_SIZE = 128;
const GIT_PATH_CHUNK_CHARACTERS = 12_000;
const GIT_PATH_MAX_BUFFER = 8 * 1024 * 1024;
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
const TEST_DIRECTORY_NAMES = new Set([
  "__tests__",
  "e2e",
  "integration",
  "spec",
  "specs",
  "test",
  "tests",
]);
const DOCUMENTATION_DIRECTORY_NAMES = new Set([
  "doc",
  "docs",
  "documentation",
  "man",
  "manual",
]);
const GENERATED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "target",
  "third_party",
  "vendor",
  "venv",
]);
const AMBIGUOUS_CLUSTER_KEYS = new Set([
  "app",
  "base",
  "common",
  "config",
  "conftest",
  "constants",
  "helper",
  "helpers",
  "index",
  "lib",
  "main",
  "mod",
  "package",
  "setup",
]);

export interface RejectedSpecialistConcern {
  concern: string;
  reasons: string[];
}

export interface RepositoryBehaviorCluster {
  cluster_key: string;
  implementation_paths: string[];
  test_paths: string[];
}

export interface SpecialistEvidenceAssessment {
  complete: boolean;
  source: "concern_evidence" | "legacy_expert_evidence" | "absent";
  reasons: string[];
  high_signal_paths: string[];
  covered_paths: string[];
  exempted_paths: string[];
  uncovered_paths: string[];
  accepted_concerns: string[];
  rejected_concerns: RejectedSpecialistConcern[];
  repository_clusters: RepositoryBehaviorCluster[];
  uncovered_clusters: RepositoryBehaviorCluster[];
}

export interface AuditCompletionResult {
  coverage: CoverageClosureResult;
  specialistEvidenceRecorded: boolean;
  complete: boolean;
}

type RepositoryPathResolver = (value: unknown) => string | null;

interface RepositoryEvidenceContext {
  resolvePath: RepositoryPathResolver;
  trackedFiles: Set<string> | undefined;
}

function normalizeRepositoryPathSyntax(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .replace(/^['"`]+|['"`,;]+$/g, "")
    .replace(PATH_FRAGMENT, "")
    .replace(LINE_SUFFIX, "")
    .replace(DISPLAY_ANNOTATION_SUFFIX, "")
    .replaceAll("\\", "/")
    .trim();
  if (
    !trimmed
    || trimmed === "."
    || trimmed.includes("\0")
    || URL_OR_EXTERNAL.test(trimmed)
    || DRIVE_PREFIX.test(trimmed)
  ) {
    return null;
  }
  const normalized = path.posix.normalize(trimmed).replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.startsWith("/")
    || GLOB_SIGNAL.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function likelyFileWithoutRepository(value: string): boolean {
  const basename = path.posix.basename(value).toLowerCase();
  return basename.includes(".") || WELL_KNOWN_FILE_NAMES.has(basename);
}

function regularFileOnDisk(cwd: string, repositoryPath: string): boolean {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, ...repositoryPath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return false;
  try {
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function gitPathChunks(candidates: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const candidate of candidates) {
    const nextCharacters = characters + candidate.length + 1;
    if (
      current.length > 0
      && (current.length >= GIT_PATH_CHUNK_SIZE || nextCharacters > GIT_PATH_CHUNK_CHARACTERS)
    ) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(candidate);
    characters += candidate.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function trackedRegularFilesAtHead(
  cwd: string,
  candidates: ReadonlyArray<string>,
): { files: Set<string>; complete: boolean } | null {
  const fullTree = spawnSync(
    "git",
    ["-C", cwd, "ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (!fullTree.error && fullTree.status === 0 && typeof fullTree.stdout === "string") {
    const tracked = new Set<string>();
    for (const record of fullTree.stdout.split("\0").filter(Boolean)) {
      const separator = record.indexOf("\t");
      if (separator < 0) continue;
      const metadata = record.slice(0, separator).split(" ");
      if (metadata.length < 3 || metadata[1] !== "blob" || metadata[0] === "120000") continue;
      const repositoryPath = normalizeRepositoryPathSyntax(record.slice(separator + 1));
      if (repositoryPath !== null && !AGENTIFY_GENERATED_PATH.test(repositoryPath)) {
        tracked.add(repositoryPath);
      }
    }
    return { files: tracked, complete: true };
  }

  // A bounded exact-path fallback preserves evidence binding when a platform's
  // Git cannot return the recursive tree in one response. Cluster discovery is
  // unavailable in that degraded mode, but model-proposed paths still fail
  // closed against exact tracked blobs.
  const unique = [...new Set(candidates)].sort((left, right) => left.localeCompare(right));
  const requested = new Set(unique);
  const tracked = new Set<string>();
  for (const chunk of gitPathChunks(unique)) {
    const result = spawnSync(
      "git",
      ["-C", cwd, "--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", ...chunk],
      {
        encoding: "utf8",
        maxBuffer: GIT_PATH_MAX_BUFFER,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
    for (const record of result.stdout.split("\0").filter(Boolean)) {
      const separator = record.indexOf("\t");
      if (separator < 0) continue;
      const metadata = record.slice(0, separator).split(" ");
      if (metadata.length < 3 || metadata[1] !== "blob" || metadata[0] === "120000") continue;
      const repositoryPath = normalizeRepositoryPathSyntax(record.slice(separator + 1));
      if (repositoryPath !== null && requested.has(repositoryPath)) tracked.add(repositoryPath);
    }
  }
  return { files: tracked, complete: false };
}

function filenameStem(repositoryPath: string): string {
  const basename = path.posix.basename(repositoryPath);
  const extension = path.posix.extname(basename);
  return extension.length > 0 ? basename.slice(0, -extension.length) : basename;
}

function isTestRepositoryPath(repositoryPath: string): boolean {
  const segments = repositoryPath.split("/");
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  if (directories.some((segment) => TEST_DIRECTORY_NAMES.has(segment))) return true;
  const stem = filenameStem(repositoryPath);
  return /^(?:test|tests|spec|specs)[._-]+/i.test(stem)
    || /[._-]+(?:test|tests|spec|specs)$/i.test(stem)
    || /(?:Test|Tests|Spec|Specs)$/.test(stem);
}

function clusterKey(repositoryPath: string): string | null {
  let stem = filenameStem(repositoryPath)
    .replace(/^(?:test|tests|spec|specs)[._-]+/i, "")
    .replace(/[._-]+(?:test|tests|spec|specs)$/i, "")
    .replace(/(?:Test|Tests|Spec|Specs)$/, "")
    .replace(/^_+/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (stem.endsWith("-d")) stem = stem.slice(0, -2);
  return stem.length >= 3 && !AMBIGUOUS_CLUSTER_KEYS.has(stem) ? stem : null;
}

function eligibleImplementationPath(repositoryPath: string): boolean {
  if (isTestRepositoryPath(repositoryPath) || isGenericPlumbing(repositoryPath)) return false;
  const directories = repositoryPath.split("/").slice(0, -1).map((segment) => segment.toLowerCase());
  return !directories.some((segment) =>
    DOCUMENTATION_DIRECTORY_NAMES.has(segment) || GENERATED_DIRECTORY_NAMES.has(segment)
  );
}

function discoverRepositoryBehaviorClusters(
  trackedFiles: ReadonlySet<string> | undefined,
): RepositoryBehaviorCluster[] {
  if (trackedFiles === undefined) return [];
  const implementations = new Map<string, string[]>();
  const tests = new Map<string, string[]>();
  for (const repositoryPath of trackedFiles) {
    const key = clusterKey(repositoryPath);
    if (key === null) continue;
    if (isTestRepositoryPath(repositoryPath)) {
      const paths = tests.get(key) ?? [];
      paths.push(repositoryPath);
      tests.set(key, paths);
    } else if (eligibleImplementationPath(repositoryPath)) {
      const paths = implementations.get(key) ?? [];
      paths.push(repositoryPath);
      implementations.set(key, paths);
    }
  }

  const clusters: RepositoryBehaviorCluster[] = [];
  for (const [key, implementationPaths] of implementations) {
    const testPaths = tests.get(key) ?? [];
    // Very broad basename matches are ambiguous in large monorepos. Do not
    // convert them into artificial specialties; require a bounded behavioral
    // unit with a concrete implementation/test mirror.
    if (testPaths.length === 0 || implementationPaths.length > 4 || testPaths.length > 12) continue;
    clusters.push({
      cluster_key: key,
      implementation_paths: [...new Set(implementationPaths)]
        .sort((left, right) => left.localeCompare(right)),
      test_paths: [...new Set(testPaths)]
        .sort((left, right) => left.localeCompare(right)),
    });
  }
  return clusters.sort((left, right) => left.cluster_key.localeCompare(right.cluster_key));
}

function collectPathCandidates(map: CodebaseMap): unknown[] {
  const values: unknown[] = [];
  for (const entry of map.skeleton.entry_points) values.push(entry.path);
  for (const entry of map.skeleton.first_5_files_for_fresh_agent) values.push(entry.path);
  for (const edge of map.module_graph.edges) values.push(edge.from, edge.to);
  for (const cluster of map.module_graph.parallelizable_subtrees) values.push(...cluster);
  values.push(...map.module_graph.shared_abstractions, ...map.module_graph.shared_state);
  if (map.module_graph.client_server_split !== null) {
    values.push(
      map.module_graph.client_server_split.client,
      map.module_graph.client_server_split.server,
    );
  }
  values.push(map.module_graph.monorepo_workspace?.config_file);

  const typeSurface = map.type_contract_surface;
  for (const entry of typeSurface.type_definitions ?? []) values.push(entry.path);
  for (const entry of typeSurface.typescript_interfaces) values.push(entry.path);
  for (const entry of typeSurface.pydantic_models) values.push(entry.path);
  for (const entry of typeSurface.db_models) values.push(entry.path);
  for (const entry of typeSurface.api_contracts ?? []) values.push(entry.path);
  values.push(...(typeSurface.one_type_trace?.flow ?? []));

  for (const pitfall of map.pitfalls) {
    const loose = pitfall as typeof pitfall & { source_reference?: string };
    values.push(loose.source_reference ?? pitfall.module);
  }
  values.push(map.operational_surface.build.recipe_file);

  for (const concern of map.concern_evidence?.concerns ?? []) {
    for (const touchpoint of concern.touchpoints) values.push(touchpoint.path);
    for (const flow of concern.flows) {
      for (const step of flow.steps) values.push(step.path);
    }
    for (const invariant of concern.invariants) values.push(invariant.reference);
    for (const pitfall of concern.pitfalls) values.push(pitfall.reference);
  }
  for (const rejection of map.concern_evidence?.not_concerns ?? []) {
    values.push(rejection.candidate);
  }
  return values;
}

function createRepositoryEvidenceContext(
  map: CodebaseMap,
  cwd: string | undefined,
): RepositoryEvidenceContext {
  if (cwd === undefined) {
    return {
      resolvePath: (value) => {
        const normalized = normalizeRepositoryPathSyntax(value);
        return normalized !== null
          && !AGENTIFY_GENERATED_PATH.test(normalized)
          && likelyFileWithoutRepository(normalized) ? normalized : null;
      },
      trackedFiles: undefined,
    };
  }

  const candidates = collectPathCandidates(map)
    .map(normalizeRepositoryPathSyntax)
    .filter((candidate): candidate is string => candidate !== null);
  const tracked = trackedRegularFilesAtHead(cwd, candidates);
  if (tracked !== null) {
    return {
      resolvePath: (value) => {
        const normalized = normalizeRepositoryPathSyntax(value);
        return normalized !== null
          && !AGENTIFY_GENERATED_PATH.test(normalized)
          && tracked.files.has(normalized) ? normalized : null;
      },
      trackedFiles: tracked.complete ? tracked.files : undefined,
    };
  }

  // Non-git fixtures and temporarily unavailable Git installations retain the
  // previous fail-safe behavior. Production Git repositories use the HEAD tree
  // above, so fetched, generated, ignored, and symlink paths never qualify as
  // specialist evidence merely because they happen to exist on disk.
  return {
    resolvePath: (value) => {
      const normalized = normalizeRepositoryPathSyntax(value);
      return normalized !== null
        && !AGENTIFY_GENERATED_PATH.test(normalized)
        && regularFileOnDisk(cwd, normalized) ? normalized : null;
    },
    trackedFiles: undefined,
  };
}

function addPath(paths: Set<string>, value: unknown, resolvePath: RepositoryPathResolver): void {
  const normalized = resolvePath(value);
  if (normalized !== null) paths.add(normalized);
}

function collectHighSignalPaths(
  map: CodebaseMap,
  resolvePath: RepositoryPathResolver,
): string[] {
  const paths = new Set<string>();
  for (const entry of map.skeleton.entry_points) addPath(paths, entry.path, resolvePath);
  for (const entry of map.skeleton.first_5_files_for_fresh_agent) {
    addPath(paths, entry.path, resolvePath);
  }
  for (const edge of map.module_graph.edges) {
    addPath(paths, edge.from, resolvePath);
    addPath(paths, edge.to, resolvePath);
  }
  for (const cluster of map.module_graph.parallelizable_subtrees) {
    for (const candidate of cluster) addPath(paths, candidate, resolvePath);
  }
  for (const candidate of map.module_graph.shared_abstractions) {
    addPath(paths, candidate, resolvePath);
  }
  for (const candidate of map.module_graph.shared_state) addPath(paths, candidate, resolvePath);
  if (map.module_graph.client_server_split !== null) {
    addPath(paths, map.module_graph.client_server_split.client, resolvePath);
    addPath(paths, map.module_graph.client_server_split.server, resolvePath);
  }
  addPath(paths, map.module_graph.monorepo_workspace?.config_file, resolvePath);

  const typeSurface = map.type_contract_surface;
  for (const entry of typeSurface.type_definitions ?? []) addPath(paths, entry.path, resolvePath);
  for (const entry of typeSurface.typescript_interfaces) addPath(paths, entry.path, resolvePath);
  for (const entry of typeSurface.pydantic_models) addPath(paths, entry.path, resolvePath);
  for (const entry of typeSurface.db_models) addPath(paths, entry.path, resolvePath);
  for (const entry of typeSurface.api_contracts ?? []) addPath(paths, entry.path, resolvePath);
  for (const candidate of typeSurface.one_type_trace?.flow ?? []) {
    addPath(paths, candidate, resolvePath);
  }

  for (const pitfall of map.pitfalls) {
    const loose = pitfall as typeof pitfall & { source_reference?: string };
    addPath(paths, loose.source_reference ?? pitfall.module, resolvePath);
  }
  addPath(paths, map.operational_surface.build.recipe_file, resolvePath);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

interface AssessedConcern {
  concern: string;
  eligible: boolean;
  reasons: string[];
  contextPaths: string[];
}

function assessConcern(
  concern: NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number],
  resolvePath: RepositoryPathResolver,
): AssessedConcern {
  const touchpointPaths = new Set<string>();
  let coreTouchpoints = 0;
  for (const touchpoint of concern.touchpoints) {
    const repositoryPath = resolvePath(touchpoint.path);
    if (repositoryPath === null) continue;
    touchpointPaths.add(repositoryPath);
    if (touchpoint.centrality === "core") coreTouchpoints += 1;
  }

  const flowPaths = new Set<string>();
  let validFlows = 0;
  for (const flow of concern.flows) {
    const verifiedSteps = flow.steps
      .map((step) => resolvePath(step.path))
      .filter((candidate): candidate is string => (
        candidate !== null && touchpointPaths.has(candidate)
      ));
    // A trace is an ordered sequence of observed steps. It may legitimately
    // enter the same orchestration file more than once around another step;
    // requiring distinct file names would reject that real control flow.
    if (verifiedSteps.length < 2) continue;
    validFlows += 1;
    for (const repositoryPath of verifiedSteps) flowPaths.add(repositoryPath);
  }

  const reasons: string[] = [];
  if (touchpointPaths.size === 0) {
    reasons.push("no touchpoint resolves to a regular file tracked at repository HEAD");
  }
  if (coreTouchpoints === 0) {
    reasons.push("no core touchpoint resolves to a regular file tracked at repository HEAD");
  }
  if (concern.flows.length === 0) {
    reasons.push("no end-to-end flow was recorded");
  } else if (validFlows === 0) {
    reasons.push("no flow contains two tracked steps that are also recorded touchpoints");
  }

  return {
    concern: concern.concern,
    eligible: coreTouchpoints > 0 && validFlows > 0,
    reasons,
    contextPaths: [...new Set([...touchpointPaths, ...flowPaths])]
      .sort((left, right) => left.localeCompare(right)),
  };
}

function rejectionScope(value: string): { base: string; subtree: boolean } | null {
  const portable = value.trim().replaceAll("\\", "/");
  const subtree = portable.endsWith("/**") || portable.endsWith("/*") || portable.endsWith("/");
  const baseValue = subtree ? portable.replace(/\/(?:\*\*)?\*?\/?$/, "") : portable;
  const base = normalizeRepositoryPathSyntax(baseValue);
  return base === null ? null : { base, subtree };
}

function rejectionCoversPath(
  rejection: NonNullable<CodebaseMap["concern_evidence"]>["not_concerns"][number],
  candidate: string,
): boolean {
  const scope = rejectionScope(rejection.candidate);
  if (
    scope !== null
    && (candidate === scope.base || (scope.subtree && candidate.startsWith(`${scope.base}/`)))
  ) {
    return true;
  }
  return rejection.why_rejected.includes(candidate);
}

function pathsMentionedByRejections(map: CodebaseMap, candidates: readonly string[]): string[] {
  const mentioned = new Set<string>();
  const rejections = map.concern_evidence?.not_concerns ?? [];
  for (const candidate of candidates) {
    if (rejections.some((entry) => rejectionCoversPath(entry, candidate))) mentioned.add(candidate);
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
      accepted_concerns: [],
      rejected_concerns: [],
      repository_clusters: [],
      uncovered_clusters: [],
    };
  }

  const reasons: string[] = [];
  const repository = createRepositoryEvidenceContext(map, options?.cwd);
  const resolvePath = repository.resolvePath;
  const repositoryClusters = discoverRepositoryBehaviorClusters(repository.trackedFiles);
  const clusterPaths = repositoryClusters.flatMap((cluster) => [
    ...cluster.implementation_paths,
    ...cluster.test_paths,
  ]);
  const highSignal = [...new Set([
    ...collectHighSignalPaths(map, resolvePath),
    ...clusterPaths,
  ])].sort((left, right) => left.localeCompare(right));
  const assessments = map.concern_evidence.concerns.map((concern) =>
    assessConcern(concern, resolvePath)
  );
  const accepted = assessments.filter((assessment) => assessment.eligible);
  const rejected = assessments
    .filter((assessment) => !assessment.eligible)
    .map((assessment): RejectedSpecialistConcern => ({
      concern: assessment.concern,
      reasons: assessment.reasons,
    }));
  const covered = [...new Set(accepted.flatMap((assessment) => assessment.contextPaths))]
    .sort((left, right) => left.localeCompare(right));
  const exempted = pathsMentionedByRejections(map, highSignal);
  const coveredSet = new Set(covered);
  const exemptedSet = new Set(exempted);
  const uncovered = highSignal.filter((candidate) =>
    !coveredSet.has(candidate)
    && !exemptedSet.has(candidate)
    && !isGenericPlumbing(candidate)
  );
  const uncoveredSet = new Set(uncovered);
  const uncoveredClusters = repositoryClusters.filter((cluster) =>
    [...cluster.implementation_paths, ...cluster.test_paths]
      .some((candidate) => uncoveredSet.has(candidate))
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

  const seen = new Set<string>();
  for (const concern of map.concern_evidence.concerns) {
    const key = concern.concern.trim().toLowerCase();
    if (seen.has(key)) reasons.push(`duplicate concern name: ${concern.concern}`);
    seen.add(key);
  }

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
  } else if (accepted.length === 0) {
    reasons.push("no recorded concern has both a tracked core touchpoint and a tracked end-to-end flow");
    const summary = rejected
      .slice(0, 4)
      .map((entry) => `${entry.concern}: ${entry.reasons.join(", ")}`)
      .join("; ");
    if (summary) reasons.push(`rejected concern evidence: ${summary}`);
  }

  const areas = topLevelAreas(highSignal);
  const pathBackedRejections = map.concern_evidence.not_concerns.filter((entry) =>
    highSignal.some((candidate) => rejectionCoversPath(entry, candidate))
  ).length;
  if (
    accepted.length === 1
    && highSignal.length >= 6
    && areas.length >= 3
    && pathBackedRejections < 2
    && !singleSpecialtyJustified(map)
  ) {
    reasons.push(
      "thin specialist portfolio: one concern spans a non-trivial multi-area repository without path-backed adjacent-concern rejections or a substantive single-specialty justification",
    );
  }

  if (uncoveredClusters.length > 0) {
    const summary = uncoveredClusters.slice(0, 8).map((cluster) => {
      const paths = [...cluster.implementation_paths, ...cluster.test_paths];
      return `${cluster.cluster_key} [${paths.slice(0, 4).join(", ")}${paths.length > 4 ? ", …" : ""}]`;
    }).join("; ");
    reasons.push(
      `repository implementation/test clusters are neither covered by an accepted concern nor explicitly rejected: ${summary}${uncoveredClusters.length > 8 ? "; …" : ""}`,
    );
  }
  const clusterPathSet = new Set(clusterPaths);
  const unclustered = uncovered.filter((candidate) => !clusterPathSet.has(candidate));
  if (unclustered.length > 0) {
    reasons.push(
      `high-signal repository files are neither covered by an accepted concern nor explicitly rejected: ${unclustered.slice(0, 12).join(", ")}${unclustered.length > 12 ? ", …" : ""}`,
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
    accepted_concerns: accepted.map((assessment) => assessment.concern)
      .sort((left, right) => left.localeCompare(right)),
    rejected_concerns: rejected.sort((left, right) => left.concern.localeCompare(right.concern)),
    repository_clusters: repositoryClusters,
    uncovered_clusters: uncoveredClusters,
  };
}

/**
 * Remove concern candidates that trusted evidence binding rejected while
 * preserving the rejection decision in `not_concerns`.
 *
 * The audit map is model-authored evidence, whereas the installed specialist
 * portfolio is a trusted projection over Git-tracked blobs. Reconciliation
 * keeps those two layers aligned: fetched dependencies and generated artifacts
 * remain visible as rejected audit hypotheses, but never become agents.
 */
export function reconcileSpecialistEvidence(
  map: CodebaseMap,
  assessment: SpecialistEvidenceAssessment,
): CodebaseMap {
  if (
    !assessment.complete
    || assessment.source !== "concern_evidence"
    || map.concern_evidence === undefined
  ) {
    return map;
  }

  const accepted = new Set(assessment.accepted_concerns);
  const concerns = map.concern_evidence.concerns.filter((concern) =>
    accepted.has(concern.concern)
  );
  const notConcerns = [...map.concern_evidence.not_concerns];
  const existingCandidates = new Set(notConcerns.map((entry) => entry.candidate.trim().toLowerCase()));
  for (const rejected of assessment.rejected_concerns) {
    const key = rejected.concern.trim().toLowerCase();
    if (existingCandidates.has(key)) continue;
    notConcerns.push({
      candidate: rejected.concern,
      why_rejected:
        `Trusted evidence binding rejected this concern: ${rejected.reasons.join("; ")}.`,
    });
    existingCandidates.add(key);
  }
  const openQuestions = map.open_questions.filter((question) =>
    !PLACEHOLDER_QUESTION.test(question.trim())
  );
  const concernsChanged = concerns.length !== map.concern_evidence.concerns.length;
  const rejectionsChanged = notConcerns.length !== map.concern_evidence.not_concerns.length;
  const questionsChanged = openQuestions.length !== map.open_questions.length;
  if (!concernsChanged && !rejectionsChanged && !questionsChanged) return map;

  return {
    ...map,
    open_questions: openQuestions,
    concern_evidence: {
      concerns,
      not_concerns: notConcerns,
    },
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
