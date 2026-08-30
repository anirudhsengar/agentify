import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "./schema/index.ts";
import {
  explicitlyAcceptsConcern,
  isSubstantiveConcernRejection,
} from "./concern-rejection.ts";
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
const MODULE_EDGE_MAX_FILES = 512;
const MODULE_EDGE_MAX_BUFFER = 16 * 1024 * 1024;
const MODULE_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
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
const AUXILIARY_DIRECTORY_NAMES = new Set(["example", "examples", "fixture", "fixtures"]);
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
  "type",
  "types",
]);

export interface RejectedSpecialistConcern {
  concern: string;
  reasons: string[];
}

export interface AuxiliaryDuplicateConcern {
  concern: string;
  paths: string[];
  overlapping_concerns: string[];
}

export interface RepositoryBehaviorCluster {
  cluster_key: string;
  implementation_paths: string[];
  test_paths: string[];
  kind?: "workspace-public-surface" | "inline-tested-surface";
}

export interface RepositoryConcernAttachment {
  concern: string;
  paths: string[];
  reason: string;
}

export interface RepositoryCoreOwnershipResolution {
  concern: string;
  path: string;
  reason: string;
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
  auxiliary_duplicate_concerns: AuxiliaryDuplicateConcern[];
  repository_clusters: RepositoryBehaviorCluster[];
  uncovered_clusters: RepositoryBehaviorCluster[];
  attachments: RepositoryConcernAttachment[];
  core_ownership_resolutions: RepositoryCoreOwnershipResolution[];
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
  cwd: string | undefined;
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

function clusterStem(repositoryPath: string): string | null {
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

const SOURCE_ROOT_DIRECTORY_NAMES = new Set(["app", "lib", "pkg", "src"]);

function directorySegments(repositoryPath: string): string[] {
  const directory = path.posix.dirname(repositoryPath);
  return directory === "." ? [] : directory.split("/").filter(Boolean);
}

function localitySegments(repositoryPath: string): string[] {
  const segments = directorySegments(repositoryPath);
  while (
    segments.length > 0
    && (SOURCE_ROOT_DIRECTORY_NAMES.has(segments[0]!.toLowerCase())
      || TEST_DIRECTORY_NAMES.has(segments[0]!.toLowerCase()))
  ) {
    segments.shift();
  }
  return segments.filter((segment) => !TEST_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

function commonSuffixLength(left: readonly string[], right: readonly string[]): number {
  let length = 0;
  while (
    length < left.length
    && length < right.length
    && left[left.length - length - 1] === right[right.length - length - 1]
  ) length += 1;
  return length;
}

function conventionalTopLevelTest(repositoryPath: string): boolean {
  const first = repositoryPath.split("/")[0]?.toLowerCase();
  return first !== undefined && TEST_DIRECTORY_NAMES.has(first);
}

function clusterLocalityScore(implementationPath: string, testPath: string): number {
  const implementationDirectory = path.posix.dirname(implementationPath);
  const testDirectory = path.posix.dirname(testPath);
  if (implementationDirectory === testDirectory) return 1_000;
  const implementationLocality = localitySegments(implementationPath);
  const testLocality = localitySegments(testPath);
  if (
    implementationLocality.length > 0
    && implementationLocality.join("/") === testLocality.join("/")
  ) return 800;
  return commonSuffixLength(implementationLocality, testLocality) * 120
    + commonPrefixLength(implementationLocality, testLocality) * 40;
}

function eligibleImplementationPath(repositoryPath: string): boolean {
  if (isTestRepositoryPath(repositoryPath) || isGenericPlumbing(repositoryPath)) return false;
  const directories = repositoryPath.split("/").slice(0, -1).map((segment) => segment.toLowerCase());
  return !directories.some((segment) =>
    DOCUMENTATION_DIRECTORY_NAMES.has(segment)
    || GENERATED_DIRECTORY_NAMES.has(segment)
  );
}

function independentCoreImplementationPath(repositoryPath: string): boolean {
  if (!eligibleImplementationPath(repositoryPath)) return false;
  return !repositoryPath.split("/").slice(0, -1)
    .some((segment) => AUXILIARY_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

function auxiliaryRepositoryPath(repositoryPath: string): boolean {
  return repositoryPath.split("/").slice(0, -1)
    .some((segment) => AUXILIARY_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

const PACKAGE_MANIFEST_NAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "gemfile",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
]);

const PUBLIC_ENTRY_BASENAMES = new Set([
  "__init__.py",
  "index.js",
  "index.jsx",
  "index.ts",
  "index.tsx",
  "lib.js",
  "lib.rs",
  "lib.ts",
  "main.go",
  "main.js",
  "main.rs",
  "main.ts",
]);

const PACKAGE_ROOT_EXCLUSIONS = new Set([
  ...DOCUMENTATION_DIRECTORY_NAMES,
  ...GENERATED_DIRECTORY_NAMES,
  ...TEST_DIRECTORY_NAMES,
  "example",
  "examples",
  "fixture",
  "fixtures",
]);

function packageRootForManifest(repositoryPath: string): string {
  const directory = path.posix.dirname(repositoryPath);
  return directory === "." ? "" : directory;
}

function packageRootAllowed(packageRoot: string): boolean {
  return !packageRoot.split("/").filter(Boolean)
    .some((segment) => PACKAGE_ROOT_EXCLUSIONS.has(segment.toLowerCase()));
}

function trackedPath(packageRoot: string, relativePath: string): string {
  return packageRoot.length === 0 ? relativePath : `${packageRoot}/${relativePath}`;
}

function repositoryTextFile(cwd: string, repositoryPath: string): string | null {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, ...repositoryPath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function rustPublicModulePaths(
  packageRoot: string,
  crateRoot: string,
  trackedFiles: ReadonlySet<string>,
  cwd: string,
): string[] {
  const content = repositoryTextFile(cwd, crateRoot);
  if (content === null) return [];
  const sourceRoot = trackedPath(packageRoot, "src");
  const paths = new Set<string>();
  const declaration = /^\s*pub\s+mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
  for (const match of content.matchAll(declaration)) {
    const moduleName = match[1];
    if (moduleName === undefined) continue;
    for (const candidate of [
      `${sourceRoot}/${moduleName}.rs`,
      `${sourceRoot}/${moduleName}/mod.rs`,
    ]) {
      if (trackedFiles.has(candidate)) paths.add(candidate);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function containsInlineTests(cwd: string, repositoryPath: string): boolean {
  if (!repositoryPath.endsWith(".rs") || isTestRepositoryPath(repositoryPath)) return false;
  const content = repositoryTextFile(cwd, repositoryPath);
  return content !== null && (
    /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(content)
    || /(?:^|\n)\s*mod\s+tests\s*\{/.test(content)
  );
}

function discoverPackageSurfaceClusters(
  trackedFiles: ReadonlySet<string>,
  cwd: string | undefined,
): RepositoryBehaviorCluster[] {
  if (cwd === undefined) return [];
  const clusters: RepositoryBehaviorCluster[] = [];
  const packageRoots = [...trackedFiles]
    .filter((repositoryPath) =>
      PACKAGE_MANIFEST_NAMES.has(path.posix.basename(repositoryPath).toLowerCase())
    )
    .map(packageRootForManifest)
    .filter(packageRootAllowed)
    .sort((left, right) => left.localeCompare(right));

  for (const packageRoot of [...new Set(packageRoots)]) {
    const publicPaths = new Set<string>();
    const sourcePrefix = trackedPath(packageRoot, "src/");
    for (const repositoryPath of trackedFiles) {
      if (!repositoryPath.startsWith(sourcePrefix)) continue;
      const relative = repositoryPath.slice(sourcePrefix.length);
      if (!relative.includes("/") && PUBLIC_ENTRY_BASENAMES.has(relative.toLowerCase())) {
        publicPaths.add(repositoryPath);
      }
    }

    for (const crateRoot of [...publicPaths].filter((repositoryPath) =>
      repositoryPath.endsWith("/src/lib.rs") || repositoryPath === "src/lib.rs"
    )) {
      for (const modulePath of rustPublicModulePaths(
        packageRoot,
        crateRoot,
        trackedFiles,
        cwd,
      )) {
        publicPaths.add(modulePath);
      }
    }

    for (const repositoryPath of [...publicPaths].sort((left, right) =>
      left.localeCompare(right)
    )) {
      clusters.push({
        cluster_key: `public-surface@${repositoryPath}`,
        implementation_paths: [repositoryPath],
        test_paths: containsInlineTests(cwd, repositoryPath) ? [repositoryPath] : [],
        kind: "workspace-public-surface",
      });
    }

    for (const repositoryPath of trackedFiles) {
      if (!repositoryPath.startsWith(sourcePrefix) || publicPaths.has(repositoryPath)) continue;
      if (!containsInlineTests(cwd, repositoryPath)) continue;
      clusters.push({
        cluster_key: `inline-tests@${repositoryPath}`,
        implementation_paths: [repositoryPath],
        test_paths: [repositoryPath],
        kind: "inline-tested-surface",
      });
    }
  }

  return clusters.sort((left, right) => left.cluster_key.localeCompare(right.cluster_key));
}

function discoverRepositoryBehaviorClusters(
  trackedFiles: ReadonlySet<string> | undefined,
  cwd?: string,
): RepositoryBehaviorCluster[] {
  if (trackedFiles === undefined) return [];
  const implementations = new Map<string, string[]>();
  const tests = new Map<string, string[]>();
  for (const repositoryPath of trackedFiles) {
    const key = clusterStem(repositoryPath);
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
  for (const [stem, implementationValues] of implementations) {
    const implementationPaths = [...new Set(implementationValues)]
      .sort((left, right) => left.localeCompare(right));
    const testPaths = [...new Set(tests.get(stem) ?? [])]
      .sort((left, right) => left.localeCompare(right));
    if (testPaths.length === 0) continue;
    const assigned = new Map<string, string[]>();
    for (const testPath of testPaths) {
      const ranked = implementationPaths.map((implementationPath) => ({
        implementationPath,
        score: clusterLocalityScore(implementationPath, testPath),
      })).sort((left, right) => right.score - left.score
        || left.implementationPath.localeCompare(right.implementationPath));
      const best = ranked[0];
      if (best === undefined) continue;
      const tied = ranked.filter((candidate) => candidate.score === best.score);
      const conventionalFallback = implementationPaths.length === 1
        && conventionalTopLevelTest(testPath);
      if (tied.length !== 1 || (best.score < 40 && !conventionalFallback)) continue;
      const paths = assigned.get(best.implementationPath) ?? [];
      paths.push(testPath);
      assigned.set(best.implementationPath, paths);
    }

    for (const implementationPath of implementationPaths) {
      const matchedTests = assigned.get(implementationPath) ?? [];
      if (matchedTests.length === 0) continue;
      const locality = path.posix.dirname(implementationPath);
      clusters.push({
        cluster_key: implementationPaths.length === 1 ? stem : `${stem}@${locality}`,
        implementation_paths: [implementationPath],
        test_paths: matchedTests.sort((left, right) => left.localeCompare(right)),
      });
    }
  }
  const combined = [
    ...clusters,
    ...discoverPackageSurfaceClusters(trackedFiles, cwd),
  ];
  const seen = new Set<string>();
  return combined
    .filter((cluster) => {
      const key = [
        cluster.kind ?? "source-test-mirror",
        cluster.cluster_key,
        ...cluster.implementation_paths,
        "|",
        ...cluster.test_paths,
      ].join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.cluster_key.localeCompare(right.cluster_key));
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
      cwd: undefined,
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
      cwd: tracked.complete ? cwd : undefined,
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
    cwd: undefined,
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
  corePaths: string[];
}

type ConcernRecord = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];
type RejectionRecord = NonNullable<CodebaseMap["concern_evidence"]>["not_concerns"][number];

function assessConcern(
  concern: NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number],
  resolvePath: RepositoryPathResolver,
): AssessedConcern {
  const touchpointPaths = new Set<string>();
  const coreTouchpointPaths = new Set<string>();
  let coreTouchpoints = 0;
  for (const touchpoint of concern.touchpoints) {
    const repositoryPath = resolvePath(touchpoint.path);
    if (repositoryPath === null) continue;
    touchpointPaths.add(repositoryPath);
    if (touchpoint.centrality === "core") {
      coreTouchpoints += 1;
      coreTouchpointPaths.add(repositoryPath);
    }
  }

  const flowPaths = new Set<string>();
  let validFlows = 0;
  for (const flow of concern.flows) {
    const verifiedSteps = flow.steps
      .map((step) => ({
        path: resolvePath(step.path),
        operation: step.what_happens.trim().toLowerCase(),
      }))
      .filter((candidate): candidate is { path: string; operation: string } => candidate.path !== null);
    const distinctOperations = new Set(verifiedSteps.map((step) => `${step.path}\0${step.operation}`));
    if (verifiedSteps.length < 2 || distinctOperations.size < 2) continue;
    validFlows += 1;
    for (const step of verifiedSteps) flowPaths.add(step.path);
  }

  const referencedPaths = new Set<string>();
  for (const invariant of concern.invariants) {
    const repositoryPath = resolvePath(invariant.reference);
    if (repositoryPath !== null) referencedPaths.add(repositoryPath);
  }
  for (const pitfall of concern.pitfalls) {
    const repositoryPath = resolvePath(pitfall.reference);
    if (repositoryPath !== null) referencedPaths.add(repositoryPath);
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
    reasons.push("no flow contains two distinct ordered operations in tracked repository files");
  }

  return {
    concern: concern.concern,
    eligible: coreTouchpoints > 0 && validFlows > 0,
    reasons,
    contextPaths: [...new Set([...touchpointPaths, ...flowPaths, ...referencedPaths])]
      .sort((left, right) => left.localeCompare(right)),
    corePaths: [...coreTouchpointPaths]
      .sort((left, right) => left.localeCompare(right)),
  };
}

const SEMANTIC_STOP_WORDS = new Set([
  "and", "behavior", "contract", "core", "end", "file", "implementation", "integration",
  "module", "repository", "runtime", "supporting", "test", "tests", "through", "with",
]);

const WEAK_ATTACHMENT_TOKENS = new Set([
  "accept", "body", "client", "component", "context", "handler", "path", "request",
  "response", "server", "type", "url", "util", "utility", "value",
]);

function semanticTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || SEMANTIC_STOP_WORDS.has(raw)) continue;
    const token = raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    tokens.add(token);
  }
  return tokens;
}

function tokensRelated(left: string, right: string): boolean {
  return left === right
    || (Math.min(left.length, right.length) >= 4
      && (left.startsWith(right) || right.startsWith(left)));
}

function concernSemanticTokens(
  concern: NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number],
): Set<string> {
  const values: string[] = [
    concern.concern,
    concern.one_line,
    concern.covers,
    ...concern.flows.flatMap((flow) => [flow.name, flow.description]),
    ...concern.touchpoints.flatMap((touchpoint) => [
      touchpoint.path,
      touchpoint.role,
      touchpoint.symbol ?? "",
    ]),
  ];
  return semanticTokens(values.join(" "));
}

function pathSemanticTokens(paths: readonly string[], label: string): Set<string> {
  // Directory names are useful for locality scoring but are weak semantic
  // evidence. Including them here lets a repository or package name make
  // every sibling implementation look related to one accepted concern.
  // Compare only the behavioral label and file stems; path affinity is
  // evaluated independently by directoryAffinity().
  const stems = paths.map((repositoryPath) => filenameStem(repositoryPath));
  return semanticTokens(`${label.split("@", 1)[0] ?? label} ${stems.join(" ")}`);
}

const NON_BEHAVIORAL_LOCALITY_SEGMENTS = new Set([
  "common", "helper", "helpers", "internal", "shared", "util", "utils", "utilities",
]);

function pathLocalityTokens(paths: readonly string[]): Set<string> {
  return semanticTokens(paths.flatMap((repositoryPath) =>
    localitySegments(repositoryPath).filter((segment) =>
      !NON_BEHAVIORAL_LOCALITY_SEGMENTS.has(segment.toLowerCase())
    )
  ).join(" "));
}

function pathLocalityDepth(paths: readonly string[]): number {
  return Math.max(...paths.map((repositoryPath) =>
    localitySegments(repositoryPath).filter((segment) =>
      !NON_BEHAVIORAL_LOCALITY_SEGMENTS.has(segment.toLowerCase())
    ).length
  ), 0);
}

function matchingTokenCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let matches = 0;
  for (const token of left) {
    if ([...right].some((other) => tokensRelated(token, other))) matches += 1;
  }
  return matches;
}

function delegatedOwnerDescription(value: string): string | null {
  return /\bsubsum(?:e|ed|es|ing)\s+by\s+(?:the\s+)?([^.;\n]{3,160})/i.exec(value)?.[1]?.trim()
    ?? null;
}

function rejectionHasGroundedDisposition(
  rejection: RejectionRecord,
  acceptedConcerns: readonly ConcernRecord[],
): boolean {
  if (rejection.grouped_into !== undefined) {
    return acceptedConcerns.some((concern) => concern.concern === rejection.grouped_into);
  }
  const delegatedOwner = delegatedOwnerDescription(rejection.why_rejected);
  if (delegatedOwner === null) return true;
  const delegatedTokens = semanticTokens(delegatedOwner);
  return acceptedConcerns.some((concern) =>
    matchingTokenCount(
      delegatedTokens,
      semanticTokens(`${concern.concern} ${concern.one_line} ${concern.covers}`),
    ) >= 2
  );
}

function concernExclusionPaths(concern: ConcernRecord, trackedFiles?: ReadonlySet<string>): string[] {
  return [...concern.excludes.matchAll(
    /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+)/g,
  )].flatMap((match) => match[1] ? [match[1].replace(/\*+$/, "").replace(/\/$/, "")] : [])
    .filter((excludedPath) => trackedFiles === undefined || [...trackedFiles].some((repositoryPath) =>
      excludedPathCoversRepositoryPath(excludedPath, repositoryPath)
    ));
}

function excludedPathCoversRepositoryPath(excludedPath: string, repositoryPath: string): boolean {
  return repositoryPath === excludedPath
    || repositoryPath.startsWith(`${excludedPath}/`)
    || repositoryPath.endsWith(`/${excludedPath}`)
    || repositoryPath.includes(`/${excludedPath}/`);
}

function attachmentConflictsWithExclusions(
  candidate: AttachmentConcernCandidate,
  paths: readonly string[],
  label: string,
  inferred = false,
): boolean {
  const clusterTokens = new Set([
    ...pathSemanticTokens(paths, label),
    ...pathLocalityTokens(paths),
  ]);
  const exclusionPaths = candidate.exclusionPaths;
  const pathExclusionApplies = exclusionPaths.some((excludedPath) =>
    paths.some((repositoryPath) => excludedPathCoversRepositoryPath(excludedPath, repositoryPath))
  );
  const pathTokens = semanticTokens(exclusionPaths.join(" "));
  const effectiveExcludedTokens = pathExclusionApplies
    ? candidate.excludedTokens
    : new Set([...candidate.excludedTokens].filter((token) => !pathTokens.has(token)));
  const matched = [...clusterTokens].filter((token) =>
    [...effectiveExcludedTokens].some((excluded) => tokensRelated(token, excluded))
  );
  if (pathExclusionApplies) return true;
  if (inferred && [...clusterTokens].some((token) =>
    !WEAK_ATTACHMENT_TOKENS.has(token) && effectiveExcludedTokens.has(token)
  )) return true;
  if (inferred && matched.length >= 2) return true;
  if (matched.length >= 2) return true;
  if (
    matched.length > 0
    && /\bother\b[^.]{0,160}\b(?:remain|kept)\s+separate\b/i.test(candidate.concern.excludes)
  ) return true;
  return matched.some((token) =>
    ![...candidate.tokens].some((positive) => tokensRelated(token, positive))
  );
}

function attachmentHasPathExclusion(
  candidate: AttachmentConcernCandidate,
  paths: readonly string[],
): boolean {
  return candidate.exclusionPaths.some((excludedPath) =>
    paths.some((repositoryPath) => excludedPathCoversRepositoryPath(excludedPath, repositoryPath))
  );
}

function directoryAffinity(candidate: string, contextPath: string): number {
  if (candidate === contextPath) return 2_000;
  const candidateDirectory = path.posix.dirname(candidate);
  const contextDirectory = path.posix.dirname(contextPath);
  if (candidateDirectory === contextDirectory) return candidateDirectory === "." ? 400 : 900;
  const candidateSegments = directorySegments(candidate);
  const contextSegments = directorySegments(contextPath);
  const prefix = commonPrefixLength(candidateSegments, contextSegments);
  const suffix = commonSuffixLength(candidateSegments, contextSegments);
  const ancestor = candidateDirectory.startsWith(`${contextDirectory}/`)
    || contextDirectory.startsWith(`${candidateDirectory}/`);
  return prefix * 40 + suffix * 80 + (ancestor ? 160 : 0);
}

interface AttachmentConcernCandidate {
  concern: NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];
  assessment: AssessedConcern;
  tokens: Set<string>;
  scopeTokens: Set<string>;
  excludedTokens: Set<string>;
  exclusionPaths: string[];
}

function selectUniqueConcern(input: {
  paths: readonly string[];
  label: string;
  candidates: readonly AttachmentConcernCandidate[];
  mode: "cluster" | "high-signal";
}): AttachmentConcernCandidate | null {
  const candidateTokens = pathSemanticTokens(input.paths, input.label);
  const localityTokens = pathLocalityTokens(input.paths);
  const localityDepth = pathLocalityDepth(input.paths);
  const ranked = input.candidates.map((candidate) => {
    const pathScore = Math.max(
      ...input.paths.flatMap((repositoryPath) =>
        candidate.assessment.contextPaths.map((contextPath) => directoryAffinity(repositoryPath, contextPath))
      ),
      0,
    );
    const semanticMatches = matchingTokenCount(candidateTokens, candidate.tokens);
    const distinctiveSemanticMatches = [...candidateTokens].filter((token) =>
      !WEAK_ATTACHMENT_TOKENS.has(token) && candidate.tokens.has(token)
    ).length;
    const localityMatches = matchingTokenCount(localityTokens, candidate.scopeTokens);
    return {
      candidate,
      pathScore,
      semanticMatches,
      distinctiveSemanticMatches,
      localityMatches,
      score: pathScore
        + Math.min(semanticMatches, 4) * 160
        + Math.min(distinctiveSemanticMatches, 2) * 240
        + Math.min(localityMatches, 3) * 200,
    };
  }).filter((entry) => !attachmentConflictsWithExclusions(
    entry.candidate,
    input.paths,
    input.label,
    true,
  ) && (
    input.mode === "cluster"
      ? (localityDepth >= 2 && entry.pathScore >= 850 && entry.localityMatches >= 2)
        || (localityDepth >= 2
          && entry.pathScore >= 40
          && entry.semanticMatches > 0
          && entry.localityMatches > 0)
        || (entry.pathScore >= 40 && entry.distinctiveSemanticMatches > 0)
        || (entry.pathScore >= 40 && entry.semanticMatches >= 2)
      : entry.pathScore >= 850
  )).sort((left, right) => right.score - left.score
    || left.candidate.concern.concern.localeCompare(right.candidate.concern.concern));
  const best = ranked[0];
  if (best === undefined) return null;
  const second = ranked[1];
  if (second !== undefined && best.score - second.score < 80) return null;
  return best.candidate;
}

function repositoryBlobsAtHead(
  cwd: string,
  repositoryPaths: readonly string[],
): Map<string, string> {
  const paths = [...new Set(repositoryPaths)]
    .filter((repositoryPath) => MODULE_SOURCE_EXTENSION.test(repositoryPath) && !/[\r\n]/.test(repositoryPath))
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || paths.length > MODULE_EDGE_MAX_FILES) return new Map();
  const result = spawnSync(
    "git",
    ["-C", cwd, "cat-file", "--batch"],
    {
      input: `${paths.map((repositoryPath) => `HEAD:${repositoryPath}`).join("\n")}\n`,
      maxBuffer: MODULE_EDGE_MAX_BUFFER,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return new Map();
  const blobs = new Map<string, string>();
  let offset = 0;
  for (const repositoryPath of paths) {
    const headerEnd = result.stdout.indexOf(0x0a, offset);
    if (headerEnd < 0) return new Map();
    const header = result.stdout.subarray(offset, headerEnd).toString("utf8");
    const size = /\sblob\s(\d+)$/.exec(header)?.[1];
    if (size === undefined) return new Map();
    const length = Number.parseInt(size, 10);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + length;
    if (!Number.isSafeInteger(length) || contentEnd >= result.stdout.length) return new Map();
    blobs.set(repositoryPath, result.stdout.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }
  return blobs;
}

function resolveRelativeModule(
  importer: string,
  specifier: string,
  trackedFiles: ReadonlySet<string>,
): string | null {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) return null;
  const extension = path.posix.extname(resolved);
  const base = MODULE_SOURCE_EXTENSION.test(resolved) ? resolved.slice(0, -extension.length) : resolved;
  const candidates = [
    resolved,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
      .flatMap((suffix) => [`${base}${suffix}`, `${base}/index${suffix}`]),
  ];
  return candidates.find((candidate) => trackedFiles.has(candidate)) ?? null;
}

function skipModuleTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1;
    } else if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return source.length;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return source.length;
      index = end + 2;
    } else {
      break;
    }
  }
  return index;
}

function readModuleString(
  source: string,
  start: number,
): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index += 1;
      if (index >= source.length) return null;
      value += source[index]!;
    } else if (character === quote) {
      return { value, end: index + 1 };
    } else {
      value += character;
    }
  }
  return null;
}

