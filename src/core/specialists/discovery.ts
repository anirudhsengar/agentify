import type { CodebaseMap } from "../audit/schema.ts";
import type { Concern } from "../audit/schema/concerns.ts";
import { sortedUniqueStrings } from "../memory/serialization.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import type { MemoryConfidence } from "../memory/schema.ts";
import {
  MAX_DISCOVERED_PROCEDURES,
  SPECIALIST_PORTFOLIO_SCHEMA_VERSION,
  SPECIALIST_READ_ONLY_EXECUTION_POLICY,
  type ProcedureDefinition,
  type SpecialistDefinition,
  type SpecialistFlow,
  type SpecialistPortfolio,
  type SpecialistSourceKind,
  type SpecialistTouchpoint,
} from "./contracts.ts";
import { specialistPortfolioDigest, validateSpecialistPortfolio } from "./validation.ts";
import {
  executableValidationCommandArgv,
  executableValidationCommands,
  isExecutableValidationCommand,
  validationCommandArgvKey,
} from "./commands.ts";

// Specialist discovery turns the audit's concerns into persistent specialists.
//
// It does not decide what a specialist is. That judgment belongs to the audit,
// which reads the repository; encoding it here as scores and vocabularies is
// what previously produced directory-shaped specialists and, for repositories
// whose concerns did not resemble a web application, none at all.
//
// What this module does instead is verify. A concern becomes a specialist when
// its evidence resolves to real bytes tracked at the supporting commit.
// Everything else — how many concerns there are, what they are called, which
// files belong to them, whether two of them overlap — is the audit's answer to
// report, not this module's to second-guess.

const VALIDATION_SIGNAL = /(?:test|lint|typecheck|check|verify|build|audit|coverage)/i;
const PATH_FRAGMENT = /#.*$/;
const LINE_SUFFIX = /:(?:L)?\d+(?:-(?:L)?\d+)?$/i;
const DISPLAY_ANNOTATION_SUFFIX = /\s+\([^/\r\n]+\)$/;
const GLOB_SIGNAL = /[*?\[\]{}]/;
const URL_SIGNAL = /^[a-z][a-z0-9+.-]*:\/\//i;
const AGENTIFY_GENERATED_PATH = /^(?:\.agentify(?:\/|$)|\.github\/agentify(?:\/|$))/;
const WELL_KNOWN_FILE_NAMES = new Set([
  "dockerfile", "gemfile", "justfile", "license", "makefile", "procfile",
  "rakefile", "readme",
]);
const MAX_MEMORY_TEXT = 4_000;

/** Minimum verified touchpoints before a concern is worth persisting. */
const MIN_VERIFIED_TOUCHPOINTS = 1;

export interface SpecialistDiscoveryOptions {
  /** Exact argv vectors trusted by the installed repository task policy. */
  trustedValidationArgv?: ReadonlyArray<ReadonlyArray<string>>;
}

function boundedText(value: string, maximum = MAX_MEMORY_TEXT): string {
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum).trimEnd();
}

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function specialistSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "concern";
}

function normalizePathCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || URL_SIGNAL.test(trimmed)) return null;
  const withoutFragment = trimmed
    .replace(PATH_FRAGMENT, "")
    .replace(LINE_SUFFIX, "")
    .replace(DISPLAY_ANNOTATION_SUFFIX, "");
  if (!withoutFragment || withoutFragment === ".") return null;
  try {
    return normalizeMemoryRepositoryPath(withoutFragment, "specialist repository path")
      .replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizePaths(values: ReadonlyArray<string>): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const candidate = normalizePathCandidate(value);
    if (candidate !== null) normalized.push(candidate);
  }
  return sortedUniqueStrings(normalized);
}

function isLikelyFilePath(value: string): boolean {
  if (GLOB_SIGNAL.test(value) || value.endsWith("/")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;
  const name = segments.at(-1)?.toLowerCase() ?? "";
  return name.includes(".")
    || WELL_KNOWN_FILE_NAMES.has(name)
    || /^(?:bin|scripts|tools)\//.test(value);
}

function isVerifiedFilePath(
  value: string,
  trackedEvidenceFiles: ReadonlySet<string> | undefined,
): boolean {
  if (AGENTIFY_GENERATED_PATH.test(value)) return false;
  return trackedEvidenceFiles !== undefined
    ? trackedEvidenceFiles.has(value)
    : isLikelyFilePath(value);
}

function pathScopeBase(value: string): string {
  const wildcardIndex = value.search(GLOB_SIGNAL);
  const prefix = wildcardIndex < 0 ? value : value.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, "");
}

/**
 * Whether a repository path falls within a recorded scope.
 *
 * Used to match changed files against a specialist's context paths and against
 * procedure context. It answers "is this file one this specialist knows
 * about", never "does this specialist own this file" — several specialists
 * matching the same path is the expected outcome for cross-cutting concerns.
 */
