import type { CodebaseMap } from "../audit/schema.ts";
import { sortedUniqueStrings } from "../memory/serialization.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import type { MemoryConfidence } from "../memory/schema.ts";
import {
  MAX_DISCOVERED_PROCEDURES,
  MAX_DISCOVERED_SPECIALISTS,
  SPECIALIST_PORTFOLIO_SCHEMA_VERSION,
  SPECIALIST_READ_ONLY_EXECUTION_POLICY,
  type ProcedureDefinition,
  type SpecialistDefinition,
  type SpecialistPortfolio,
  type SpecialistSourceKind,
} from "./contracts.ts";
import { specialistPortfolioDigest, validateSpecialistPortfolio } from "./validation.ts";

interface RawSpecialist {
  slug: string;
  domain: string;
  purpose: string;
  ownedPaths: string[];
  observedPaths: string[];
  contracts: string[];
  patterns: string[];
  pitfalls: string[];
  validationCommands: string[];
  evidencePaths: string[];
  sourceKinds: SpecialistSourceKind[];
  stability: "high" | "medium" | "low" | null;
  recurrence: "high" | "medium" | "low" | null;
}

interface ContractReference {
  path: string;
  description: string;
}

const GENERIC_DOMAIN_NAMES = new Set([
  "app",
  "application",
  "codebase",
  "docs",
  "documentation",
  "general",
  "misc",
  "repository",
  "src",
  "source",
]);
const STRUCTURAL_CONTAINER_ROOTS = new Set([
  "apps",
  "components",
  "modules",
  "packages",
  "services",
  "workspaces",
]);
const NON_APPLICATION_ROOTS = new Set([
  ".agentify",
  ".github",
  "docs",
  "scripts",
  "test",
  "tests",
]);

const VALIDATION_SIGNAL = /(?:test|lint|typecheck|check|verify|build|audit|coverage)/i;
const PATH_FRAGMENT = /#.*$/;
const LINE_SUFFIX = /:(?:L)?\d+(?:-(?:L)?\d+)?$/i;
const DISPLAY_ANNOTATION_SUFFIX = /\s+\([^/\r\n]+\)$/;
const GLOB_SIGNAL = /[*?\[\]{}]/;
const URL_SIGNAL = /^[a-z][a-z0-9+.-]*:\/\//i;
const WELL_KNOWN_FILE_NAMES = new Set([
  "dockerfile", "gemfile", "justfile", "license", "makefile", "procfile",
  "rakefile", "readme",
]);
const MAX_MEMORY_TEXT = 4_000;

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
  return slug || "domain";
}

function specialistDomainSlug(value: string): string {
  const slug = specialistSlug(value);
  if (slug === "payment" || slug === "payments") return "billing";
  return slug;
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

function pathScopeBase(value: string): string {
  const wildcardIndex = value.search(GLOB_SIGNAL);
  const prefix = wildcardIndex < 0 ? value : value.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, "");
}

export function pathMatchesScope(repositoryPath: string, scope: string): boolean {
  const pathValue = normalizePathCandidate(repositoryPath);
  const scopeValue = normalizePathCandidate(scope);
  if (pathValue === null || scopeValue === null) return false;
  const base = pathScopeBase(scopeValue);
  if (!base) return false;
  return pathValue === base || pathValue.startsWith(`${base}/`);
}

function scopesOverlap(left: string, right: string): boolean {
  return pathMatchesScope(left, right) || pathMatchesScope(right, left);
}

function allValidationCommands(map: CodebaseMap): string[] {
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
  return sortedUniqueStrings(commands.filter((command): command is string =>
    typeof command === "string" && command.trim().length > 0
  ));
}

