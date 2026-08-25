import { TeamMemoryError } from "../memory/contracts.ts";
import {
  normalizeMemoryRepositoryPath,
  validateMemoryId,
} from "../memory/paths.ts";
import {
  assertNoPersistedSecrets,
  canonicalJson,
  digestCanonical,
  sortedUniqueStrings,
} from "../memory/serialization.ts";
import {
  MAX_DISCOVERED_PROCEDURES,
  MAX_DISCOVERED_SPECIALISTS,
  SPECIALIST_PORTFOLIO_SCHEMA_VERSION,
  SPECIALIST_READ_ONLY_EXECUTION_POLICY,
  type ProcedureDefinition,
  type SpecialistDefinition,
  type SpecialistPortfolio,
} from "./contracts.ts";

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_TEXT = 4_000;

function fail(message: string): never {
  throw new TeamMemoryError("invalid_input", message);
}

function assertNonEmpty(value: string, label: string, maximum = MAX_TEXT): void {
  if (value.trim().length === 0 || value !== value.trim()) {
    fail(`${label} must be non-empty normalized text`);
  }
  if (value.length > maximum) fail(`${label} exceeds ${maximum} characters`);
}

function assertCommit(value: string, label: string): void {
  if (!COMMIT_PATTERN.test(value)) fail(`${label} must be a full Git commit SHA`);
}

function assertNormalizedStrings(
  values: ReadonlyArray<string>,
  label: string,
  options: { paths?: boolean; allowEmpty?: boolean; maximumItems?: number } = {},
): void {
  if (!options.allowEmpty && values.length === 0) fail(`${label} cannot be empty`);
  if (values.length > (options.maximumItems ?? 512)) {
    fail(`${label} exceeds its bounded item count`);
  }
  const normalized = values.map((value) => {
    assertNonEmpty(value, label);
    return options.paths
      ? normalizeMemoryRepositoryPath(value, label)
      : value.trim();
  });
  const sorted = sortedUniqueStrings(normalized);
  if (canonicalJson(sorted) !== canonicalJson(values)) {
    fail(`${label} must be sorted, unique, and normalized`);
  }
}

function assertExecutionPolicy(definition: SpecialistDefinition): void {
  if (canonicalJson(definition.execution_policy) !== canonicalJson(SPECIALIST_READ_ONLY_EXECUTION_POLICY)) {
    fail(`specialist ${definition.specialist_id} does not use the immutable read-only execution policy`);
  }
}