export function pathMatchesScope(repositoryPath: string, scope: string): boolean {
  const pathValue = normalizePathCandidate(repositoryPath);
  const scopeValue = normalizePathCandidate(scope);
  if (pathValue === null || scopeValue === null) return false;
  const base = pathScopeBase(scopeValue);
  if (!base) return false;
  return pathValue === base || pathValue.startsWith(`${base}/`);
}

function topLevelArea(value: string): string | null {
  const normalized = normalizePathCandidate(value);
  if (normalized === null) return null;
  const root = normalized.split("/")[0]?.trim() ?? "";
  return root.length > 0 ? root : null;
}

interface ValidationCommandInventory {
  commands: string[];
  rejected: string[];
  untrusted: string[];
}

interface TrustedCommandIndex {
  bySemanticKey: ReadonlyMap<string, string>;
  commands: string[];
}

function commandStringFromArgv(argv: ReadonlyArray<string>): string {
  return argv.map((token) => {
    if (/^[A-Za-z0-9_@.+~:/=-]+$/.test(token)) return token;
    return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }).join(" ");
}

function semanticCommandKeys(argv: ReadonlyArray<string>): string[] {
  const keys = new Set([validationCommandArgvKey(argv)]);
  if (argv[0] === "npm" && argv[1] === "run" && argv[2] === "test") {
    keys.add(validationCommandArgvKey(["npm", "test", ...argv.slice(3)]));
  } else if (argv[0] === "npm" && argv[1] === "test") {
    keys.add(validationCommandArgvKey(["npm", "run", "test", ...argv.slice(2)]));
  }
  return [...keys];
}

function trustedCommandIndex(
  trustedValidationArgv: SpecialistDiscoveryOptions["trustedValidationArgv"],
): TrustedCommandIndex | undefined {
  if (trustedValidationArgv === undefined) return undefined;
  const bySemanticKey = new Map<string, string>();
  const commands: string[] = [];
  for (const argv of trustedValidationArgv) {
    if (argv.length === 0) continue;
    const command = commandStringFromArgv(argv);
    if (!isExecutableValidationCommand(command)) continue;
    commands.push(command);
    for (const key of semanticCommandKeys(argv)) {
      if (!bySemanticKey.has(key)) bySemanticKey.set(key, command);
    }
  }
  return {
    bySemanticKey,
    commands: sortedUniqueStrings(commands),
  };
}

function reconcileValidationCommands(
  values: ReadonlyArray<string>,
  trusted: TrustedCommandIndex | undefined,
): ValidationCommandInventory {
  const executable = executableValidationCommands(values);
  if (trusted === undefined) {
    return { ...executable, untrusted: [] };
  }
  const commands: string[] = [];
  const untrusted: string[] = [];
  for (const command of executable.commands) {
    const argv = executableValidationCommandArgv(command);
    const trustedCommand = argv === null
      ? undefined
      : semanticCommandKeys(argv)
          .map((key) => trusted.bySemanticKey.get(key))
          .find((candidate): candidate is string => candidate !== undefined);
    if (trustedCommand !== undefined) {
      commands.push(trustedCommand);
    } else {
      untrusted.push(command);
    }
  }
  return {
    commands: sortedUniqueStrings(commands),
    rejected: executable.rejected,
    untrusted: sortedUniqueStrings(untrusted),
  };
}

function allValidationCommands(
  map: CodebaseMap,
  trusted: TrustedCommandIndex | undefined,
): ValidationCommandInventory {
  const commands = [
    map.validation_surface.test_command,
    map.validation_surface.lint_command,
    map.validation_surface.typecheck_command,
    map.validation_surface.e2e_command,
    map.operational_surface.build.command,
    ...(map.validation_surface.ci_gates ?? [])
      .filter((gate) => gate.required)
      .map((gate) => gate.command),
    ...map.validation_surface.per_change_type.chore.mandatory,
    ...map.validation_surface.per_change_type.bug.mandatory,
    ...map.validation_surface.per_change_type.feature.mandatory,
    ...(map.validation_surface.per_change_type.refactor?.mandatory ?? []),
    ...(map.validation_surface.per_change_type.security?.mandatory ?? []),
  ];
  const reconciled = reconcileValidationCommands(
    commands.filter((command): command is string =>
      typeof command === "string" && command.trim().length > 0
    ),
    trusted,
  );
  return trusted === undefined
    ? reconciled
    : { ...reconciled, commands: [...trusted.commands] };
}

// ---------------------------------------------------------------------------
// Legacy input
// ---------------------------------------------------------------------------

/**
 * Adapt a pre-concern `expert_evidence.expert_domains` entry.
 *
 * Old maps recorded directory-shaped domains with no flows, no per-file roles,
 * and no scope boundary. The adaptation is deliberately lossy and honest about
 * it: the domain's paths become peripheral touchpoints with a generic role,
 * and confidence is capped, so an installation carried across the schema
 * change keeps working while making it obvious that a re-audit would produce a
 * better specialist.
 */