function allKnownPaths(map: CodebaseMap): string[] {
  const paths = [
    ...map.skeleton.top_level_tree,
    ...map.skeleton.entry_points.map((entry) => entry.path),
    ...map.skeleton.first_5_files_for_fresh_agent.map((entry) => entry.path),
    ...map.module_graph.edges.flatMap((edge) => [edge.from, edge.to]),
    ...map.module_graph.parallelizable_subtrees.flat(),
    ...map.module_graph.shared_abstractions,
    ...map.pitfalls.map((pitfall) => pitfall.module),
    ...map.conventions.patterns.map((pattern) => pattern.where),
    ...(map.validation_surface.e2e_test_files ?? []),
    ...(map.validation_surface.e2e_config_path ? [map.validation_surface.e2e_config_path] : []),
    map.operational_surface.build.recipe_file,
    ...(map.operational_surface.scripts_dir_files ?? []),
    ...(map.operational_surface.prepare_app
      ? [
          map.operational_surface.prepare_app.reset_db,
          map.operational_surface.prepare_app.start,
          map.operational_surface.prepare_app.stop,
        ].filter((value): value is string => value !== null)
      : []),
    ...map.type_contract_surface.pydantic_models.map((item) => item.path),
    ...map.type_contract_surface.typescript_interfaces.map((item) => item.path),
    ...map.type_contract_surface.db_models.map((item) => item.path),
    ...(map.type_contract_surface.api_contracts ?? []).map((item) => item.path),
    ...(map.expert_evidence?.expert_domains ?? []).flatMap((expert) => [
      ...expert.entry_points,
      ...expert.test_paths,
      ...expert.key_files.map((file) => file.path),
      ...expert.key_types.map((type) => type.path),
      ...expert.patterns.map((pattern) => pattern.example_ref),
      ...expert.pitfalls.map((pitfall) => pitfall.reference),
    ]),
  ];
  return normalizePaths(paths);
}

function contractReferences(map: CodebaseMap): ContractReference[] {
  const references: ContractReference[] = [];
  for (const item of [
    ...map.type_contract_surface.pydantic_models,
    ...map.type_contract_surface.typescript_interfaces,
  ]) {
    const pathValue = normalizePathCandidate(item.path);
    if (pathValue !== null) {
      references.push({
        path: pathValue,
        description: boundedText(`${item.name}: ${item.fields.join(", ")}`),
      });
    }
  }
  for (const item of map.type_contract_surface.db_models) {
    const pathValue = normalizePathCandidate(item.path);
    if (pathValue !== null) {
      references.push({
        path: pathValue,
        description: boundedText(`${item.name} (${item.table}): ${item.fields.join(", ")}`),
      });
    }
  }
  for (const item of map.type_contract_surface.api_contracts ?? []) {
    const pathValue = normalizePathCandidate(item.path);
    if (pathValue !== null) {
      references.push({
        path: pathValue,
        description: boundedText(`${item.schema_kind} contract with ${item.endpoint_count} endpoint(s)`),
      });
    }
  }
  return references.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    return byPath !== 0 ? byPath : left.description.localeCompare(right.description);
  });
}

function pathsForScopes(knownPaths: ReadonlyArray<string>, scopes: ReadonlyArray<string>): string[] {
  return knownPaths.filter((candidate) => scopes.some((scope) => pathMatchesScope(candidate, scope)));
}

function commandsForDomain(
  domainTestCommand: string | null,
  globalCommands: ReadonlyArray<string>,
): string[] {
  return sortedUniqueStrings([
    ...(domainTestCommand ? [domainTestCommand] : []),
    ...globalCommands,
  ]).slice(0, 16);
}

function rawFromExpertEvidence(
  map: CodebaseMap,
  knownPaths: ReadonlyArray<string>,
  contracts: ReadonlyArray<ContractReference>,
  globalCommands: ReadonlyArray<string>,
): RawSpecialist[] {
  return (map.expert_evidence?.expert_domains ?? []).map((expert) => {
    const slug = specialistDomainSlug(expert.domain);
    const ownedPaths = normalizePaths(expert.primary_paths);
    const explicitPaths = normalizePaths([
      ...expert.entry_points,
      ...expert.test_paths,
      ...expert.key_files.map((file) => file.path),
      ...expert.key_types.map((type) => type.path),
      ...expert.patterns.map((pattern) => pattern.example_ref),
      ...expert.pitfalls.map((pitfall) => pitfall.reference),
    ]);
    const observedPaths = sortedUniqueStrings([
      ...explicitPaths,
      ...pathsForScopes(knownPaths, ownedPaths),
    ]);
    const scopedContracts = sortedUniqueStrings([
      ...expert.key_types.map((type) => boundedText(`${type.name}: ${type.purpose}`)),
      ...contracts
        .filter((contract) => [...ownedPaths, ...observedPaths]
          .some((scope) => pathMatchesScope(contract.path, scope)))
        .map((contract) => contract.description),
    ]);
    return {
      slug,
      domain: boundedText(expert.domain, 256),
      purpose: boundedText(expert.rationale),
      ownedPaths,
      observedPaths,
      contracts: scopedContracts,
      patterns: sortedUniqueStrings([
        ...expert.patterns.map((pattern) => boundedText(`${pattern.name}: ${pattern.description}`)),
        ...expert.conventions,
      ]),
      pitfalls: sortedUniqueStrings(
        expert.pitfalls.map((pitfall) => boundedText(`${pitfall.risk} Consequence: ${pitfall.consequence}`)),
      ),
      validationCommands: commandsForDomain(expert.test_command, globalCommands),
      evidencePaths: observedPaths.filter(isLikelyFilePath),
      sourceKinds: ["expert_evidence"],
      stability: expert.stability,
      recurrence: expert.recurrence,
    };
  });
}

