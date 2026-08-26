from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f"missing start marker for {label}: {start}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise RuntimeError(f"missing end marker for {label}: {end}")
    return text[:start_index] + replacement + text[end_index:]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one {label} occurrence, found {count}")
    return text.replace(old, new, 1)


specialist_path = ROOT / "src/core/audit/specialist-completion.ts"
specialist = specialist_path.read_text()
specialist = replace_once(
    specialist,
    '  "setup",\n]);',
    '  "setup",\n  "type",\n  "types",\n]);',
    "ambiguous type cluster keys",
)
specialist = replace_once(
    specialist,
    '''export interface RepositoryBehaviorCluster {
  cluster_key: string;
  implementation_paths: string[];
  test_paths: string[];
}

export interface SpecialistEvidenceAssessment {''',
    '''export interface RepositoryBehaviorCluster {
  cluster_key: string;
  implementation_paths: string[];
  test_paths: string[];
}

export interface RepositoryConcernAttachment {
  concern: string;
  paths: string[];
  reason: string;
}

export interface SpecialistEvidenceAssessment {''',
    "attachment interface",
)
specialist = replace_once(
    specialist,
    '''  repository_clusters: RepositoryBehaviorCluster[];
  uncovered_clusters: RepositoryBehaviorCluster[];
}''',
    '''  repository_clusters: RepositoryBehaviorCluster[];
  uncovered_clusters: RepositoryBehaviorCluster[];
  attachments: RepositoryConcernAttachment[];
}''',
    "assessment attachments field",
)

cluster_code = r'''function clusterStem(repositoryPath: string): string | null {
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
  return clusters.sort((left, right) => left.cluster_key.localeCompare(right.cluster_key));
}

'''
specialist = replace_between(
    specialist,
    "function clusterKey(repositoryPath: string): string | null {",
    "function collectPathCandidates(map: CodebaseMap): unknown[] {",
    cluster_code,
    "locality-aware cluster discovery",
)

assessment_code = r'''interface AssessedConcern {
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
  };
}

const SEMANTIC_STOP_WORDS = new Set([
  "and", "behavior", "contract", "core", "end", "file", "implementation", "integration",
  "module", "repository", "runtime", "supporting", "test", "tests", "through", "with",
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
    concern.excludes,
    ...concern.entry_questions,
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
  return semanticTokens(`${label} ${paths.join(" ")}`);
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
}

function selectUniqueConcern(input: {
  paths: readonly string[];
  label: string;
  candidates: readonly AttachmentConcernCandidate[];
  mode: "cluster" | "high-signal";
}): AttachmentConcernCandidate | null {
  const candidateTokens = pathSemanticTokens(input.paths, input.label);
  const ranked = input.candidates.map((candidate) => {
    const pathScore = Math.max(
      ...input.paths.flatMap((repositoryPath) =>
        candidate.assessment.contextPaths.map((contextPath) => directoryAffinity(repositoryPath, contextPath))
      ),
      0,
    );
    let semanticMatches = 0;
    for (const token of candidateTokens) {
      if ([...candidate.tokens].some((other) => tokensRelated(token, other))) semanticMatches += 1;
    }
    return {
      candidate,
      pathScore,
      semanticMatches,
      score: pathScore + Math.min(semanticMatches, 4) * 160,
    };
  }).filter((entry) => input.mode === "cluster"
    ? entry.semanticMatches > 0 && (entry.pathScore >= 40 || entry.semanticMatches >= 2)
    : entry.pathScore >= 850
  ).sort((left, right) => right.score - left.score
    || left.candidate.concern.concern.localeCompare(right.candidate.concern.concern));
  const best = ranked[0];
  if (best === undefined) return null;
  const second = ranked[1];
  if (second !== undefined && best.score - second.score < 80) return null;
  return best.candidate;
}

function inferRepositoryConcernAttachments(input: {
  map: CodebaseMap;
  accepted: readonly AssessedConcern[];
  clusters: readonly RepositoryBehaviorCluster[];
  structuralHighSignal: readonly string[];
}): RepositoryConcernAttachment[] {
  const concerns = input.map.concern_evidence?.concerns ?? [];
  const candidates: AttachmentConcernCandidate[] = input.accepted.flatMap((assessment) => {
    const concern = concerns.find((candidate) => candidate.concern === assessment.concern);
    return concern === undefined ? [] : [{ concern, assessment, tokens: concernSemanticTokens(concern) }];
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
      .some((entry) => rejectionCoversPath(entry, repositoryPath));

  for (const cluster of input.clusters) {
    const clusterPaths = [...cluster.implementation_paths, ...cluster.test_paths]
      .filter((repositoryPath) => !rejected(repositoryPath));
    const direct = candidates.filter((candidate) => clusterPaths.some((repositoryPath) =>
      candidate.assessment.contextPaths.includes(repositoryPath)
    ));
    if (direct.length > 0) {
      for (const candidate of direct) {
        add(candidate.concern.concern, clusterPaths, "tracked path-local implementation/test mirror");
      }
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

'''
specialist = replace_between(
    specialist,
    "interface AssessedConcern {",
    "function rejectionScope(value: string): { base: string; subtree: boolean } | null {",
    assessment_code,
    "tracked flow and deterministic attachment assessment",
)