function concernFromLegacyExpertDomain(
  expert: NonNullable<CodebaseMap["expert_evidence"]>["expert_domains"][number],
): Concern {
  const paths = normalizePaths([
    ...expert.primary_paths,
    ...expert.entry_points,
    ...expert.test_paths,
    ...expert.key_files.map((file) => file.path),
    ...expert.key_types.map((type) => type.path),
    ...expert.patterns.map((pattern) => pattern.example_ref),
    ...expert.pitfalls.map((pitfall) => pitfall.reference),
  ]);
  return {
    concern: expert.domain,
    one_line: boundedText(expert.rationale, 512),
    covers: boundedText(expert.rationale),
    excludes: "Not recorded: migrated from a pre-concern audit map.",
    flows: [],
    touchpoints: paths.map((path) => ({
      path,
      symbol: null,
      role: "Recorded as domain evidence before per-touchpoint roles existed.",
      line_range: null,
      centrality: "supporting" as const,
    })),
    invariants: [],
    pitfalls: expert.pitfalls.map((pitfall) => ({
      risk: pitfall.risk,
      consequence: pitfall.consequence,
      reference: pitfall.reference,
    })),
    entry_questions: [],
    validation: expert.test_command ? [expert.test_command] : [],
    spans_subtrees: sortedUniqueStrings(
      paths.map(topLevelArea).filter((area): area is string => area !== null),
    ),
    stability: expert.stability,
    recurrence: expert.recurrence,
    confidence: "low",
    last_updated: expert.last_updated,
  };
}