function topLevelRoot(value: string): string | null {
  const normalized = normalizePathCandidate(value);
  if (normalized === null) return null;
  const root = normalized.split("/")[0]?.trim() ?? "";
  return root.length > 0 ? root : null;
}

function rawFromCohesiveStructuralEvidence(
  map: CodebaseMap,
  knownPaths: ReadonlyArray<string>,
  contracts: ReadonlyArray<ContractReference>,
  globalCommands: ReadonlyArray<string>,
): RawSpecialist[] {
  if (map.module_graph.parallelizable_subtrees.some((group) => group.length > 1)) return [];
  const structuralPaths = normalizePaths([
    ...map.module_graph.edges.flatMap((edge) => [edge.from, edge.to]),
    ...map.type_contract_surface.pydantic_models.map((item) => item.path),
    ...map.type_contract_surface.typescript_interfaces.map((item) => item.path),
    ...map.type_contract_surface.db_models.map((item) => item.path),
    ...(map.type_contract_surface.api_contracts ?? []).map((item) => item.path),
    ...map.pitfalls.map((pitfall) => pitfall.module),
    ...map.conventions.patterns.map((pattern) => pattern.where),
  ]).filter(isLikelyFilePath);
  const roots = sortedUniqueStrings(
    structuralPaths
      .map(topLevelRoot)
      .filter((root): root is string => root !== null && !NON_APPLICATION_ROOTS.has(root)),
  );
  if (roots.length !== 1 || STRUCTURAL_CONTAINER_ROOTS.has(roots[0]!)) return [];

  const domain = boundedText(map.meta.project_type, 256);
  const slug = specialistDomainSlug(domain);
  if (GENERIC_DOMAIN_NAMES.has(slug) || slug === "unknown" || domain.length === 0) return [];

  const ownedPaths = [roots[0]!];
  const observedPaths = pathsForScopes(knownPaths, ownedPaths);
  const evidencePaths = observedPaths.filter(isLikelyFilePath);
  const scopedContracts = contracts
    .filter((contract) => ownedPaths.some((scope) => pathMatchesScope(contract.path, scope)))
    .map((contract) => contract.description);
  const scopedPitfalls = map.pitfalls
    .filter((pitfall) => ownedPaths.some((scope) => pathMatchesScope(pitfall.module, scope)))
    .map((pitfall) => boundedText(`${pitfall.what} Consequence: ${pitfall.consequence}`));
  const scopedPatterns = map.conventions.patterns
    .filter((pattern) => ownedPaths.some((scope) => pathMatchesScope(pattern.where, scope)))
    .map((pattern) => boundedText(`${pattern.name}: ${pattern.description}`));
  const independentSignals = [
    map.module_graph.edges.some((edge) =>
      ownedPaths.some((scope) => pathMatchesScope(edge.from, scope) || pathMatchesScope(edge.to, scope))
    ),
    scopedContracts.length > 0,
    scopedPitfalls.length > 0,
    scopedPatterns.length > 0,
  ].filter(Boolean).length;
  if (evidencePaths.length < 2 || independentSignals < 2 || globalCommands.length === 0) return [];

  return [{
    slug,
    domain,
    purpose: boundedText(
      map.meta.domain_hypothesis.trim().length > 0
        ? map.meta.domain_hypothesis
        : `Repository domain inferred from cohesive structural evidence under ${ownedPaths[0]}.`,
    ),
    ownedPaths,
    observedPaths,
    contracts: sortedUniqueStrings(scopedContracts),
    patterns: sortedUniqueStrings(scopedPatterns),
    pitfalls: sortedUniqueStrings(scopedPitfalls),
    validationCommands: [...globalCommands],
    evidencePaths,
    sourceKinds: ["structural_evidence"],
    stability: null,
    recurrence: null,
  }];
}