specialist = replace_once(
    specialist,
    '''      repository_clusters: [],
      uncovered_clusters: [],
    };''',
    '''      repository_clusters: [],
      uncovered_clusters: [],
      attachments: [],
    };''',
    "absent assessment attachments",
)

assessment_logic = r'''  const repositoryClusters = discoverRepositoryBehaviorClusters(repository.trackedFiles);
  const clusterPaths = repositoryClusters.flatMap((cluster) => [
    ...cluster.implementation_paths,
    ...cluster.test_paths,
  ]);
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
  const attachments = inferRepositoryConcernAttachments({
    map,
    accepted,
    clusters: repositoryClusters,
    structuralHighSignal,
  });
  const covered = [...new Set([
    ...accepted.flatMap((assessment) => assessment.contextPaths),
    ...attachments.flatMap((attachment) => attachment.paths),
  ])].sort((left, right) => left.localeCompare(right));
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

'''
specialist = replace_between(
    specialist,
    "  const repositoryClusters = discoverRepositoryBehaviorClusters(repository.trackedFiles);",
    "  if (\n    map.meta.project_type.trim().length === 0",
    assessment_logic,
    "assessment coverage and inferred attachments",
)
specialist = replace_once(
    specialist,
    '''    repository_clusters: repositoryClusters,
    uncovered_clusters: uncoveredClusters,
  };''',
    '''    repository_clusters: repositoryClusters,
    uncovered_clusters: uncoveredClusters,
    attachments,
  };''',
    "returned deterministic attachments",
)

old_reconcile = '''  const accepted = new Set(assessment.accepted_concerns);
  const concerns = map.concern_evidence.concerns.filter((concern) =>
    accepted.has(concern.concern)
  );
  const notConcerns = [...map.concern_evidence.not_concerns];'''
new_reconcile = '''  const accepted = new Set(assessment.accepted_concerns);
  const attachmentsByConcern = new Map(
    assessment.attachments.map((attachment) => [attachment.concern, attachment]),
  );
  let attachmentsChanged = false;
  const concerns = map.concern_evidence.concerns
    .filter((concern) => accepted.has(concern.concern))
    .map((concern) => {
      const attachment = attachmentsByConcern.get(concern.concern);
      if (attachment === undefined) return concern;
      const existing = new Set(concern.touchpoints.map((touchpoint) =>
        normalizeRepositoryPathSyntax(touchpoint.path) ?? touchpoint.path
      ));
      const additions = attachment.paths.filter((repositoryPath) => !existing.has(repositoryPath));
      if (additions.length === 0) return concern;
      attachmentsChanged = true;
      return {
        ...concern,
        touchpoints: [
          ...concern.touchpoints,
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
  const notConcerns = [...map.concern_evidence.not_concerns];'''
specialist = replace_once(specialist, old_reconcile, new_reconcile, "reconciled attachments")
specialist = replace_once(
    specialist,
    "  const concernsChanged = concerns.length !== map.concern_evidence.concerns.length;",
    "  const concernsChanged = concerns.length !== map.concern_evidence.concerns.length || attachmentsChanged;",
    "attachment change detection",
)
specialist_path.write_text(specialist)

run_context_path = ROOT / "src/core/runs/run-context.ts"
run_context = run_context_path.read_text()
run_context = replace_once(
    run_context,
    'import type {\n  AgentifyConfig,',
    'import type { AgentifyLog } from "../audit/log.ts";\nimport type {\n  AgentifyConfig,',
    "run context log import",
)
run_context = replace_once(
    run_context,
    '''  config: AgentifyConfig;
  signal?: AbortSignal;
}''',
    '''  config: AgentifyConfig;
  signal?: AbortSignal;
  /** Internal ownership handoff used to keep coverage and semantic repair in one log. */
  auditLog?: AgentifyLog;
  deferAuditLogCompletion?: boolean;
}''',
    "run context log fields",
)
run_context_path.write_text(run_context)