function assertSpecialist(
  definition: SpecialistDefinition,
  portfolioCommit: string,
): void {
  validateMemoryId(definition.specialist_id, "specialist ID");
  if (!definition.specialist_id.startsWith("specialist-")) {
    fail(`specialist ID must start with specialist-: ${definition.specialist_id}`);
  }
  assertNonEmpty(definition.display_name, `specialist ${definition.specialist_id} display name`, 256);
  assertNonEmpty(definition.concern, `specialist ${definition.specialist_id} concern`, 256);
  assertNonEmpty(definition.one_line, `specialist ${definition.specialist_id} one-line scope`, 512);
  assertNonEmpty(definition.covers, `specialist ${definition.specialist_id} covers statement`);
  assertNonEmpty(definition.excludes, `specialist ${definition.specialist_id} excludes statement`);
  assertCommit(definition.supporting_commit, `specialist ${definition.specialist_id} supporting commit`);
  if (definition.supporting_commit !== portfolioCommit) {
    fail(`specialist ${definition.specialist_id} supporting commit differs from its portfolio`);
  }
  if (definition.freshness !== "current") {
    fail(`newly discovered specialist ${definition.specialist_id} must be current`);
  }
  if (definition.touchpoints.length === 0) {
    fail(`specialist ${definition.specialist_id} has no verified touchpoint`);
  }
  if (definition.touchpoints.length > 512) {
    fail(`specialist ${definition.specialist_id} exceeds the touchpoint bound`);
  }
  const touchpointKeys = new Set<string>();
  for (const touchpoint of definition.touchpoints) {
    assertNormalizedStrings([touchpoint.path], `specialist ${definition.specialist_id} touchpoint path`, {
      paths: true,
      maximumItems: 1,
    });
    assertNonEmpty(touchpoint.role, `specialist ${definition.specialist_id} touchpoint role`, 1_024);
    if (touchpoint.line_range !== null) {
      const [start, end] = touchpoint.line_range;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        fail(`specialist ${definition.specialist_id} has an invalid touchpoint line range for ${touchpoint.path}`);
      }
    }
    const key = `${touchpoint.path} ${touchpoint.symbol ?? ""}`;
    if (touchpointKeys.has(key)) {
      fail(`specialist ${definition.specialist_id} repeats touchpoint ${key.trim()}`);
    }
    touchpointKeys.add(key);
  }
  // A flow with fewer than two steps is not a trace. Discovery drops those, so
  // one reaching validation means a caller built a definition by hand.
  for (const flow of definition.flows) {
    assertNonEmpty(flow.name, `specialist ${definition.specialist_id} flow name`, 256);
    if (flow.steps.length < 2) {
      fail(`specialist ${definition.specialist_id} flow "${flow.name}" is not an end-to-end trace`);
    }
    for (const step of flow.steps) {
      assertNormalizedStrings([step.path], `specialist ${definition.specialist_id} flow step path`, {
        paths: true,
        maximumItems: 1,
      });
      assertNonEmpty(step.what_happens, `specialist ${definition.specialist_id} flow step`, 1_024);
    }
  }
  for (const invariant of definition.invariants) {
    assertNonEmpty(invariant.rule, `specialist ${definition.specialist_id} invariant rule`, 1_024);
    assertNonEmpty(invariant.why, `specialist ${definition.specialist_id} invariant rationale`, 1_024);
  }
  for (const pitfall of definition.pitfalls) {
    assertNonEmpty(pitfall.risk, `specialist ${definition.specialist_id} pitfall risk`, 1_024);
    assertNonEmpty(pitfall.consequence, `specialist ${definition.specialist_id} pitfall consequence`, 1_024);
  }
  assertNormalizedStrings(definition.entry_questions, `specialist ${definition.specialist_id} entry questions`, {
    allowEmpty: true,
    maximumItems: 32,
  });
  assertNormalizedStrings(definition.context_paths, `specialist ${definition.specialist_id} context paths`, {
    paths: true,
    maximumItems: 512,
  });
  assertNormalizedStrings(definition.spans_subtrees, `specialist ${definition.specialist_id} spanned subtrees`, {
    paths: true,
    allowEmpty: true,
    maximumItems: 128,
  });
  assertNormalizedStrings(
    definition.related_specialists,
    `specialist ${definition.specialist_id} related specialists`,
    { allowEmpty: true, maximumItems: 32 },
  );
  assertNormalizedStrings(
    definition.validation_commands,
    `specialist ${definition.specialist_id} validation commands`,
    { maximumItems: 64 },
  );
  assertNormalizedStrings(definition.evidence_paths, `specialist ${definition.specialist_id} evidence paths`, {
    paths: true,
    maximumItems: 256,
  });
  assertNormalizedStrings(
    definition.freshness_dependencies,
    `specialist ${definition.specialist_id} freshness dependencies`,
    { paths: true, maximumItems: 512 },
  );
  assertNormalizedStrings(
    definition.source_kinds,
    `specialist ${definition.specialist_id} source kinds`,
    { maximumItems: 3 },
  );
  assertExecutionPolicy(definition);
}

function assertProcedure(
  definition: ProcedureDefinition,
  portfolioCommit: string,
): void {
  validateMemoryId(definition.procedure_id, "procedure ID");
  assertNonEmpty(definition.name, `procedure ${definition.procedure_id} name`, 256);
  assertNonEmpty(definition.purpose, `procedure ${definition.procedure_id} purpose`);
  assertCommit(definition.supporting_commit, `procedure ${definition.procedure_id} supporting commit`);
  if (definition.supporting_commit !== portfolioCommit) {
    fail(`procedure ${definition.procedure_id} supporting commit differs from its portfolio`);
  }
  if (definition.freshness !== "current") {
    fail(`newly discovered procedure ${definition.procedure_id} must be current`);
  }
  if (definition.owner_specialist_id !== null) {
    validateMemoryId(definition.owner_specialist_id, `procedure ${definition.procedure_id} owner`);
  }
  assertNormalizedStrings(
    definition.trigger_conditions,
    `procedure ${definition.procedure_id} trigger conditions`,
    { maximumItems: 64 },
  );
  assertNormalizedStrings(
    definition.required_context_paths,
    `procedure ${definition.procedure_id} context paths`,
    { paths: true, allowEmpty: true, maximumItems: 256 },
  );
  assertNormalizedStrings(
    definition.allowed_commands,
    `procedure ${definition.procedure_id} allowed commands`,
    { allowEmpty: true, maximumItems: 64 },
  );
  assertNormalizedStrings(
    definition.expected_file_patterns,
    `procedure ${definition.procedure_id} file patterns`,
    { paths: true, allowEmpty: true, maximumItems: 128 },
  );
  assertNormalizedStrings(
    definition.side_effects,
    `procedure ${definition.procedure_id} side effects`,
    { allowEmpty: true, maximumItems: 64 },
  );
  assertNormalizedStrings(
    definition.validation_commands,
    `procedure ${definition.procedure_id} validation commands`,
    { maximumItems: 64 },
  );
  if (definition.recovery_steps.length === 0 || definition.recovery_steps.length > 64) {
    fail(`procedure ${definition.procedure_id} recovery steps are outside the bounded contract`);
  }
  for (const step of definition.recovery_steps) {
    assertNonEmpty(step, `procedure ${definition.procedure_id} recovery step`);
  }
  assertNormalizedStrings(
    definition.evidence_paths,
    `procedure ${definition.procedure_id} evidence paths`,
    { paths: true, maximumItems: 128 },
  );
  assertNormalizedStrings(
    definition.freshness_dependencies,
    `procedure ${definition.procedure_id} freshness dependencies`,
    { paths: true, maximumItems: 512 },
  );
}