function sourceStrength(sourceKinds: ReadonlyArray<SpecialistSourceKind>): number {
  let score = 0;
  if (sourceKinds.includes("expert_evidence")) score += 6;
  if (sourceKinds.includes("structural_evidence")) score += 3;
  return score;
}

function scopeOverlap(left: RawSpecialist, right: RawSpecialist): number {
  const leftPaths = sortedUniqueStrings([...left.ownedPaths, ...left.observedPaths]);
  const rightPaths = sortedUniqueStrings([...right.ownedPaths, ...right.observedPaths]);
  if (leftPaths.length === 0 || rightPaths.length === 0) return 0;
  let matches = 0;
  for (const leftPath of leftPaths) {
    if (rightPaths.some((rightPath) => scopesOverlap(leftPath, rightPath))) matches += 1;
  }
  return matches / Math.min(leftPaths.length, rightPaths.length);
}

function mergeRaw(left: RawSpecialist, right: RawSpecialist): RawSpecialist {
  const leftStrength = sourceStrength(left.sourceKinds);
  const rightStrength = sourceStrength(right.sourceKinds);
  const preferred = rightStrength > leftStrength
    || (rightStrength === leftStrength && right.slug.localeCompare(left.slug) < 0)
    ? right
    : left;
  return {
    slug: preferred.slug,
    domain: preferred.domain,
    purpose: preferred.purpose,
    ownedPaths: sortedUniqueStrings([...left.ownedPaths, ...right.ownedPaths]),
    observedPaths: sortedUniqueStrings([...left.observedPaths, ...right.observedPaths]),
    contracts: sortedUniqueStrings([...left.contracts, ...right.contracts]),
    patterns: sortedUniqueStrings([...left.patterns, ...right.patterns]),
    pitfalls: sortedUniqueStrings([...left.pitfalls, ...right.pitfalls]),
    validationCommands: sortedUniqueStrings([
      ...left.validationCommands,
      ...right.validationCommands,
    ]),
    evidencePaths: sortedUniqueStrings([...left.evidencePaths, ...right.evidencePaths]),
    sourceKinds: sortedUniqueStrings([
      ...left.sourceKinds,
      ...right.sourceKinds,
    ]) as SpecialistSourceKind[],
    stability: preferred.stability ?? left.stability ?? right.stability,
    recurrence: preferred.recurrence ?? left.recurrence ?? right.recurrence,
  };
}

function mergeOverlappingCandidates(candidates: ReadonlyArray<RawSpecialist>): RawSpecialist[] {
  const ordered = [...candidates].sort((left, right) => {
    const byStrength = sourceStrength(right.sourceKinds) - sourceStrength(left.sourceKinds);
    if (byStrength !== 0) return byStrength;
    return left.slug.localeCompare(right.slug);
  });
  const merged: RawSpecialist[] = [];
  for (const candidate of ordered) {
    const index = merged.findIndex((existing) => {
      const overlap = scopeOverlap(existing, candidate);
      const sameSemanticDomain = existing.slug === candidate.slug;
      return overlap >= 0.8 || sameSemanticDomain;
    });
    if (index < 0) merged.push(candidate);
    else merged[index] = mergeRaw(merged[index]!, candidate);
  }
  return merged;
}

function stabilityWeight(value: RawSpecialist["stability"]): number {
  if (value === "high") return 2;
  if (value === "medium") return 1;
  if (value === "low") return -2;
  return 0;
}

function recurrenceWeight(value: RawSpecialist["recurrence"]): number {
  if (value === "high") return 2;
  if (value === "medium") return 1;
  if (value === "low") return -1;
  return 0;
}