function callModuleSpecifier(source: string, start: number): string | null {
  let index = skipModuleTrivia(source, start);
  if (source[index] !== "(") return null;
  index = skipModuleTrivia(source, index + 1);
  return readModuleString(source, index)?.value ?? null;
}

function staticModuleSpecifier(source: string, start: number, sideEffect: boolean): string | null {
  let index = skipModuleTrivia(source, start);
  if (sideEffect) {
    const direct = readModuleString(source, index);
    if (direct !== null) return direct.value;
  }
  const limit = Math.min(source.length, start + 4_096);
  while (index < limit && source[index] !== ";") {
    if (source.startsWith("//", index) || source.startsWith("/*", index) || /\s/.test(source[index]!)) {
      index = skipModuleTrivia(source, index);
      continue;
    }
    const quoted = readModuleString(source, index);
    if (quoted !== null) {
      index = quoted.end;
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))?.[0];
    if (identifier === "from") {
      return readModuleString(source, skipModuleTrivia(source, index + identifier.length))?.value ?? null;
    }
    index += identifier?.length ?? 1;
  }
  return null;
}

function relativeModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let index = 0;
  while (index < source.length) {
    const next = skipModuleTrivia(source, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const quoted = readModuleString(source, index);
    if (quoted !== null) {
      index = quoted.end;
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))?.[0];
    if (identifier === undefined) {
      index += 1;
      continue;
    }
    const after = index + identifier.length;
    const specifier = identifier === "require"
      ? callModuleSpecifier(source, after)
      : identifier === "import"
        ? callModuleSpecifier(source, after) ?? staticModuleSpecifier(source, after, true)
        : identifier === "export"
          ? staticModuleSpecifier(source, after, false)
          : null;
    if (specifier?.startsWith("./") || specifier?.startsWith("../")) specifiers.push(specifier);
    index = after;
  }
  return specifiers;
}