core_path = ROOT / "src/core/runs/repository-audit-run-core.ts"
core = core_path.read_text()
core = replace_once(
    core,
    '''  const log = new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const startedAt = Date.now();''',
    '''  const log = context.auditLog ?? new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const ownsLog = context.auditLog === undefined;
  const deferLogCompletion = context.deferAuditLogCompletion === true;
  if (deferLogCompletion && ownsLog) {
    throw new Error("deferred audit logging requires a caller-owned AgentifyLog");
  }
  const startedAt = Date.now();''',
    "caller-owned audit log",
)
old_terminal = '''    log.sessionEnd({
      duration_ms: Date.now() - startedAt,
      was_aborted: runtimeResult.aborted && !intentionallyStopped,
      status,
    });
    log.runEnd({
      exit_code: success ? 0 : -1,
      status,
      coverage: {
        covered: closure.closed.length,
        gap: closure.unresolved.length,
        total: COVERAGE_DIMENSIONS.length,
      },
      agents_md_path: null,
    });'''
new_terminal = '''    if (!deferLogCompletion) {
      log.sessionEnd({
        duration_ms: Date.now() - startedAt,
        was_aborted: runtimeResult.aborted && !intentionallyStopped,
        status,
      });
      log.runEnd({
        exit_code: success ? 0 : -1,
        status,
        coverage: {
          covered: closure.closed.length,
          gap: closure.unresolved.length,
          total: COVERAGE_DIMENSIONS.length,
        },
        agents_md_path: null,
      });
    }'''
core = replace_once(core, old_terminal, new_terminal, "deferred terminal logging")
core = replace_once(
    core,
    '    context.ui.info(`agentify: audit log written to ${log.logPath}`);',
    '    if (!deferLogCompletion) context.ui.info(`agentify: audit log written to ${log.logPath}`);',
    "deferred log path output",
)
core = replace_once(
    core,
    '''  } catch (error) {
    log.runEnd({
      exit_code: -1,
      status: "error",
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;''',
    '''  } catch (error) {
    if (!deferLogCompletion) {
      log.runEnd({
        exit_code: -1,
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;''',
    "deferred error logging",
)
core = replace_once(
    core,
    "    await log.close();",
    "    if (ownsLog) await log.close();",
    "caller-owned log close",
)
core_path.write_text(core)

run_path = ROOT / "src/core/runs/repository-audit-run.ts"
run = run_path.read_text()
run = replace_once(
    run,
    'import { defaultConfigDir } from "../agentify-config.ts";',
    'import { defaultConfigDir } from "../agentify-config.ts";\nimport { AgentifyLog } from "../audit/log.ts";',
    "semantic wrapper log import",
)
run = replace_once(
    run,
    '''  assessSpecialistEvidence,
  reconcileSpecialistEvidence,''',
    '''  assessCoverageClosure,
  assessSpecialistEvidence,
  reconcileSpecialistEvidence,''',
    "coverage assessment import",
)
run = replace_once(
    run,
    '''const MAX_REPAIR_PASSES = 2;
const REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const REPAIR_MAX_OUTPUT_TOKENS = 65_536;''',
    '''const MAX_REPAIR_PASSES = 6;
const MAX_STALLED_REPAIR_PASSES = 2;
const REPAIR_PATH_BATCH_SIZE = 48;
const REPAIR_CLUSTER_BATCH_SIZE = 24;
const REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const REPAIR_MAX_OUTPUT_TOKENS = 65_536;''',
    "progress repair constants",
)