function discoveryScore(candidate: RawSpecialist): number {
  return sourceStrength(candidate.sourceKinds)
    + Math.min(candidate.ownedPaths.length, 3)
    + Math.min(candidate.evidencePaths.length, 3)
    + Math.min(candidate.contracts.length, 2)
    + Math.min(candidate.patterns.length, 2)
    + Math.min(candidate.pitfalls.length, 2)
    + (candidate.validationCommands.length > 0 ? 2 : 0)
    + stabilityWeight(candidate.stability)
    + recurrenceWeight(candidate.recurrence)
    - (GENERIC_DOMAIN_NAMES.has(candidate.slug) ? 6 : 0);
}

function confidenceFor(candidate: RawSpecialist, score: number): MemoryConfidence {
  if (
    candidate.sourceKinds.includes("expert_evidence")
    && candidate.stability === "high"
    && candidate.recurrence === "high"
    && candidate.evidencePaths.length >= 2
    && candidate.validationCommands.length > 0
  ) {
    return "high";
  }
  if (score >= 12 && candidate.evidencePaths.length >= 2) return "high";
  if (score >= 8) return "medium";
  return "low";
}

function buildSpecialistDefinitions(
  candidates: ReadonlyArray<RawSpecialist>,
  map: CodebaseMap,
  supportingCommit: string,
): SpecialistDefinition[] {
  const selected: SpecialistDefinition[] = candidates
    .map((candidate) => ({ candidate, score: discoveryScore(candidate) }))
    .filter(({ candidate, score }) =>
      score >= 7
      && candidate.evidencePaths.length > 0
      && candidate.validationCommands.length > 0
      && (
        candidate.ownedPaths.length
        + candidate.contracts.length
        + candidate.patterns.length
        + candidate.pitfalls.length
      ) >= 2
    )
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore !== 0 ? byScore : left.candidate.slug.localeCompare(right.candidate.slug);
    })
    .slice(0, MAX_DISCOVERED_SPECIALISTS)
    .map(({ candidate, score }): SpecialistDefinition => ({
      specialist_id: `specialist-${candidate.slug}`,
      display_name: boundedText(`${titleCase(candidate.domain)} Specialist`, 256),
      domain: boundedText(candidate.domain, 256),
      purpose: boundedText(candidate.purpose),
      owned_paths: candidate.ownedPaths.slice(0, 256),
      observed_paths: sortedUniqueStrings([
        ...candidate.observedPaths,
        ...candidate.evidencePaths,
      ]).slice(0, 512),
      contracts: candidate.contracts.slice(0, 128),
      patterns: candidate.patterns.slice(0, 128),
      pitfalls: candidate.pitfalls.slice(0, 128),
      related_specialists: [],
      validation_commands: candidate.validationCommands.slice(0, 64),
      evidence_paths: candidate.evidencePaths.slice(0, 128),
      freshness_dependencies: sortedUniqueStrings([
        ...candidate.ownedPaths,
        ...candidate.observedPaths,
        ...candidate.evidencePaths,
      ]).slice(0, 512),
      supporting_commit: supportingCommit,
      freshness: "current",
      confidence: confidenceFor(candidate, score),
      source_kinds: candidate.sourceKinds,
      discovery_score: score,
      execution_policy: { ...SPECIALIST_READ_ONLY_EXECUTION_POLICY },
    }));

  const byId = new Map(selected.map((specialist) => [specialist.specialist_id, specialist]));
  for (const edge of map.module_graph.edges) {
    const fromOwners = selected.filter((specialist) =>
      [...specialist.owned_paths, ...specialist.observed_paths]
        .some((scope) => pathMatchesScope(edge.from, scope))
    );
    const toOwners = selected.filter((specialist) =>
      [...specialist.owned_paths, ...specialist.observed_paths]
        .some((scope) => pathMatchesScope(edge.to, scope))
    );
    for (const left of fromOwners) {
      for (const right of toOwners) {
        if (left.specialist_id === right.specialist_id) continue;
        const leftValue = byId.get(left.specialist_id)!;
        const rightValue = byId.get(right.specialist_id)!;
        leftValue.related_specialists = sortedUniqueStrings([
          ...leftValue.related_specialists,
          rightValue.specialist_id,
        ]);
        rightValue.related_specialists = sortedUniqueStrings([
          ...rightValue.related_specialists,
          leftValue.specialist_id,
        ]);
      }
    }
  }

  return selected.sort((left, right) => left.specialist_id.localeCompare(right.specialist_id));
}