export function specialistPortfolioDigest(value: Pick<
  SpecialistPortfolio,
  "evidence_paths" | "specialists" | "procedures"
>): string {
  return digestCanonical({
    evidence_paths: value.evidence_paths,
    specialists: value.specialists,
    procedures: value.procedures,
  });
}

export function validateSpecialistPortfolio(
  portfolio: SpecialistPortfolio,
): SpecialistPortfolio {
  if (portfolio.schema_version !== SPECIALIST_PORTFOLIO_SCHEMA_VERSION) {
    fail(`unsupported specialist portfolio schema ${portfolio.schema_version}`);
  }
  assertCommit(portfolio.supporting_commit, "specialist portfolio supporting commit");
  if (portfolio.specialists.length > MAX_DISCOVERED_SPECIALISTS) {
    fail(`specialist portfolio exceeds ${MAX_DISCOVERED_SPECIALISTS} specialists`);
  }
  if (portfolio.procedures.length > MAX_DISCOVERED_PROCEDURES) {
    fail(`specialist portfolio exceeds ${MAX_DISCOVERED_PROCEDURES} procedures`);
  }
  // A portfolio with no specialists has no evidence to cite, and saying so is
  // more useful than failing validation: the warnings carry the reason each
  // concern was rejected, and that report is what a caller needs to act on.
  assertNormalizedStrings(portfolio.evidence_paths, "specialist portfolio evidence paths", {
    paths: true,
    allowEmpty: portfolio.specialists.length === 0,
    maximumItems: 256,
  });
  assertNormalizedStrings(portfolio.warnings, "specialist portfolio warnings", {
    allowEmpty: true,
    maximumItems: 64,
  });

  const specialistIds = new Set<string>();
  for (const specialist of portfolio.specialists) {
    assertSpecialist(specialist, portfolio.supporting_commit);
    if (specialistIds.has(specialist.specialist_id)) {
      fail(`duplicate specialist ID ${specialist.specialist_id}`);
    }
    specialistIds.add(specialist.specialist_id);
  }
  const sortedSpecialists = [...portfolio.specialists]
    .sort((left, right) => left.specialist_id.localeCompare(right.specialist_id));
  if (canonicalJson(sortedSpecialists) !== canonicalJson(portfolio.specialists)) {
    fail("specialist definitions must be sorted by stable ID");
  }
  for (const specialist of portfolio.specialists) {
    for (const relatedId of specialist.related_specialists) {
      if (!specialistIds.has(relatedId) || relatedId === specialist.specialist_id) {
        fail(`specialist ${specialist.specialist_id} has an invalid related specialist ${relatedId}`);
      }
    }
  }

  const procedureIds = new Set<string>();
  for (const procedure of portfolio.procedures) {
    assertProcedure(procedure, portfolio.supporting_commit);
    if (procedureIds.has(procedure.procedure_id)) {
      fail(`duplicate procedure ID ${procedure.procedure_id}`);
    }
    procedureIds.add(procedure.procedure_id);
    if (
      procedure.owner_specialist_id !== null
      && !specialistIds.has(procedure.owner_specialist_id)
    ) {
      fail(`procedure ${procedure.procedure_id} names unknown owner ${procedure.owner_specialist_id}`);
    }
  }
  const sortedProcedures = [...portfolio.procedures]
    .sort((left, right) => left.procedure_id.localeCompare(right.procedure_id));
  if (canonicalJson(sortedProcedures) !== canonicalJson(portfolio.procedures)) {
    fail("procedure definitions must be sorted by stable ID");
  }

  if (specialistPortfolioDigest(portfolio) !== portfolio.source_map_digest) {
    fail("specialist portfolio digest does not match its deterministic contents");
  }
  assertNoPersistedSecrets(portfolio);
  return portfolio;
}