function concernsFromMap(map: CodebaseMap): {
  concerns: Concern[];
  sourceKind: SpecialistSourceKind;
} {
  if (map.concern_evidence !== undefined) {
    return { concerns: [...map.concern_evidence.concerns], sourceKind: "concern_evidence" };
  }
  const legacy = map.expert_evidence?.expert_domains ?? [];
  return {
    concerns: legacy.map(concernFromLegacyExpertDomain),
    sourceKind: "legacy_expert_evidence",
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface VerifiedConcern {
  concern: Concern;
  touchpoints: SpecialistTouchpoint[];
  flows: SpecialistFlow[];
  droppedPaths: string[];
}

function verifyTouchpoints(
  concern: Concern,
  trackedEvidenceFiles: ReadonlySet<string> | undefined,
): { kept: SpecialistTouchpoint[]; dropped: string[] } {
  const kept: SpecialistTouchpoint[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const touchpoint of concern.touchpoints) {
    const path = normalizePathCandidate(touchpoint.path);
    if (path === null || !isVerifiedFilePath(path, trackedEvidenceFiles)) {
      dropped.push(path ?? touchpoint.path);
      continue;
    }
    const key = `${path}\u0000${touchpoint.symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      path,
      symbol: touchpoint.symbol === null ? null : boundedText(touchpoint.symbol, 256),
      role: boundedText(touchpoint.role, 1_024),
      line_range: touchpoint.line_range === null
        ? null
        : [touchpoint.line_range[0], touchpoint.line_range[1]],
      centrality: touchpoint.centrality,
    });
  }
  kept.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    return byPath !== 0 ? byPath : (left.symbol ?? "").localeCompare(right.symbol ?? "");
  });
  return { kept, dropped: sortedUniqueStrings(dropped) };
}

/**
 * Keep only flow steps whose path survived verification.
 *
 * A flow that loses a step is still worth keeping — it tells a specialist most
 * of the route — but a flow reduced below two steps is no longer a trace, so
 * it is dropped entirely rather than persisted as a single misleading hop.
 */
function verifyFlows(
  concern: Concern,
  verifiedPaths: ReadonlySet<string>,
): SpecialistFlow[] {
  const flows: SpecialistFlow[] = [];
  for (const flow of concern.flows) {
    const steps = flow.steps
      .map((step) => ({ path: normalizePathCandidate(step.path), what_happens: step.what_happens }))
      .filter((step): step is { path: string; what_happens: string } =>
        step.path !== null && verifiedPaths.has(step.path)
      )
      .map((step) => ({ path: step.path, what_happens: boundedText(step.what_happens, 1_024) }));
    if (steps.length < 2) continue;
    flows.push({
      name: boundedText(flow.name, 256),
      description: boundedText(flow.description, 1_024),
      steps,
    });
  }
  return flows.sort((left, right) => left.name.localeCompare(right.name));
}

function confidenceFor(concern: Concern, verified: VerifiedConcern): MemoryConfidence {
  // The audit's own confidence is the ceiling; verification can only lower it.
  const declared: MemoryConfidence = concern.confidence === "high"
    ? "high"
    : concern.confidence === "medium"
      ? "medium"
      : "low";
  const hasTrace = verified.flows.length > 0;
  const hasCore = verified.touchpoints.some((touchpoint) => touchpoint.centrality === "core");
  const lostMost = verified.droppedPaths.length > verified.touchpoints.length;
  if (lostMost) return "low";
  if (declared === "high" && hasTrace && hasCore) return "high";
  if (declared === "low") return "low";
  return hasTrace || hasCore ? "medium" : "low";
}

function tracePathCandidate(value: string): string | null {
  const trimmed = value.trim();
  const firstToken = trimmed.split(/\s+/, 1)[0];
  if (firstToken && firstToken !== trimmed) {
    const tokenPath = normalizePathCandidate(firstToken);
    if (tokenPath !== null) return tokenPath;
  }
  return normalizePathCandidate(trimmed);
}

function addDependencyTouchpoint(
  specialist: SpecialistDefinition,
  repositoryPath: string,
  role: string,
): void {
  if (!specialist.touchpoints.some((touchpoint) => touchpoint.path === repositoryPath)) {
    specialist.touchpoints = [
      ...specialist.touchpoints,
      {
        path: repositoryPath,
        symbol: null,
        role: boundedText(role, 1_024),
        line_range: null,
        centrality: "supporting" as const,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)).slice(0, 512);
  }
  specialist.context_paths = sortedUniqueStrings([
    ...specialist.context_paths,
    repositoryPath,
  ]).slice(0, 512);
  specialist.evidence_paths = sortedUniqueStrings([
    ...specialist.evidence_paths,
    repositoryPath,
  ]).slice(0, 256);
  specialist.freshness_dependencies = sortedUniqueStrings([
    ...specialist.freshness_dependencies,
    repositoryPath,
  ]).slice(0, 512);
  const area = topLevelArea(repositoryPath);
  if (area !== null) {
    specialist.spans_subtrees = sortedUniqueStrings([
      ...specialist.spans_subtrees,
      area,
    ]).slice(0, 128);
  }
}

/**
 * Add one-hop repository dependencies and the traced shared type contract to
 * each specialist. These are context dependencies, not ownership claims. The
 * added overlap is then used to connect related specialists.
 */
function enrichSpecialistDependencyContext(
  map: CodebaseMap,
  specialists: SpecialistDefinition[],
  trackedEvidenceFiles: ReadonlySet<string> | undefined,
): void {
  if (trackedEvidenceFiles === undefined || specialists.length === 0) return;

  const verified = (value: string): string | null => {
    const candidate = normalizePathCandidate(value);
    return candidate !== null && isVerifiedFilePath(candidate, trackedEvidenceFiles)
      ? candidate
      : null;
  };
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    const neighbors = adjacency.get(left) ?? new Set<string>();
    neighbors.add(right);
    adjacency.set(left, neighbors);
  };
  for (const edge of map.module_graph.edges) {
    const from = verified(edge.from);
    const to = verified(edge.to);
    if (from === null || to === null || from === to) continue;
    connect(from, to);
    connect(to, from);
  }

  const trace = map.type_contract_surface.one_type_trace;
  const tracePaths = trace === null
    ? []
    : sortedUniqueStrings(
        trace.flow
          .map(tracePathCandidate)
          .filter((candidate): candidate is string =>
            candidate !== null && trackedEvidenceFiles.has(candidate)
          ),
      );
  const typeDefinitions = [
    ...(map.type_contract_surface.type_definitions ?? []),
    ...map.type_contract_surface.typescript_interfaces,
    ...map.type_contract_surface.pydantic_models,
    ...map.type_contract_surface.db_models,
  ];
  const tracedDefinitionPaths = trace === null
    ? []
    : sortedUniqueStrings(typeDefinitions
        .filter((definition) => definition.name.trim().toLowerCase() === trace.name.trim().toLowerCase())
        .map((definition) => verified(definition.path))
        .filter((candidate): candidate is string => candidate !== null));

  for (const specialist of specialists) {
    const originalContext = new Set(specialist.context_paths);
    const graphDependencies = new Set<string>();
    for (const repositoryPath of originalContext) {
      for (const dependency of adjacency.get(repositoryPath) ?? []) {
        if (!originalContext.has(dependency)) graphDependencies.add(dependency);
      }
    }
    for (const dependency of [...graphDependencies]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 32)) {
      addDependencyTouchpoint(
        specialist,
        dependency,
        "Shared repository dependency connected to this concern by the audited module graph.",
      );
    }

    if (trace !== null && tracePaths.some((repositoryPath) => originalContext.has(repositoryPath))) {
      for (const definitionPath of tracedDefinitionPaths.slice(0, 8)) {
        addDependencyTouchpoint(
          specialist,
          definitionPath,
          `Shared ${boundedText(trace.name, 256)} contract definition consumed by this concern.`,
        );
      }
    }
  }
}

function buildSpecialistDefinitions(
  map: CodebaseMap,
  concerns: ReadonlyArray<Concern>,
  sourceKind: SpecialistSourceKind,
  globalCommands: ReadonlyArray<string>,
  supportingCommit: string,
  trackedEvidenceFiles: ReadonlySet<string> | undefined,
  trusted: TrustedCommandIndex | undefined,
): {
  specialists: SpecialistDefinition[];
  rejected: Array<{ concern: string; reason: string }>;
  rejectedCommands: string[];
  untrustedCommands: string[];
} {
  const rejected: Array<{ concern: string; reason: string }> = [];
  const rejectedCommands: string[] = [];
  const untrustedCommands: string[] = [];
  const verified: VerifiedConcern[] = [];

  for (const concern of concerns) {
    const { kept, dropped } = verifyTouchpoints(concern, trackedEvidenceFiles);
    if (kept.length < MIN_VERIFIED_TOUCHPOINTS) {
      rejected.push({
        concern: concern.concern,
        reason: dropped.length > 0
          ? `no touchpoint is a file tracked at ${supportingCommit.slice(0, 8)} (checked ${dropped.length}: ${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", …" : ""})`
          : "no touchpoints were recorded",
      });
      continue;
    }
    const verifiedPaths = new Set(kept.map((touchpoint) => touchpoint.path));
    const flows = verifyFlows(concern, verifiedPaths);
    if (
      sourceKind === "concern_evidence"
      && !kept.some((touchpoint) => touchpoint.centrality === "core")
    ) {
      rejected.push({
        concern: concern.concern,
        reason: "no core touchpoint is a tracked file",
      });
      continue;
    }
    verified.push({
      concern,
      touchpoints: kept,
      flows,
      droppedPaths: dropped,
    });
  }

  const specialists = verified
    .map((entry): SpecialistDefinition => {
      const concern = entry.concern;
      const contextPaths = sortedUniqueStrings([
        ...entry.touchpoints.map((touchpoint) => touchpoint.path),
        ...entry.flows.flatMap((flow) => flow.steps.map((step) => step.path)),
      ]);
      const concernCommands = reconcileValidationCommands(concern.validation, trusted);
      rejectedCommands.push(...concernCommands.rejected);
      untrustedCommands.push(...concernCommands.untrusted);
      const validationCommands = sortedUniqueStrings([
        ...concernCommands.commands,
        ...globalCommands,
      ]).slice(0, 32);
      return {
        specialist_id: `specialist-${specialistSlug(concern.concern)}`,
        display_name: boundedText(`${titleCase(concern.concern)} Specialist`, 256),
        concern: boundedText(concern.concern, 256),
        one_line: boundedText(concern.one_line, 512),
        covers: boundedText(concern.covers),
        excludes: boundedText(concern.excludes),
        flows: entry.flows.slice(0, 32),
        touchpoints: entry.touchpoints.slice(0, 512),
        invariants: concern.invariants.map((invariant) => ({
          rule: boundedText(invariant.rule, 1_024),
          why: boundedText(invariant.why, 1_024),
          reference: invariant.reference,
        })).slice(0, 64),
        pitfalls: concern.pitfalls.map((pitfall) => ({
          risk: boundedText(pitfall.risk, 1_024),
          consequence: boundedText(pitfall.consequence, 1_024),
          reference: pitfall.reference,
        })).slice(0, 64),
        entry_questions: sortedUniqueStrings(
          concern.entry_questions.map((question) => boundedText(question, 512)),
        ).slice(0, 32),
        related_specialists: [],
        validation_commands: validationCommands,
        evidence_paths: contextPaths.slice(0, 256),
        context_paths: contextPaths.slice(0, 512),
        spans_subtrees: sortedUniqueStrings(
          contextPaths.map(topLevelArea).filter((area): area is string => area !== null),
        ),
        freshness_dependencies: contextPaths.slice(0, 512),
        supporting_commit: supportingCommit,
        freshness: "current",
        confidence: confidenceFor(concern, entry),
        source_kinds: [sourceKind],
        execution_policy: { ...SPECIALIST_READ_ONLY_EXECUTION_POLICY },
      };
    });

  enrichSpecialistDependencyContext(map, specialists, trackedEvidenceFiles);

  // Two specialists sharing a touchpoint are related, not duplicates. This is
  // the signal the previous implementation used to merge them together, which
  // is precisely backwards: shared files are how cross-cutting concerns
  // present themselves, and knowing who else reads a file is what lets one
  // specialist warn about another's invariants.
  for (const left of specialists) {
    for (const right of specialists) {
      if (left.specialist_id === right.specialist_id) continue;
      const shares = left.context_paths.some((path) => right.context_paths.includes(path));
      if (!shares) continue;
      left.related_specialists = sortedUniqueStrings([
        ...left.related_specialists,
        right.specialist_id,
      ]).slice(0, 32);
    }
  }

  return {
    specialists: specialists.sort((left, right) =>
      left.specialist_id.localeCompare(right.specialist_id)
    ),
    rejected,
    rejectedCommands: sortedUniqueStrings(rejectedCommands),
    untrustedCommands: sortedUniqueStrings(untrustedCommands),
  };
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

function procedureOwner(
  paths: ReadonlyArray<string>,
  specialists: ReadonlyArray<SpecialistDefinition>,
): string | null {
  const ranked = specialists
    .map((specialist) => ({
      specialist,
      score: paths.filter((candidate) =>
        specialist.context_paths.some((scope) => pathMatchesScope(candidate, scope))
      ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore !== 0
        ? byScore
        : left.specialist.specialist_id.localeCompare(right.specialist.specialist_id);
    });
  return ranked[0]?.specialist.specialist_id ?? null;
}

function procedureConfidence(
  sourceKind: ProcedureDefinition["source_kind"],
  evidencePaths: ReadonlyArray<string>,
  validationCommands: ReadonlyArray<string>,
): MemoryConfidence {
  if (sourceKind === "domain_validation" && evidencePaths.length > 0) return "high";
  if (evidencePaths.length > 0 && validationCommands.length > 0) return "medium";
  return "low";
}

function mergeProcedureDefinitions(
  definitions: ReadonlyArray<ProcedureDefinition>,
): ProcedureDefinition[] {
  const merged = new Map<string, ProcedureDefinition>();
  for (const definition of [...definitions].sort((left, right) =>
    left.procedure_id.localeCompare(right.procedure_id)
  )) {
    const existing = merged.get(definition.procedure_id);
    if (!existing) {
      merged.set(definition.procedure_id, {
        ...definition,
        name: boundedText(definition.name, 256),
        purpose: boundedText(definition.purpose),
        trigger_conditions: sortedUniqueStrings(definition.trigger_conditions).slice(0, 64),
        required_context_paths: sortedUniqueStrings(definition.required_context_paths).slice(0, 256),
        allowed_commands: sortedUniqueStrings(definition.allowed_commands).slice(0, 64),
        expected_file_patterns: sortedUniqueStrings(definition.expected_file_patterns).slice(0, 128),
        side_effects: sortedUniqueStrings(definition.side_effects).slice(0, 64),
        validation_commands: sortedUniqueStrings(definition.validation_commands).slice(0, 64),
        recovery_steps: [...new Set(definition.recovery_steps.map((step) => boundedText(step)))].slice(0, 64),
        evidence_paths: sortedUniqueStrings(definition.evidence_paths).slice(0, 128),
        freshness_dependencies: sortedUniqueStrings(definition.freshness_dependencies).slice(0, 512),
      });
      continue;
    }
    merged.set(definition.procedure_id, {
      ...existing,
      purpose: existing.purpose.length >= definition.purpose.length
        ? existing.purpose
        : definition.purpose,
      owner_specialist_id: existing.owner_specialist_id ?? definition.owner_specialist_id,
      trigger_conditions: sortedUniqueStrings([
        ...existing.trigger_conditions,
        ...definition.trigger_conditions,
      ]).slice(0, 64),
      required_context_paths: sortedUniqueStrings([
        ...existing.required_context_paths,
        ...definition.required_context_paths,
      ]).slice(0, 256),
      allowed_commands: sortedUniqueStrings([
        ...existing.allowed_commands,
        ...definition.allowed_commands,
      ]).slice(0, 64),
      expected_file_patterns: sortedUniqueStrings([
        ...existing.expected_file_patterns,
        ...definition.expected_file_patterns,
      ]).slice(0, 128),
      side_effects: sortedUniqueStrings([
        ...existing.side_effects,
        ...definition.side_effects,
      ]).slice(0, 64),
      validation_commands: sortedUniqueStrings([
        ...existing.validation_commands,
        ...definition.validation_commands,
      ]).slice(0, 64),
      recovery_steps: [...new Set([
        ...existing.recovery_steps,
        ...definition.recovery_steps,
      ].map((step) => boundedText(step)))].slice(0, 64),
      evidence_paths: sortedUniqueStrings([
        ...existing.evidence_paths,
        ...definition.evidence_paths,
      ]).slice(0, 128),
      freshness_dependencies: sortedUniqueStrings([
        ...existing.freshness_dependencies,
        ...definition.freshness_dependencies,
      ]).slice(0, 512),
      confidence: existing.confidence === "high" || definition.confidence === "high"
        ? "high"
        : existing.confidence === "medium" || definition.confidence === "medium"
          ? "medium"
          : "low",
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.procedure_id.localeCompare(right.procedure_id)
  );
}

function buildProcedureDefinitions(
  map: CodebaseMap,
  specialists: ReadonlyArray<SpecialistDefinition>,
  globalCommands: ReadonlyArray<string>,
  supportingCommit: string,
  trackedEvidenceFiles?: ReadonlySet<string>,
  rejectedCommands: string[] = [],
  untrustedCommands: string[] = [],
  trusted?: TrustedCommandIndex,
): ProcedureDefinition[] {
  const definitions: ProcedureDefinition[] = [];
  const defaultRecovery = [
    "Stop after the first deterministic failure and preserve its output.",
    "Repair the root cause without weakening validation or repository policy.",
    "Rerun the focused command, then the complete required validation set.",
  ];

  for (const candidate of map.customization_evidence?.custom_tool_candidates ?? []) {
    const sourcePath = candidate.source_path
      ? normalizePathCandidate(candidate.source_path)
      : null;
    const evidencePaths = sourcePath && isVerifiedFilePath(sourcePath, trackedEvidenceFiles)
      ? [sourcePath]
      : [];
    const existingCommand = reconcileValidationCommands(
      [candidate.existing_command],
      trusted,
    );
    rejectedCommands.push(...existingCommand.rejected);
    untrustedCommands.push(...existingCommand.untrusted);
    const validationCommands = sortedUniqueStrings([
      ...(VALIDATION_SIGNAL.test(candidate.existing_command)
        ? existingCommand.commands
        : []),
      ...globalCommands,
    ]).slice(0, 16);
    if (
      evidencePaths.length === 0
      || existingCommand.commands.length === 0
      || validationCommands.length === 0
    ) continue;
    const procedureId = specialistSlug(candidate.name);
    definitions.push({
      procedure_id: procedureId,
      name: candidate.name,
      purpose: boundedText(candidate.purpose),
      owner_specialist_id: procedureOwner(evidencePaths, specialists),
      trigger_conditions: sortedUniqueStrings([boundedText(candidate.purpose), boundedText(candidate.name, 256)]).slice(0, 64),
      required_context_paths: evidencePaths,
      allowed_commands: existingCommand.commands,
      expected_file_patterns: evidencePaths,
      side_effects: [boundedText(`Runs repository command: ${candidate.existing_command.trim()}`)],
      validation_commands: validationCommands,
      recovery_steps: [...defaultRecovery],
      evidence_paths: evidencePaths,
      freshness_dependencies: evidencePaths,
      confidence: procedureConfidence("custom_tool", evidencePaths, validationCommands),
      supporting_commit: supportingCommit,
      freshness: "current",
      source_kind: "custom_tool",
    });
  }

  for (const specialist of specialists) {
    if (specialist.validation_commands.length === 0 || specialist.evidence_paths.length === 0) continue;
    definitions.push({
      procedure_id: `validate-${specialistSlug(specialist.concern)}`,
      name: `Validate ${specialist.concern}`,
      purpose: `Run the authoritative validation surface for ${specialist.concern} changes.`,
      owner_specialist_id: specialist.specialist_id,
      trigger_conditions: sortedUniqueStrings([
        `${specialist.concern} change`,
        ...specialist.entry_questions,
      ]).slice(0, 64),
      required_context_paths: specialist.context_paths,
      allowed_commands: specialist.validation_commands,
      expected_file_patterns: specialist.context_paths,
      side_effects: ["May create repository-local test, build, or coverage artifacts."],
      validation_commands: specialist.validation_commands,
      recovery_steps: [...defaultRecovery],
      evidence_paths: specialist.evidence_paths,
      freshness_dependencies: specialist.freshness_dependencies,
      confidence: procedureConfidence(
        "domain_validation",
        specialist.evidence_paths,
        specialist.validation_commands,
      ),
      supporting_commit: supportingCommit,
      freshness: "current",
      source_kind: "domain_validation",
    });
  }

  const repositoryEvidence = normalizePaths([
    map.operational_surface.build.recipe_file,
    ...map.skeleton.entry_points.map((entry) => entry.path),
  ]).filter((candidate) => isVerifiedFilePath(candidate, trackedEvidenceFiles));
  if (repositoryEvidence.length > 0 && globalCommands.length > 0) {
    definitions.push({
      procedure_id: "validate-repository-change",
      name: "Validate repository change",
      purpose: "Run the repository's authoritative validation contract before review.",
      owner_specialist_id: null,
      trigger_conditions: [
        "before review",
        "validate change",
        "test implementation",
        "release check",
      ],
      required_context_paths: repositoryEvidence,
      allowed_commands: [...globalCommands],
      expected_file_patterns: [],
      side_effects: ["May create repository-local test, build, or coverage artifacts."],
      validation_commands: [...globalCommands],
      recovery_steps: [...defaultRecovery],
      evidence_paths: repositoryEvidence,
      freshness_dependencies: repositoryEvidence,
      confidence: procedureConfidence(
        "repository_validation",
        repositoryEvidence,
        globalCommands,
      ),
      supporting_commit: supportingCommit,
      freshness: "current",
      source_kind: "repository_validation",
    });
  }

  const sourcePriority: Partial<Record<ProcedureDefinition["source_kind"], number>> = {
    domain_validation: 5,
    repository_validation: 5,
    custom_tool: 3,
  };
  return mergeProcedureDefinitions(definitions)
    .sort((left, right) => {
      const byPriority = (sourcePriority[right.source_kind] ?? 0) - (sourcePriority[left.source_kind] ?? 0);
      return byPriority !== 0 ? byPriority : left.procedure_id.localeCompare(right.procedure_id);
    })
    .slice(0, MAX_DISCOVERED_PROCEDURES)
    .sort((left, right) => left.procedure_id.localeCompare(right.procedure_id));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function discoverSpecialistPortfolio(
  map: CodebaseMap,
  supportingCommit: string,
  trackedRepositoryFiles?: ReadonlyArray<string>,
  options: SpecialistDiscoveryOptions = {},
): SpecialistPortfolio {
  const trackedEvidenceFiles = trackedRepositoryFiles
    ? new Set(normalizePaths(trackedRepositoryFiles))
    : undefined;
  const { concerns, sourceKind } = concernsFromMap(map);
  const trusted = trustedCommandIndex(options.trustedValidationArgv);
  const validationInventory = allValidationCommands(map, trusted);
  const {
    specialists,
    rejected,
    rejectedCommands,
    untrustedCommands,
  } = buildSpecialistDefinitions(
    map,
    concerns,
    sourceKind,
    validationInventory.commands,
    supportingCommit,
    trackedEvidenceFiles,
    trusted,
  );
  const commandRejections = [
    ...validationInventory.rejected,
    ...rejectedCommands,
  ];
  const commandTrustRejections = [
    ...validationInventory.untrusted,
    ...untrustedCommands,
  ];
  const procedures = buildProcedureDefinitions(
    map,
    specialists,
    validationInventory.commands,
    supportingCommit,
    trackedEvidenceFiles,
    commandRejections,
    commandTrustRejections,
    trusted,
  );

  // A warning has to say what to change. "No domain met the threshold" sent a
  // reader looking for a threshold; naming the concern and the reason its
  // evidence failed points at the actual repair.
  const warnings: string[] = [];
  if (concerns.length === 0) {
    warnings.push(
      "The audit recorded no repository concerns, so no specialist could be created. "
      + "Check the map's open_questions and concern_evidence.not_concerns for the audit's justification. "
      + "Re-running agentify attaches to the existing map without re-auditing; to force concern "
      + "re-discovery, remove the concern_evidence section from "
      + ".agentify/runtime/audit/codebase_map.json (or delete the map for a full re-audit) and run agentify again.",
    );
  }
  for (const entry of rejected) {
    warnings.push(`Concern "${entry.concern}" did not become a specialist: ${entry.reason}.`);
  }
  if (sourceKind === "legacy_expert_evidence" && specialists.length > 0) {
    warnings.push(
      "Specialists were migrated from a pre-concern audit map: they carry no traced flows "
      + "or per-file roles. Re-run the audit to replace them with traced concerns.",
    );
  }
  for (const command of sortedUniqueStrings(commandRejections).slice(0, 12)) {
    warnings.push(
      `Ignored non-executable validation directive: ${JSON.stringify(command)}. `
      + "Record an exact single command instead of prose or a conditional instruction.",
    );
  }
  for (const command of sortedUniqueStrings(commandTrustRejections).slice(0, 12)) {
    warnings.push(
      `Ignored executable but unverified validation command: ${JSON.stringify(command)}. `
      + "Only commands that passed installer verification and appear in the trusted repository task policy may be persisted in specialists or procedures.",
    );
  }
  if (procedures.length === 0) {
    warnings.push("No repository-specific procedure had both concrete evidence and executable validation commands.");
  }

  // The portfolio's own grounding, and the provenance a later retirement
  // cites. Procedures contribute too, so a repository whose concerns were all
  // rejected still has verified evidence to retire stale specialists against.
  const evidencePaths = sortedUniqueStrings([
    ...specialists.flatMap((specialist) => specialist.evidence_paths),
    ...procedures.flatMap((procedure) => procedure.evidence_paths),
  ]).slice(0, 256);
  const portfolioWithoutDigest = {
    schema_version: SPECIALIST_PORTFOLIO_SCHEMA_VERSION,
    supporting_commit: supportingCommit,
    evidence_paths: evidencePaths,
    specialists,
    procedures,
    warnings: sortedUniqueStrings(warnings),
  };
  const portfolio: SpecialistPortfolio = {
    ...portfolioWithoutDigest,
    source_map_digest: specialistPortfolioDigest({
      evidence_paths: evidencePaths,
      specialists,
      procedures,
    }),
  };
  return validateSpecialistPortfolio(portfolio);
}