function procedureOwner(
  paths: ReadonlyArray<string>,
  specialists: ReadonlyArray<SpecialistDefinition>,
): string | null {
  const ranked = specialists
    .map((specialist) => ({
      specialist,
      score: paths.filter((candidate) =>
        [...specialist.owned_paths, ...specialist.observed_paths]
          .some((scope) => pathMatchesScope(candidate, scope))
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
    const evidencePaths = sourcePath && isLikelyFilePath(sourcePath)
      && (!trackedEvidenceFiles || trackedEvidenceFiles.has(sourcePath)) ? [sourcePath] : [];
    const validationCommands = sortedUniqueStrings([
      ...(VALIDATION_SIGNAL.test(candidate.existing_command)
        ? [candidate.existing_command]
        : []),
      ...globalCommands,
    ]).slice(0, 16);
    if (evidencePaths.length === 0 || validationCommands.length === 0) continue;
    const procedureId = specialistSlug(candidate.name);
    definitions.push({
      procedure_id: procedureId,
      name: candidate.name,
      purpose: boundedText(candidate.purpose),
      owner_specialist_id: procedureOwner(evidencePaths, specialists),
      trigger_conditions: sortedUniqueStrings([boundedText(candidate.purpose), boundedText(candidate.name, 256)]).slice(0, 64),
      required_context_paths: evidencePaths,
      allowed_commands: [candidate.existing_command.trim()],
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
      procedure_id: `validate-${specialistSlug(specialist.domain)}`,
      name: `Validate ${specialist.domain}`,
      purpose: `Run the authoritative validation surface for ${specialist.domain} changes.`,
      owner_specialist_id: specialist.specialist_id,
      trigger_conditions: [
        `${specialist.domain} change`,
        ...specialist.owned_paths,
        ...specialist.contracts,
      ],
      required_context_paths: specialist.observed_paths,
      allowed_commands: specialist.validation_commands,
      expected_file_patterns: specialist.owned_paths,
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
  ]).filter((candidate) => (
    isLikelyFilePath(candidate)
    && (!trackedEvidenceFiles || trackedEvidenceFiles.has(candidate))
  ));
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

export function discoverSpecialistPortfolio(
  map: CodebaseMap,
  supportingCommit: string,
  trackedRepositoryFiles?: ReadonlyArray<string>,
): SpecialistPortfolio {
  const trackedEvidenceFiles = trackedRepositoryFiles
    ? new Set(normalizePaths(trackedRepositoryFiles))
    : undefined;
  const knownPaths = allKnownPaths(map).filter((candidate) => (
    !trackedEvidenceFiles || trackedEvidenceFiles.has(candidate)
  ));
  const contracts = contractReferences(map);
  const validationCommands = allValidationCommands(map);
  const rawCandidates = mergeOverlappingCandidates(
    rawFromExpertEvidence(map, knownPaths, contracts, validationCommands),
  );
  let candidates = rawCandidates;
  let specialists = buildSpecialistDefinitions(candidates, map, supportingCommit);
  if (specialists.length === 0) {
    candidates = mergeOverlappingCandidates([
      ...rawCandidates,
      ...rawFromCohesiveStructuralEvidence(map, knownPaths, contracts, validationCommands),
    ]);
    specialists = buildSpecialistDefinitions(candidates, map, supportingCommit);
  }
  const procedures = buildProcedureDefinitions(
    map,
    specialists,
    validationCommands,
    supportingCommit,
    trackedEvidenceFiles,
  );
  const warnings: string[] = [];
  if (specialists.length === 0) {
    warnings.push("No repository domain met the specialist evidence and validation threshold.");
  }
  if (candidates.length > MAX_DISCOVERED_SPECIALISTS) {
    warnings.push(
      `Specialist discovery considered ${candidates.length} domain candidates and retained the strongest ${MAX_DISCOVERED_SPECIALISTS}.`,
    );
  }
  if (procedures.length === 0) {
    warnings.push("No repository-specific procedure had both concrete evidence and validation commands.");
  }
  const evidencePaths = sortedUniqueStrings(
    knownPaths.filter(isLikelyFilePath),
  ).slice(0, 128);
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