repair_prompt_code = r'''function rotatingWindow<T>(values: readonly T[], limit: number, pass: number): T[] {
  if (values.length <= limit) return [...values];
  const offset = ((pass - 1) * limit) % values.length;
  const result: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(values[(offset + index) % values.length]!);
  }
  return result;
}

function repairPrompt(assessment: SpecialistEvidenceAssessment, pass: number): string {
  const needsBroadDiscovery = pass === 1 && (
    assessment.accepted_concerns.length === 0
    || assessment.reasons.some((reason) => /thin specialist portfolio/i.test(reason))
  );
  const uncoveredBatch = rotatingWindow(
    assessment.uncovered_paths,
    REPAIR_PATH_BATCH_SIZE,
    pass,
  );
  const clusterBatch = rotatingWindow(
    assessment.uncovered_clusters,
    REPAIR_CLUSTER_BATCH_SIZE,
    pass,
  );
  const uncovered = uncoveredBatch.length > 0 ? uncoveredBatch.join(", ") : "none";
  const rejected = assessment.rejected_concerns.length > 0
    ? assessment.rejected_concerns
      .slice(0, 12)
      .map((entry) => `${entry.concern} (${entry.reasons.join("; ")})`)
      .join(", ")
    : "none";
  const uncoveredClusters = clusterBatch.length > 0
    ? clusterBatch.map((cluster) =>
      `${cluster.cluster_key}: ${[...cluster.implementation_paths, ...cluster.test_paths].join(", ")}`
    ).join("; ")
    : "none";

  return [
    "The repository's coverage map is complete, but its specialist portfolio failed the trusted semantic-quality gate.",
    `Repair pass ${pass}/${MAX_REPAIR_PASSES}; ${assessment.uncovered_paths.length} tracked paths and ${assessment.uncovered_clusters.length} local implementation/test clusters remain in total.`,
    `Current failures: ${assessment.reasons.slice(0, 12).join("; ")}.`,
    `Accepted concerns to preserve: ${assessment.accepted_concerns.join(", ") || "none"}.`,
    `Current tracked-path batch: ${uncovered}.`,
    `Current local implementation/test-cluster batch: ${uncoveredClusters}.`,
    `Concern candidates rejected by trusted evidence binding: ${rejected}.`,
    needsBroadDiscovery
      ? "Run concern_scout against the repository root once, then one concern_tracer for each retained candidate."
      : "Do not rerun a broad concern scout. Repair only the named tracked gaps and rejected candidates, preserving accepted concerns.",
    "A repository path is evidence only when that exact path is a regular Git blob tracked at HEAD. Extensionless tracked files such as Jenkinsfiles are valid; fetched dependencies, ignored/generated outputs, symlinks, path templates, glob expressions, and process labels are not.",
    "Trace every retained concern through at least two ordered tracked operations and record at least one tracked core touchpoint. Distinct operations may occur in the same orchestration file; duplicated padding is not a trace.",
    "For each uncovered tracked path, add it to the appropriate concern as a real touchpoint/flow step, or put its exact path in not_concerns.candidate with a repository-specific reason.",
    "Implementation/test clusters are path-local. Trace both sides when they form a cohesive recurring contract; otherwise attach them to an existing concern or explicitly reject the exact paths.",
    "Shared files must appear under every concern they serve with the role they play in that concern; overlap is expected and must never cause merging.",
    "Do not include .agentify/** or .github/agentify/** as repository architecture, specialists, or application evidence.",
    "Replace concern_evidence atomically through write_map_delta, preserving accepted concerns and recording rejected candidates in not_concerns. Omit the dimension parameter because concern evidence closes no D1-D10 dimension.",
    "Do not modify application files, workflows, dependencies, prompts, or documentation. Do not return prose instead of the structured write_map_delta call.",
  ].join(" ");
}

function repairImproved(
  before: SpecialistEvidenceAssessment,
  after: SpecialistEvidenceAssessment,
): boolean {
  return after.complete
    || after.uncovered_paths.length < before.uncovered_paths.length
    || after.uncovered_clusters.length < before.uncovered_clusters.length
    || after.accepted_concerns.length > before.accepted_concerns.length
    || after.rejected_concerns.length < before.rejected_concerns.length;
}

type RepairWriteMapResult = {
  details?: {
    path?: string;
    size_bytes?: number;
    coverage_summary?: { covered?: string[]; gap?: string[]; total?: number };
    gap_warning?: string[] | null;
  };
  isError?: boolean;
};

function logRepairEvent(log: AgentifyLog, event: unknown): void {
  const value = event as {
    type?: string;
    message?: {
      role?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      };
    };
    toolName?: string;
    tool_name?: string;
    result?: RepairWriteMapResult;
  };
  const eventType = value.type ?? "unknown";
  log.sessionEvent({ pi_event_type: eventType, event });
  if (eventType === "message_start" && value.message?.role === "user") {
    log.recordTurnStart();
  } else if (eventType === "message_end") {
    log.incrementTurns();
    log.recordTurnEnd(value.message?.usage);
  } else if (
    eventType === "tool_execution_end"
    && (value.toolName === "write_map" || value.toolName === "write_map_delta")
    && value.result?.isError !== true
    && value.result?.details?.path
  ) {
    log.mapWritten({
      path: value.result.details.path,
      size_bytes: value.result.details.size_bytes ?? 0,
      coverage_summary: {
        covered: value.result.details.coverage_summary?.covered ?? [],
        gap: value.result.details.coverage_summary?.gap ?? [],
        total: value.result.details.coverage_summary?.total ?? 10,
      },
      gap_warning: value.result.details.gap_warning ?? null,
    });
  }
}

'''
run = replace_between(
    run,
    "function repairPrompt(assessment: SpecialistEvidenceAssessment): string {",
    "function addCost(left: number | null, right: number | null): number | null {",
    repair_prompt_code,
    "progress-aware repair prompt",
)