function isPureRelativeReexport(source: string): boolean {
  let index = skipModuleTrivia(source, 0);
  let exports = 0;
  while (index < source.length) {
    const statement = /^export\s+(?:type\s+)?(?:\{[^{};]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?)\s+from\s*/.exec(source.slice(index));
    if (statement === null) return false;
    const specifier = readModuleString(source, index + statement[0].length);
    if (specifier === null || !/^\.\.?\//.test(specifier.value)) return false;
    exports += 1;
    index = skipModuleTrivia(source, specifier.end);
    if (source[index] === ";") index = skipModuleTrivia(source, index + 1);
  }
  return exports > 0;
}

function directModuleEdges(input: {
  cwd: string;
  trackedFiles: ReadonlySet<string>;
  paths: readonly string[];
}): { edges: Map<string, Set<string>>; facades: Set<string> } {
  const blobs = repositoryBlobsAtHead(input.cwd, input.paths);
  const edges = new Map<string, Set<string>>();
  const facades = new Set<string>();
  for (const [importer, source] of blobs) {
    if (isPureRelativeReexport(source)) facades.add(importer);
    for (const specifier of relativeModuleSpecifiers(source)) {
      const imported = resolveRelativeModule(importer, specifier, input.trackedFiles);
      if (imported === null) {
        facades.delete(importer);
        continue;
      }
      const imports = edges.get(importer) ?? new Set<string>();
      imports.add(imported);
      edges.set(importer, imports);
    }
  }
  return { edges, facades };
}

function prioritizeRepositoryClusters(input: {
  clusters: readonly RepositoryBehaviorCluster[];
  cwd: string | undefined;
  trackedFiles: ReadonlySet<string> | undefined;
}): RepositoryBehaviorCluster[] {
  if (input.cwd === undefined || input.trackedFiles === undefined) return [...input.clusters];
  const { edges } = directModuleEdges({
    cwd: input.cwd,
    trackedFiles: input.trackedFiles,
    paths: [...input.trackedFiles],
  });
  const neighbors = new Map<string, Set<string>>();
  for (const [from, targets] of edges) {
    for (const to of targets) {
      const fromNeighbors = neighbors.get(from) ?? new Set<string>();
      const toNeighbors = neighbors.get(to) ?? new Set<string>();
      fromNeighbors.add(to);
      toNeighbors.add(from);
      neighbors.set(from, fromNeighbors);
      neighbors.set(to, toNeighbors);
    }
  }
  const degree = (cluster: RepositoryBehaviorCluster): number => new Set(
    cluster.implementation_paths.flatMap((repositoryPath) => [...(neighbors.get(repositoryPath) ?? [])]),
  ).size;
  return [...input.clusters].sort((left, right) => degree(right) - degree(left)
    || left.cluster_key.localeCompare(right.cluster_key));
}

function selectUniqueDirectDependencyConcern(input: {
  implementationPaths: readonly string[];
  candidates: readonly AttachmentConcernCandidate[];
  edges: ReadonlyMap<string, ReadonlySet<string>>;
  facades: ReadonlySet<string>;
  label: string;
}): AttachmentConcernCandidate | "unresolved" | null {
  const linked = input.candidates.filter((candidate) =>
    input.implementationPaths.some((implementationPath) =>
      candidate.assessment.corePaths.some((corePath) =>
        input.edges.get(corePath)?.has(implementationPath)
      ) || (
        input.facades.has(implementationPath)
        && (input.edges.get(implementationPath)?.size ?? 0) > 0
        && [...input.edges.get(implementationPath)!].every((target) =>
          candidate.assessment.corePaths.includes(target)
        )
      )
    )
  );
  if (linked.length === 0) return null;
  const eligible = linked.filter((candidate) => !attachmentConflictsWithExclusions(
    candidate,
    input.implementationPaths,
    input.label,
    true,
  ));
  return eligible.length === 1 ? eligible[0]! : "unresolved";
}

function inferRepositoryConcernAttachments(input: {
  map: CodebaseMap;
  accepted: readonly AssessedConcern[];
  clusters: readonly RepositoryBehaviorCluster[];
  structuralHighSignal: readonly string[];
  cwd: string;
  trackedFiles: ReadonlySet<string>;
}): RepositoryConcernAttachment[] {
  const concerns = input.map.concern_evidence?.concerns ?? [];
  const candidates: AttachmentConcernCandidate[] = input.accepted.flatMap((assessment) => {
    const concern = concerns.find((candidate) => candidate.concern === assessment.concern);
    return concern === undefined ? [] : [{
      concern,
      assessment,
      tokens: concernSemanticTokens(concern),
      scopeTokens: semanticTokens(`${concern.concern} ${concern.one_line} ${concern.covers}`),
      excludedTokens: semanticTokens(concern.excludes),
      exclusionPaths: concernExclusionPaths(concern, input.trackedFiles),
    }];
  });
  const acceptedConcernRecords = candidates.map((candidate) => candidate.concern);
  const { edges: moduleEdges, facades } = directModuleEdges({
    cwd: input.cwd,
    trackedFiles: input.trackedFiles,
    paths: [
      ...input.clusters.flatMap((cluster) => cluster.implementation_paths),
      ...candidates.flatMap((candidate) => candidate.assessment.contextPaths),
    ],
  });
  const attachmentPaths = new Map<string, Set<string>>();
  const reasons = new Map<string, Set<string>>();
  const add = (concern: string, paths: readonly string[], reason: string): void => {
    const pathSet = attachmentPaths.get(concern) ?? new Set<string>();
    const reasonSet = reasons.get(concern) ?? new Set<string>();
    for (const repositoryPath of paths) pathSet.add(repositoryPath);
    reasonSet.add(reason);
    attachmentPaths.set(concern, pathSet);
    reasons.set(concern, reasonSet);
  };
  const rejected = (repositoryPath: string): boolean =>
    (input.map.concern_evidence?.not_concerns ?? [])
      .some((entry) =>
        rejectionHasGroundedDisposition(entry, acceptedConcernRecords)
        && rejectionCoversPath(entry, repositoryPath)
      );

  for (const cluster of input.clusters) {
    const clusterPaths = [...cluster.implementation_paths, ...cluster.test_paths]
      .filter((repositoryPath) => !rejected(repositoryPath));
    const direct = candidates.filter((candidate) => {
      const explicitImplementation = cluster.implementation_paths.some((repositoryPath) =>
        candidate.assessment.contextPaths.includes(repositoryPath)
      );
      const conflicts = explicitImplementation
        ? attachmentHasPathExclusion(candidate, cluster.implementation_paths)
        : attachmentConflictsWithExclusions(
          candidate,
          cluster.implementation_paths,
          cluster.cluster_key,
        );
      return !conflicts && clusterPaths.some((repositoryPath) =>
        candidate.assessment.contextPaths.includes(repositoryPath)
      );
    });
    if (direct.length > 0) {
      for (const candidate of direct) {
        add(candidate.concern.concern, clusterPaths, "tracked path-local implementation/test mirror");
      }
      continue;
    }
    const dependencyOwner = selectUniqueDirectDependencyConcern({
      implementationPaths: cluster.implementation_paths,
      candidates,
      edges: moduleEdges,
      facades,
      label: cluster.cluster_key,
    });
    if (dependencyOwner === "unresolved") continue;
    if (dependencyOwner !== null) {
      add(
        dependencyOwner.concern.concern,
        clusterPaths,
        "direct relative module dependency to accepted concern evidence",
      );
      continue;
    }
    const selected = selectUniqueConcern({
      paths: cluster.implementation_paths,
      label: cluster.cluster_key,
      candidates,
      mode: "cluster",
    });
    if (selected !== null) {
      add(
        selected.concern.concern,
        clusterPaths,
        "unique path-local and semantic match to accepted concern evidence",
      );
    }
  }

  const alreadyCovered = new Set([
    ...input.accepted.flatMap((assessment) => assessment.contextPaths),
    ...[...attachmentPaths.values()].flatMap((paths) => [...paths]),
  ]);
  for (const repositoryPath of input.structuralHighSignal) {
    if (alreadyCovered.has(repositoryPath) || rejected(repositoryPath) || isGenericPlumbing(repositoryPath)) continue;
    const selected = selectUniqueConcern({
      paths: [repositoryPath],
      label: filenameStem(repositoryPath),
      candidates,
      mode: "high-signal",
    });
    if (selected === null) continue;
    add(
      selected.concern.concern,
      [repositoryPath],
      "unique same-directory dependency of accepted concern evidence",
    );
    alreadyCovered.add(repositoryPath);
  }

  return [...attachmentPaths.entries()].map(([concern, paths]) => ({
    concern,
    paths: [...paths].sort((left, right) => left.localeCompare(right)),
    reason: [...(reasons.get(concern) ?? [])].sort().join("; "),
  })).sort((left, right) => left.concern.localeCompare(right.concern));
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
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactPathMention = new RegExp(`(^|[^A-Za-z0-9._/-])${escaped}(?=$|[^A-Za-z0-9._/-])`);
  return exactPathMention.test(rejection.candidate);
}

function concreteTouchpointSymbols(value: string | null): Set<string> {
  if (value === null) return new Set();
  return new Set(value.split(/[,/|]/).map((candidate) =>
    candidate.trim().replace(/\(\)$/, "")
  ).filter((candidate) =>
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|[.#])[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(candidate)
  ));
}

function pathsMentionedByRejections(
  map: CodebaseMap,
  candidates: readonly string[],
  acceptedConcerns: readonly ConcernRecord[],
): string[] {
  const mentioned = new Set<string>();
  const rejections = (map.concern_evidence?.not_concerns ?? [])
    .filter((entry) =>
      isSubstantiveConcernRejection(entry.why_rejected)
      && rejectionHasGroundedDisposition(entry, acceptedConcerns)
    );
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
      auxiliary_duplicate_concerns: [],
      repository_clusters: [],
      uncovered_clusters: [],
      attachments: [],
      core_ownership_resolutions: [],
    };
  }

  const reasons: string[] = [];
  const repository = createRepositoryEvidenceContext(map, options?.cwd);
  const resolvePath = repository.resolvePath;
  const repositoryClusters = discoverRepositoryBehaviorClusters(
    repository.trackedFiles,
    options?.cwd,
  );
  const clusterPaths = repositoryClusters.flatMap((cluster) => [
    ...cluster.implementation_paths,
    ...cluster.test_paths,
  ]);
  const clusterObligationPaths = new Set(clusterPaths);
  const structuralHighSignal = collectHighSignalPaths(map, resolvePath);
  const highSignal = [...new Set([
    ...structuralHighSignal,
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
  const concernsByName = new Map(
    map.concern_evidence.concerns.map((concern) => [concern.concern, concern]),
  );
  const acceptedConcernRecords = accepted.flatMap((assessment) => {
    const concern = concernsByName.get(assessment.concern);
    return concern === undefined ? [] : [concern];
  });
  const portfolioTokens = new Map(accepted.flatMap((assessment) => {
    const concern = concernsByName.get(assessment.concern);
    return concern === undefined ? [] : [[
      assessment.concern,
      semanticTokens(`${concern.concern} ${concern.one_line} ${concern.covers}`),
    ] as const];
  }));
  const auxiliaryDuplicateConcerns: AuxiliaryDuplicateConcern[] = [];
  for (const assessment of accepted) {
    if (
      assessment.corePaths.length === 0
      || !assessment.corePaths.every(auxiliaryRepositoryPath)
    ) {
      continue;
    }
    const tokens = portfolioTokens.get(assessment.concern);
    if (tokens === undefined) continue;
    const overlapping = accepted.filter((candidate) => {
      if (
        candidate.concern === assessment.concern
        || !candidate.corePaths.some(independentCoreImplementationPath)
      ) {
        return false;
      }
      const other = portfolioTokens.get(candidate.concern);
      if (other === undefined) return false;
      const thirdPartyTokens = accepted
        .filter((entry) =>
          entry.concern !== assessment.concern && entry.concern !== candidate.concern
        )
        .flatMap((entry) => [...(portfolioTokens.get(entry.concern) ?? [])]);
      return [...tokens].filter((token) =>
        [...other].some((otherToken) => tokensRelated(token, otherToken))
        && !thirdPartyTokens.some((otherToken) => tokensRelated(token, otherToken))
      ).length >= 2;
    });
    if (overlapping.length > 0) {
      auxiliaryDuplicateConcerns.push({
        concern: assessment.concern,
        paths: [...assessment.contextPaths],
        overlapping_concerns: overlapping.map((candidate) => candidate.concern),
      });
      reasons.push(
        `auxiliary-only accepted concern "${assessment.concern}" overlaps implementation-owned concern(s) ${overlapping.map((candidate) => `"${candidate.concern}"`).join(", ")}; attach the auxiliary evidence to the implementing behavior or reject the narrower candidate substantively`,
      );
    }
  }
  // Inferred attachments depend on an exact tracked repository tree. Without
  // one (for example schema-only callers and degraded non-Git fixtures), only
  // explicit concern evidence may satisfy semantic closure. This prevents
  // filename or directory heuristics from silently absorbing distinct public
  // surfaces such as help rendering or type declarations.
  const attachments = repository.trackedFiles === undefined || repository.cwd === undefined
    ? []
    : inferRepositoryConcernAttachments({
      map,
      accepted,
      clusters: repositoryClusters,
      structuralHighSignal,
      cwd: repository.cwd,
      trackedFiles: repository.trackedFiles,
    });
  const contextualPaths = new Set([
    ...accepted.flatMap((assessment) => assessment.contextPaths),
    ...attachments.flatMap((attachment) => attachment.paths),
  ]);
  const coreOwnedPaths = new Set(
    accepted.flatMap((assessment) => assessment.corePaths),
  );
  const coreOwnersByPath = new Map<string, string[]>();
  for (const assessment of accepted) {
    for (const repositoryPath of assessment.corePaths) {
      const owners = coreOwnersByPath.get(repositoryPath) ?? [];
      owners.push(assessment.concern);
      coreOwnersByPath.set(repositoryPath, owners);
    }
  }
  const coreOwnershipResolutions: RepositoryCoreOwnershipResolution[] = [];
  const ownershipResolutionByPath = new Map<string, RepositoryCoreOwnershipResolution>();
  const addOwnershipResolution = (resolution: RepositoryCoreOwnershipResolution): void => {
    if (ownershipResolutionByPath.has(resolution.path)) return;
    ownershipResolutionByPath.set(resolution.path, resolution);
    coreOwnershipResolutions.push(resolution);
  };
  const retainsUnsharedCoreImplementation = (
    concernName: string,
    sharedPath: string,
  ): boolean => accepted.find((assessment) => assessment.concern === concernName)
    ?.corePaths.some((candidate) =>
      candidate !== sharedPath
      && independentCoreImplementationPath(candidate)
      && (coreOwnersByPath.get(candidate)?.length ?? 0) === 1
    ) === true;
  for (const [repositoryPath, owners] of coreOwnersByPath) {
    if (owners.length <= 1) continue;
    const symbolClaims = owners.map((owner) => {
      const concern = concernsByName.get(owner);
      const symbols = new Set((concern?.touchpoints ?? []).flatMap((touchpoint) => {
        if (
          touchpoint.centrality !== "core"
          || resolvePath(touchpoint.path) !== repositoryPath
        ) return [];
        return [...concreteTouchpointSymbols(touchpoint.symbol)];
      }));
      return { owner, symbols };
    });
    const dominant = symbolClaims.filter((claimant) =>
      claimant.symbols.size > 0
      && symbolClaims.every((other) =>
        other.owner === claimant.owner
        || (
          other.symbols.size > 0
          && claimant.symbols.size > other.symbols.size
          && [...other.symbols].every((symbol) => claimant.symbols.has(symbol))
        )
      )
    );
    if (dominant.length === 1) {
      addOwnershipResolution({
        concern: dominant[0]!.owner,
        path: repositoryPath,
        reason:
          "the selected concern cites a strict superset of every competing concrete symbol claim in this shared file",
      });
      continue;
    }
    const soleDependentOwners = accepted.filter((assessment) =>
      owners.includes(assessment.concern)
      && assessment.corePaths.length === 1
      && assessment.corePaths[0] === repositoryPath
    );
    if (
      eligibleImplementationPath(repositoryPath)
      && soleDependentOwners.length === 1
      && owners
        .filter((owner) => owner !== soleDependentOwners[0]!.concern)
        .every((owner) => retainsUnsharedCoreImplementation(owner, repositoryPath))
    ) {
      addOwnershipResolution({
        concern: soleDependentOwners[0]!.concern,
        path: repositoryPath,
        reason:
          "the selected concern has no other core implementation path while every adjacent concern retains independent core ownership",
      });
      continue;
    }
    const dependentSupportingClaimants = accepted.filter((assessment) =>
      !owners.includes(assessment.concern)
      && assessment.contextPaths.includes(repositoryPath)
      && !assessment.corePaths.some(independentCoreImplementationPath)
    );
    const everyCurrentOwnerRetainsImplementation = owners.every((owner) =>
      retainsUnsharedCoreImplementation(owner, repositoryPath)
    );
    if (
      eligibleImplementationPath(repositoryPath)
      && dependentSupportingClaimants.length === 1
      && everyCurrentOwnerRetainsImplementation
    ) {
      addOwnershipResolution({
        concern: dependentSupportingClaimants[0]!.concern,
        path: repositoryPath,
        reason:
          "the selected concern is the sole supporting claimant without another core implementation while every current core owner retains independent implementation ownership",
      });
    }
  }
  const concernByName = concernsByName;
  const explicitTouchpointsByConcern = new Map(accepted.map((assessment) => {
    const concern = concernByName.get(assessment.concern);
    const paths = new Set((concern?.touchpoints ?? []).flatMap((touchpoint) => {
      const repositoryPath = resolvePath(touchpoint.path);
      return repositoryPath === null ? [] : [repositoryPath];
    }));
    return [assessment.concern, paths] as const;
  }));
  for (const cluster of repositoryClusters) {
    const clusterPaths = [...cluster.implementation_paths, ...cluster.test_paths];
    if (clusterPaths.length < 2) continue;
    const completeClaimants = accepted.filter((assessment) => {
      const explicitPaths = explicitTouchpointsByConcern.get(assessment.concern);
      const concern = concernByName.get(assessment.concern);
      return explicitPaths !== undefined
        && concern !== undefined
        && clusterPaths.every((repositoryPath) => explicitPaths.has(repositoryPath))
        && matchingTokenCount(
          pathSemanticTokens(cluster.implementation_paths, cluster.cluster_key),
          semanticTokens(concern.excludes),
        ) === 0;
    });
    if (completeClaimants.length !== 1) continue;
    const claimant = completeClaimants[0]!;
    const hasConflictingCoreOwner = clusterPaths.some((repositoryPath) =>
      (coreOwnersByPath.get(repositoryPath) ?? [])
        .some((owner) => owner !== claimant.concern)
      && ownershipResolutionByPath.get(repositoryPath)?.concern !== claimant.concern
    );
    if (hasConflictingCoreOwner) continue;
    for (const repositoryPath of clusterPaths) {
      addOwnershipResolution({
        concern: claimant.concern,
        path: repositoryPath,
        reason:
          `the selected concern is the only accepted concern that explicitly cites every tracked path in mirrored cluster ${cluster.cluster_key}`,
      });
    }
  }
  for (const assessment of accepted) {
    if (assessment.corePaths.length === 0 || !assessment.corePaths.every(isTestRepositoryPath)) continue;
    const uniqueImplementationPaths = assessment.contextPaths.filter((repositoryPath) =>
      !isTestRepositoryPath(repositoryPath)
      && eligibleImplementationPath(repositoryPath)
      && accepted.filter((candidate) => candidate.contextPaths.includes(repositoryPath)).length === 1
      && (coreOwnersByPath.get(repositoryPath) ?? []).every((owner) => owner === assessment.concern)
    );
    if (uniqueImplementationPaths.length !== 1) continue;
    addOwnershipResolution({
      concern: assessment.concern,
      path: uniqueImplementationPaths[0]!,
      reason:
        "the selected concern is the only accepted concern that cites this tracked implementation while its prior core evidence is test-only",
    });
  }
  const typeTrace = map.type_contract_surface.one_type_trace;
  const typeTracePaths = typeTrace === null ? [] : [...new Set([
    ...(map.type_contract_surface.type_definitions ?? []),
    ...map.type_contract_surface.typescript_interfaces,
    ...map.type_contract_surface.pydantic_models,
    ...map.type_contract_surface.db_models,
  ].filter((entry) => entry.name === typeTrace.name)
    .flatMap((entry) => {
      const repositoryPath = resolvePath(entry.path);
      return repositoryPath === null ? [] : [repositoryPath];
    }))];
  const typeTracePath = typeTracePaths.length === 1 ? typeTracePaths[0]! : null;
  if (typeTrace !== null && typeTracePath !== null) {
    const runtimeOwners = new Set(typeTrace.flow.flatMap((step) => {
      const cited = resolvePath(step.match(/^([^:]+?)(?::(?:\s|$)|$)/)?.[1]);
      if (cited === null || cited === typeTracePath) return [];
      const normalizedOwner = ownershipResolutionByPath.get(cited)?.concern;
      if (normalizedOwner !== undefined) return [normalizedOwner];
      const owners = coreOwnersByPath.get(cited) ?? [];
      return owners.length === 1 ? owners : [];
    }));
    if (runtimeOwners.size === 1) {
      const concern = [...runtimeOwners][0]!;
      addOwnershipResolution({
        concern,
        path: typeTracePath,
        reason:
          "the observed public type trace reaches runtime files with one unambiguous normalized core owner",
      });
      const attachment = attachments.find((entry) => entry.concern === concern);
      if (attachment === undefined) {
        attachments.push({
          concern,
          paths: [typeTracePath],
          reason: "observed public type trace to one runtime core owner",
        });
      } else if (!attachment.paths.includes(typeTracePath)) {
        attachment.paths.push(typeTracePath);
        attachment.paths.sort((left, right) => left.localeCompare(right));
      }
      contextualPaths.add(typeTracePath);
    }
  }
  for (const [repositoryPath, owners] of coreOwnersByPath) {
    if (owners.length <= 1 || ownershipResolutionByPath.has(repositoryPath)) continue;
    reasons.push(
      `tracked file ${repositoryPath} has multiple core owners: ${owners.sort((left, right) => left.localeCompare(right)).join(", ")}; retain exactly one defensible core owner and mark adjacent touchpoints supporting`,
    );
  }
  for (const resolution of coreOwnershipResolutions) coreOwnedPaths.add(resolution.path);
  for (const assessment of accepted) {
    const implementationContext = assessment.contextPaths.filter((repositoryPath) =>
      !isTestRepositoryPath(repositoryPath) && eligibleImplementationPath(repositoryPath)
    );
    const hasResolvedImplementationOwner = implementationContext.some((repositoryPath) =>
      ownershipResolutionByPath.get(repositoryPath)?.concern === assessment.concern
    );
    if (
      assessment.corePaths.length > 0
      && assessment.corePaths.every(isTestRepositoryPath)
      && implementationContext.length > 0
      && !hasResolvedImplementationOwner
    ) {
      reasons.push(
        `accepted concern "${assessment.concern}" has test-only core ownership despite tracked implementation context: ${implementationContext.join(", ")}; assign core ownership to the implementing behavior, merge the duplicate concern, or reject it substantively`,
      );
    }
  }
  const explicitOwnersByPath = new Map<string, Set<string>>();
  for (const assessment of accepted) {
    const concern = concernsByName.get(assessment.concern);
    const candidate = concern === undefined ? undefined : {
      concern,
      assessment,
      tokens: concernSemanticTokens(concern),
      scopeTokens: semanticTokens(`${concern.concern} ${concern.one_line} ${concern.covers}`),
      excludedTokens: semanticTokens(concern.excludes),
      exclusionPaths: concernExclusionPaths(concern, repository.trackedFiles),
    };
    for (const repositoryPath of assessment.contextPaths) {
      const touchpoint = concern?.touchpoints.find((entry) =>
        resolvePath(entry.path) === repositoryPath
      );
      if (
        candidate !== undefined
        && touchpoint?.centrality === "supporting"
        && attachmentHasPathExclusion(candidate, [repositoryPath])
      ) continue;
      const owners = explicitOwnersByPath.get(repositoryPath) ?? new Set<string>();
      owners.add(assessment.concern);
      explicitOwnersByPath.set(repositoryPath, owners);
    }
  }

  const coveredSet = new Set<string>();
  for (const cluster of repositoryClusters) {
    const implementationsCovered = cluster.implementation_paths.every((repositoryPath) => {
      const explicitOwnerCount = explicitOwnersByPath.get(repositoryPath)?.size ?? 0;
      return explicitOwnerCount > 1
        ? coreOwnedPaths.has(repositoryPath)
        : contextualPaths.has(repositoryPath);
    });
    if (!implementationsCovered) continue;
    for (const repositoryPath of cluster.implementation_paths) coveredSet.add(repositoryPath);
    for (const repositoryPath of cluster.test_paths) {
      if (contextualPaths.has(repositoryPath)) coveredSet.add(repositoryPath);
    }
  }
  for (const repositoryPath of structuralHighSignal) {
    if (!isGenericPlumbing(repositoryPath) && contextualPaths.has(repositoryPath)) {
      coveredSet.add(repositoryPath);
    }
  }
  const covered = [...coveredSet].sort((left, right) => left.localeCompare(right));
  const exempted = pathsMentionedByRejections(map, highSignal, acceptedConcernRecords);
  const exemptedSet = new Set(exempted);
  const uncovered = highSignal.filter((candidate) =>
    !coveredSet.has(candidate)
    && !exemptedSet.has(candidate)
    && (!isGenericPlumbing(candidate) || clusterObligationPaths.has(candidate))
  );
  const uncoveredSet = new Set(uncovered);
  const uncoveredClusters = prioritizeRepositoryClusters({
    clusters: repositoryClusters.filter((cluster) =>
      [...cluster.implementation_paths, ...cluster.test_paths]
        .some((candidate) => uncoveredSet.has(candidate))
    ),
    cwd: repository.cwd,
    trackedFiles: repository.trackedFiles,
  });

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
  for (const rejection of map.concern_evidence.not_concerns) {
    if (!isSubstantiveConcernRejection(rejection.why_rejected)) {
      reasons.push(
        `not_concerns candidate "${rejection.candidate}" does not contain a substantive rejection`,
      );
    } else if (!rejectionHasGroundedDisposition(rejection, acceptedConcernRecords)) {
      reasons.push(
        `not_concerns candidate "${rejection.candidate}" delegates behavior to "${rejection.grouped_into ?? delegatedOwnerDescription(rejection.why_rejected)}", but no accepted concern semantically matches that disposition`,
      );
    }
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
    isSubstantiveConcernRejection(entry.why_rejected)
    && rejectionHasGroundedDisposition(entry, acceptedConcernRecords)
    && highSignal.some((candidate) => rejectionCoversPath(entry, candidate))
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
      `repository implementation/test clusters and public-surface clusters are neither covered by an accepted concern nor explicitly rejected: ${summary}${uncoveredClusters.length > 8 ? "; …" : ""}`,
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
    auxiliary_duplicate_concerns: auxiliaryDuplicateConcerns,
    repository_clusters: repositoryClusters,
    uncovered_clusters: uncoveredClusters,
    attachments,
    core_ownership_resolutions: coreOwnershipResolutions,
  };
}

export function reconcileExplicitlyRetainedCandidates(map: CodebaseMap): CodebaseMap {
  if (map.concern_evidence === undefined) return map;
  const concernTokens = map.concern_evidence.concerns.map((concern) =>
    semanticTokens(`${concern.concern} ${concern.one_line} ${concern.covers}`)
  );
  const notConcerns = map.concern_evidence.not_concerns.filter((entry) => {
    if (!explicitlyAcceptsConcern(entry.why_rejected)) return true;
    const candidateTokens = semanticTokens(entry.candidate);
    return !concernTokens.some((tokens) =>
      matchingTokenCount(candidateTokens, tokens) >= 2
    );
  });
  if (notConcerns.length === map.concern_evidence.not_concerns.length) return map;
  return {
    ...map,
    concern_evidence: {
      concerns: map.concern_evidence.concerns,
      not_concerns: notConcerns,
    },
  };
}

/**
 * Retire an accepted concern only after a grounded delegated rejection names
 * one retained owner that already preserves its core paths and verified flow
 * structure. This makes model-requested grouping a checked normalization, not
 * a deletion mechanism.
 */
export function reconcileSubsumedConcernEvidence(map: CodebaseMap): CodebaseMap {
  const evidence = map.concern_evidence;
  if (evidence === undefined) return map;
  const concerns = [...evidence.concerns];
  const retired = new Set<string>();
  const groupedOwners = new Set<string>();
  const appendUnique = <T>(left: readonly T[], right: readonly T[]): T[] => {
    const seen = new Set(left.map((entry) => JSON.stringify(entry)));
    return [...left, ...right.filter((entry) => {
      const identity = JSON.stringify(entry);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })];
  };
  for (const rejection of evidence.not_concerns) {
    if (
      !isSubstantiveConcernRejection(rejection.why_rejected)
      || rejection.grouped_into === undefined
    ) continue;
    const sourceIndex = concerns.findIndex((concern) =>
      concern.concern.trim().toLowerCase() === rejection.candidate.trim().toLowerCase()
    );
    const ownerIndex = concerns.findIndex((concern) =>
      concern.concern === rejection.grouped_into
    );
    if (sourceIndex < 0 || ownerIndex < 0 || sourceIndex === ownerIndex) continue;
    const source = concerns[sourceIndex]!;
    const owner = concerns[ownerIndex]!;
    const ownerCorePaths = new Set(owner.touchpoints.flatMap((touchpoint) => {
      const repositoryPath = normalizeRepositoryPathSyntax(touchpoint.path);
      return touchpoint.centrality === "core" && repositoryPath !== null ? [repositoryPath] : [];
    }));
    const sharesCore = source.touchpoints.some((touchpoint) => {
      const repositoryPath = normalizeRepositoryPathSyntax(touchpoint.path);
      return touchpoint.centrality === "core"
        && repositoryPath !== null
        && ownerCorePaths.has(repositoryPath);
    });
    if (!sharesCore) continue;
    const ownerFlows = new Map(owner.flows.map((flow) => [
      flow.name.trim().toLowerCase(),
      flow.steps.map((step) => step.path).join("\0"),
    ]));
    if (source.flows.some((flow) => {
      const existing = ownerFlows.get(flow.name.trim().toLowerCase());
      return existing !== undefined && existing !== flow.steps.map((step) => step.path).join("\0");
    })) continue;
    concerns[ownerIndex] = {
      ...owner,
      one_line: `${owner.one_line} ${source.one_line}`,
      covers: `${owner.covers} Also covers: ${source.covers}`,
      flows: appendUnique(owner.flows, source.flows),
      touchpoints: appendUnique(owner.touchpoints, source.touchpoints),
      invariants: appendUnique(owner.invariants, source.invariants),
      pitfalls: appendUnique(owner.pitfalls, source.pitfalls),
      entry_questions: appendUnique(owner.entry_questions, source.entry_questions),
      validation: appendUnique(owner.validation, source.validation),
      spans_subtrees: [...new Set([...owner.spans_subtrees, ...source.spans_subtrees])].sort(),
      last_updated: owner.last_updated > source.last_updated ? owner.last_updated : source.last_updated,
    };
    concerns.splice(sourceIndex, 1);
    retired.add(source.concern.trim().toLowerCase());
    groupedOwners.add(owner.concern.trim().toLowerCase());
  }
  if (retired.size === 0) return map;
  const remainingNames = concerns.map((concern) => concern.concern);
  const normalizedConcerns = concerns.map((concern) => groupedOwners.has(concern.concern.trim().toLowerCase())
    ? {
        ...concern,
        excludes: `Adjacent accepted concerns remain separate: ${remainingNames.filter((name) => name !== concern.concern).join(", ")}.`,
      }
    : concern);
  return {
    ...map,
    concern_evidence: {
      ...evidence,
      concerns: normalizedConcerns,
    },
  };
}

export function reconcileAuxiliaryDuplicateConcerns(
  map: CodebaseMap,
  assessment: SpecialistEvidenceAssessment,
): CodebaseMap {
  if (
    assessment.source !== "concern_evidence"
    || map.concern_evidence === undefined
    || assessment.auxiliary_duplicate_concerns.length === 0
  ) {
    return map;
  }
  const duplicateNames = new Set(
    assessment.auxiliary_duplicate_concerns.map((duplicate) => duplicate.concern),
  );
  const concerns = map.concern_evidence.concerns.filter((concern) =>
    !duplicateNames.has(concern.concern)
  );
  const notConcerns = [...map.concern_evidence.not_concerns];
  const existing = new Set(notConcerns.map((entry) => entry.candidate.trim().toLowerCase()));
  for (const duplicate of assessment.auxiliary_duplicate_concerns) {
    for (const candidate of [duplicate.concern, ...duplicate.paths]) {
      if (existing.has(candidate.trim().toLowerCase())) continue;
      existing.add(candidate.trim().toLowerCase());
      notConcerns.push({
        candidate,
        why_rejected:
          `Trusted normalization rejected this auxiliary-only candidate because its tracked evidence (${duplicate.paths.join(", ")}) overlaps implementation-owned concern(s) ${duplicate.overlapping_concerns.join(", ")}; examples and fixtures are supporting evidence, not independent specialist ownership.`,
      });
    }
  }
  return {
    ...map,
    concern_evidence: {
      concerns,
      not_concerns: notConcerns,
    },
  };
}

export function reconcileScoutConcernIdentities(map: CodebaseMap): CodebaseMap {
  const evidence = map.concern_evidence;
  const proposals = map.explorer_receipts?.receipts
    .filter((receipt) => receipt.mode === "concern_scout" && receipt.success)
    .flatMap((receipt) => receipt.proposed_concerns ?? []) ?? [];
  if (evidence === undefined || proposals.length === 0) return map;
  let changed = false;
  const occupied = new Set(evidence.concerns.map((concern) => concern.concern.trim().toLowerCase()));
  const concerns = evidence.concerns.map((concern) => {
    const current = concern.concern.trim();
    const matches = proposals.filter((proposal) => {
      const canonical = proposal.trim();
      return canonical.length > 0
        && current.toLowerCase().startsWith(`${canonical.toLowerCase()};`);
    });
    if (matches.length !== 1) return concern;
    const canonical = matches[0]!.trim();
    if (occupied.has(canonical.toLowerCase())) return concern;
    changed = true;
    return {
      ...concern,
      concern: canonical,
      touchpoints: concern.touchpoints.map((touchpoint) => (
        touchpoint.role.includes("Trusted ownership normalization")
          ? { ...touchpoint, role: touchpoint.role.replaceAll(current, canonical) }
          : touchpoint
      )),
    };
  });
  return changed ? { ...map, concern_evidence: { ...evidence, concerns } } : map;
}

export function removeTrustedInferredAttachments(map: CodebaseMap): CodebaseMap {
  const evidence = map.concern_evidence;
  if (evidence === undefined) return map;
  let changed = false;
  const concerns = evidence.concerns.map((concern) => {
    const touchpoints = concern.touchpoints.filter((touchpoint) => (
      !touchpoint.role.startsWith("Trusted semantic closure attached this tracked dependency:")
    ));
    if (touchpoints.length === concern.touchpoints.length) return concern;
    changed = true;
    return { ...concern, touchpoints };
  });
  return changed ? { ...map, concern_evidence: { ...evidence, concerns } } : map;
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
  const attachmentsByConcern = new Map(
    assessment.attachments.map((attachment) => [attachment.concern, attachment]),
  );
  const ownershipByPath = new Map(
    assessment.core_ownership_resolutions.map((resolution) => [resolution.path, resolution]),
  );
  let attachmentsChanged = false;
  let ownershipChanged = false;
  const concerns = map.concern_evidence.concerns
    .filter((concern) => accepted.has(concern.concern))
    .map((concern) => {
      const touchpoints = concern.touchpoints.map((touchpoint) => {
        const repositoryPath = normalizeRepositoryPathSyntax(touchpoint.path);
        const resolution = repositoryPath === null
          ? undefined
          : ownershipByPath.get(repositoryPath);
        if (resolution === undefined) return touchpoint;
        if (resolution.concern === concern.concern) {
          if (touchpoint.centrality === "core") return touchpoint;
          ownershipChanged = true;
          return {
            ...touchpoint,
            centrality: "core" as const,
            role: `${touchpoint.role} Trusted ownership normalization selects this concern as the sole core owner because ${resolution.reason}.`,
          };
        }
        if (touchpoint.centrality !== "core") return touchpoint;
        ownershipChanged = true;
        return {
          ...touchpoint,
          centrality: "supporting" as const,
          role: `${touchpoint.role} Trusted ownership normalization retains ${resolution.concern} as the sole core owner because ${resolution.reason}.`,
        };
      });
      const attachment = attachmentsByConcern.get(concern.concern);
      if (attachment === undefined) {
        return touchpoints === concern.touchpoints ? concern : { ...concern, touchpoints };
      }
      const existing = new Set(touchpoints.map((touchpoint) =>
        normalizeRepositoryPathSyntax(touchpoint.path) ?? touchpoint.path
      ));
      const additions = attachment.paths.filter((repositoryPath) => !existing.has(repositoryPath));
      if (additions.length === 0) {
        return touchpoints === concern.touchpoints ? concern : { ...concern, touchpoints };
      }
      attachmentsChanged = true;
      return {
        ...concern,
        touchpoints: [
          ...touchpoints,
          ...additions.map((repositoryPath) => ({
            path: repositoryPath,
            symbol: null,
            role: `Trusted semantic closure attached this tracked dependency: ${attachment.reason}.`,
            line_range: null,
            centrality: "supporting" as const,
          })),
        ],
      };
    });
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
  const concernsChanged = concerns.length !== map.concern_evidence.concerns.length
    || attachmentsChanged
    || ownershipChanged;
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