repair_function = r'''async function repairSpecialistPortfolio(
  context: RunContext,
  log: AgentifyLog,
): Promise<{ turns: number; cost_usd: number | null }> {
  const stateDir = AUDIT_STATE_RELATIVE_DIR;
  const mapTools = createWriteMapTools({ stateDir });
  const systemPrompt = loadBuilderPrompt(stateDir);
  let turns = 0;
  let costUsd: number | null = null;
  let stalledPasses = 0;

  for (let pass = 1; pass <= MAX_REPAIR_PASSES; pass += 1) {
    const map = loadCanonicalMapAt(context.cwd, stateDir);
    if (map === null) throw new Error("canonical codebase map disappeared before specialist repair");
    const assessment = assessSpecialistEvidence(map, { cwd: context.cwd });
    if (assessment.complete) {
      persistTrustedConcernProjection(context, map, assessment);
      return { turns, cost_usd: costUsd };
    }

    context.ui.status(
      `agentify: repairing incomplete specialist discovery (${pass}/${MAX_REPAIR_PASSES})`,
    );
    const result = await context.runtime.runSession({
      cwd: context.cwd,
      configDir: defaultConfigDir(),
      config: context.config,
      systemPrompt,
      userPrompt: repairPrompt(assessment, pass),
      tools: [...REPAIR_TOOL_ALLOWLIST],
      executionPolicy: createReadOnlyExecutionPolicy({
        cwd: context.cwd,
        mode: "audit-readonly",
        tools: ["read", "grep", "find", "ls"],
        protectedPaths: [path.resolve(context.cwd)],
      }),
      customTools: [mapTools.writeMapTool, mapTools.writeMapDeltaTool],
      spawnExplorerAgentDir: defaultConfigDir(),
      spawnExplorerStateDir: stateDir,
      signal: context.signal,
      inactivityTimeoutMs: 5 * 60 * 1000,
      timeoutMs: REPAIR_TIMEOUT_MS,
      maxOutputTokens: REPAIR_MAX_OUTPUT_TOKENS,
      recoveryPromptIfToolNotCalled: {
        requiredToolName: "write_map_delta",
        maxAttempts: 2,
        userPrompt:
          "Submit the repaired concern_evidence through write_map_delta now. Do not return prose.",
        shouldRecover: () => {
          const current = loadCanonicalMapAt(context.cwd, stateDir);
          return current !== null
            && !assessSpecialistEvidence(current, { cwd: context.cwd }).complete;
        },
      },
      onEvent: (event) => logRepairEvent(log, event),
    });
    turns += result.turns;
    costUsd = addCost(costUsd, result.costUsd);

    const updatedMap = loadCanonicalMapAt(context.cwd, stateDir);
    const updatedAssessment = updatedMap === null
      ? null
      : assessSpecialistEvidence(updatedMap, { cwd: context.cwd });
    if (updatedAssessment?.complete) {
      persistTrustedConcernProjection(context, updatedMap!, updatedAssessment);
      return { turns, cost_usd: costUsd };
    }
    if (updatedAssessment !== null && repairImproved(assessment, updatedAssessment)) {
      stalledPasses = 0;
    } else {
      stalledPasses += 1;
      if (stalledPasses >= MAX_STALLED_REPAIR_PASSES) break;
    }
  }

  const finalMap = loadCanonicalMapAt(context.cwd, stateDir);
  const finalAssessment = finalMap === null
    ? null
    : assessSpecialistEvidence(finalMap, { cwd: context.cwd });
  if (finalMap !== null && finalAssessment !== null && finalAssessment.complete) {
    persistTrustedConcernProjection(context, finalMap, finalAssessment);
    return { turns, cost_usd: costUsd };
  }
  throw new Error(
    "repository specialist discovery did not reach semantic closure: "
      + (finalAssessment?.reasons.slice(0, 12).join("; ") ?? "canonical map is unavailable"),
  );
}

'''
run = replace_between(
    run,
    "async function repairSpecialistPortfolio(\n  context: RunContext,\n): Promise<{ turns: number; cost_usd: number | null }> {",
    "export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {",
    repair_function,
    "progress-aware specialist repair",
)

wrapper_function = r'''export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {
  const log = new AgentifyLog({ cwd: context.cwd, configDir: defaultConfigDir() });
  const startedAt = Date.now();
  let terminalWritten = false;
  try {
    const result = await runBaseRepositoryAudit({
      ...context,
      auditLog: log,
      deferAuditLogCompletion: true,
    });
    const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (map === null) throw new Error("repository audit returned without a canonical codebase map");
    const assessment = assessSpecialistEvidence(map, { cwd: context.cwd });
    let repair = { turns: 0, cost_usd: null as number | null };
    if (assessment.complete) {
      persistTrustedConcernProjection(context, map, assessment);
    } else {
      context.ui.info(
        "agentify: coverage closed, but specialist discovery was incomplete; running a bounded semantic repair",
      );
      repair = await repairSpecialistPortfolio(context, log);
    }

    const finalMap = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
    if (finalMap === null) throw new Error("canonical codebase map disappeared after specialist repair");
    const finalAssessment = assessSpecialistEvidence(finalMap, { cwd: context.cwd });
    if (!finalAssessment.complete) {
      throw new Error(
        `repository specialist discovery did not reach semantic closure: ${finalAssessment.reasons.join("; ")}`,
      );
    }
    const coverage = assessCoverageClosure(finalMap, { cwd: context.cwd });
    log.sessionEnd({
      duration_ms: Date.now() - startedAt,
      was_aborted: false,
      status: "success",
    });
    log.runEnd({
      exit_code: 0,
      status: "success",
      coverage: {
        covered: coverage.closed.length,
        gap: coverage.unresolved.length,
        total: coverage.closed.length + coverage.unresolved.length,
      },
      agents_md_path: null,
    });
    terminalWritten = true;
    context.ui.info(`agentify: audit log written to ${log.logPath}`);
    return {
      ...result,
      turns: result.turns + repair.turns,
      cost_usd: addCost(result.cost_usd, repair.cost_usd),
    };
  } catch (error) {
    if (!terminalWritten) {
      const map = loadCanonicalMapAt(context.cwd, AUDIT_STATE_RELATIVE_DIR);
      const coverage = map === null ? null : assessCoverageClosure(map, { cwd: context.cwd });
      log.sessionEnd({
        duration_ms: Date.now() - startedAt,
        was_aborted: context.signal?.aborted === true,
        status: "error",
      });
      log.runEnd({
        exit_code: -1,
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
        coverage: coverage === null ? undefined : {
          covered: coverage.closed.length,
          gap: coverage.unresolved.length,
          total: coverage.closed.length + coverage.unresolved.length,
        },
        agents_md_path: null,
      });
      terminalWritten = true;
      context.ui.info(`agentify: audit log written to ${log.logPath}`);
    }
    throw error;
  } finally {
    await log.close();
  }
}
'''
run = replace_between(
    run,
    "export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {",
    "\0__END_OF_FILE__\0",
    wrapper_function,
    "single terminal audit wrapper",
) if "\0__END_OF_FILE__\0" in run else run[:run.index("export async function runRepositoryAudit(context: RunContext): Promise<FocusedAuditResult> {")] + wrapper_function
run_path.write_text(run)

locality_test = r'''import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  assessSpecialistEvidence,
  reconcileSpecialistEvidence,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type Concern = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, repositoryPath: string): void {
  const absolute = path.join(cwd, ...repositoryPath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${repositoryPath}\n`);
}

function concern(input: {
  name: string;
  oneLine: string;
  covers: string;
  corePaths: string[];
  flowPaths: string[];
}): Concern {
  return {
    concern: input.name,
    one_line: input.oneLine,
    covers: input.covers,
    excludes: "Adjacent repository contracts remain separate.",
    flows: [{
      name: `${input.name} flow`,
      description: `Observed ${input.name} behavior.`,
      steps: input.flowPaths.map((repositoryPath, index) => ({
        path: repositoryPath,
        what_happens: `Distinct operation ${index + 1} in ${repositoryPath}.`,
      })),
    }],
    touchpoints: input.corePaths.map((repositoryPath) => ({
      path: repositoryPath,
      symbol: null,
      role: `Core ${input.name} implementation.`,
      line_range: null,
      centrality: "core" as const,
    })),
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this change alter ${input.name}?`],
    validation: ["bun run test"],
    spans_subtrees: ["src"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-26T00:00:00.000Z",
  };
}

function createRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-locality-closure-"));
  for (const repositoryPath of [
    "README.md",
    "package.json",
    "src/context.ts",
    "src/context.test.ts",
    "src/jsx/context.ts",
    "src/jsx/context.test.ts",
    "src/jsx/dom/context.ts",
    "src/jsx/dom/context.test.ts",
    "src/helper/ssg/ssg.ts",
    "src/helper/ssg/ssg.test.ts",
    "src/helper/ssg/middleware.ts",
    "runtime-tests/deno/middleware.test.tsx",
    "src/utils/mime.ts",
    "src/utils/mime.test.ts",
    "src/router.ts",
    "src/router/reg-exp-router/router.ts",
    "src/router/reg-exp-router/matcher.ts",
    "src/types.ts",
  ]) write(cwd, repositoryPath);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "locality fixture");
  return cwd;
}

function honoShapedMap(): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "TypeScript web framework";
  map.meta.languages = ["TypeScript", "TSX"];
  map.skeleton.entry_points = [{
    path: "src/context.ts",
    role: "request lifecycle",
    language: "TypeScript",
    run_command: "bun run test",
  }];
  map.skeleton.first_5_files_for_fresh_agent = [{
    path: "src/context.ts",
    why: "request state",
  }];
  map.module_graph.edges = [];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.pitfalls = [{
    module: "src/router/reg-exp-router/matcher.ts",
    what: "Matcher compilation is lazy.",
    consequence: "Cold-start routing behavior changes.",
    line_ref: 1,
  }];
  map.operational_surface.build.recipe_file = "package.json";
  map.open_questions = ["Initial draft: gather repository evidence before closing coverage."];
  map.concern_evidence = {
    concerns: [
      concern({
        name: "request lifecycle and middleware composition",
        oneLine: "Carries requests through middleware and Context response state.",
        covers: "Context, middleware dispatch, and response finalization.",
        corePaths: ["src/context.ts", "src/context.test.ts"],
        flowPaths: ["src/context.ts", "src/context.test.ts"],
      }),
      concern({
        name: "JSX rendering and DOM runtime",
        oneLine: "Preserves JSX context across server and DOM rendering.",
        covers: "JSX children, components, context providers, DOM state, and tests.",
        corePaths: ["src/jsx/context.ts", "src/jsx/dom/context.ts"],
        flowPaths: ["src/jsx/context.ts", "src/jsx/dom/context.ts"],
      }),
      concern({
        name: "static site generation and output safety",
        oneLine: "Generates static output and maps MIME extensions safely.",
        covers: "SSG orchestration, MIME mapping, and guarded writes.",
        corePaths: ["src/helper/ssg/ssg.ts", "src/helper/ssg/ssg.test.ts"],
        flowPaths: ["src/helper/ssg/ssg.ts", "src/helper/ssg/ssg.test.ts"],
      }),
      concern({
        name: "route matching and router selection",
        oneLine: "Compiles route matchers and selects router implementations.",
        covers: "Router contracts, RegExp matcher construction, and selection.",
        corePaths: ["src/router.ts", "src/router/reg-exp-router/router.ts"],
        flowPaths: ["src/router.ts", "src/router/reg-exp-router/router.ts"],
      }),
    ],
    not_concerns: [],
  };
  return map;
}

test("same-stem files are clustered by repository locality and attached to accepted concerns", () => {
  const cwd = createRepository();
  try {
    const map = honoShapedMap();
    const assessment = assessSpecialistEvidence(map, { cwd });
    assert.equal(assessment.complete, true, assessment.reasons.join("; "));
    const clusterKeys = assessment.repository_clusters.map((cluster) => cluster.cluster_key);
    assert.ok(clusterKeys.includes("context@src"));
    assert.ok(clusterKeys.includes("context@src/jsx"));
    assert.ok(clusterKeys.includes("context@src/jsx/dom"));
    assert.ok(!clusterKeys.some((key) => key.startsWith("middleware")));
    const attached = new Set(assessment.attachments.flatMap((attachment) => attachment.paths));
    assert.ok(attached.has("src/jsx/context.test.ts"));
    assert.ok(attached.has("src/jsx/dom/context.test.ts"));
    assert.ok(attached.has("src/utils/mime.ts"));
    assert.ok(attached.has("src/utils/mime.test.ts"));
    assert.ok(attached.has("src/router/reg-exp-router/matcher.ts"));

    const reconciled = reconcileSpecialistEvidence(map, assessment);
    const jsx = reconciled.concern_evidence?.concerns.find((entry) =>
      entry.concern === "JSX rendering and DOM runtime"
    );
    assert.ok(jsx?.touchpoints.some((touchpoint) => touchpoint.path === "src/jsx/context.test.ts"));
    assert.ok(jsx?.touchpoints.some((touchpoint) => touchpoint.path === "src/jsx/dom/context.test.ts"));

    map.module_graph.shared_abstractions = ["src/types.ts"];
    const typeGap = assessSpecialistEvidence(map, { cwd });
    assert.equal(typeGap.complete, false);
    assert.ok(typeGap.uncovered_paths.includes("src/types.ts"));
    assert.ok(typeGap.reasons.some((reason) => /high-signal repository files/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
'''
(ROOT / "tests/audit/locality-aware-semantic-closure.test.ts").write_text(locality_test)

tracked_test_path = ROOT / "tests/audit/tracked-specialist-closure.test.ts"
tracked = tracked_test_path.read_text()
tracked = replace_once(tracked, "class LastPassRepairRuntime", "class ProgressiveRepairRuntime", "progress runtime name")
tracked = replace_once(
    tracked,
    '''      if (this.repairCalls === 2) {
        const destination = path.join(
          options.cwd,
          options.spawnExplorerStateDir ?? ".agentify/runtime/audit",
          "codebase_map.json",
        );
        fs.writeFileSync(destination, `${JSON.stringify(aqaShapedMap(), null, 2)}\n`);
      }''',
    '''      if (this.repairCalls <= 3) {
        const destination = path.join(
          options.cwd,
          options.spawnExplorerStateDir ?? ".agentify/runtime/audit",
          "codebase_map.json",
        );
        const repaired = aqaShapedMap();
        if (this.repairCalls < 3) {
          repaired.concern_evidence!.concerns = repaired.concern_evidence!.concerns.slice(
            0,
            this.repairCalls,
          );
        }
        fs.writeFileSync(destination, `${JSON.stringify(repaired, null, 2)}\n`);
      }''',
    "progressive repair writes",
)
tracked = replace_once(
    tracked,
    'test("the final bounded repair pass may close the portfolio and persists only accepted concerns", async () => {',
    'test("progressive semantic repair may exceed two passes while each pass closes tracked gaps", async () => {',
    "progress test title",
)
tracked = replace_once(tracked, "const runtime = new LastPassRepairRuntime();", "const runtime = new ProgressiveRepairRuntime();", "progress runtime construction")
tracked = replace_once(tracked, "    assert.equal(runtime.repairCalls, 2);\n    assert.equal(result.turns, 3);", "    assert.equal(runtime.repairCalls, 3);\n    assert.equal(result.turns, 4);", "progress expectations")
needle = '''    assert.ok(persisted.concern_evidence?.not_concerns.some((entry) =>
      entry.candidate === "TKG playlist compilation and generated Make topology"
    ));
  } finally {'''
replacement = '''    assert.ok(persisted.concern_evidence?.not_concerns.some((entry) =>
      entry.candidate === "TKG playlist compilation and generated Make topology"
    ));

    const logDirectory = path.join(temporaryHome, ".agentify", "logs", "agentify");
    const logFiles = fs.readdirSync(logDirectory).filter((name) => name.endsWith(".jsonl"));
    assert.equal(logFiles.length, 1);
    const events = fs.readFileSync(path.join(logDirectory, logFiles[0]!), "utf8")
      .trim().split("\\n").map((line) => JSON.parse(line) as { event: string; payload: string });
    const runEnds = events.filter((event) => event.event === "agentify.run_end");
    assert.equal(runEnds.length, 1, "coverage and semantic repair must share one terminal outcome");
    assert.equal((JSON.parse(runEnds[0]!.payload) as { status: string }).status, "success");
  } finally {'''
last = tracked.rfind(needle)
if last < 0:
    raise RuntimeError("missing final tracked-specialist assertion for log test")
tracked = tracked[:last] + replacement + tracked[last + len(needle):]
tracked_test_path.write_text(tracked)

print("locality-aware semantic closure implementation applied")
