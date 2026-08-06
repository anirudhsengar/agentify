import {
  digestCanonical,
  sortedUniqueStrings,
} from "../memory/serialization.ts";
import {
  MAX_ROUTED_PROCEDURES,
  MAX_ROUTED_SPECIALISTS,
  type ExpertiseInvalidationReport,
  type ProcedureDefinition,
  type ProcedureRoutingSelection,
  type RoutingReason,
  type SpecialistDefinition,
  type SpecialistPortfolio,
  type SpecialistRoutingReport,
  type SpecialistRoutingRequest,
  type SpecialistRoutingSelection,
} from "./contracts.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import { TeamMemoryError } from "../memory/contracts.ts";
import { pathMatchesScope } from "./discovery.ts";
import { validateSpecialistPortfolio } from "./validation.ts";

const TOKEN_SPLIT = /[^a-z0-9]+/g;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "into", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
  "add", "change", "create", "fix", "implement", "make", "support", "update",
]);

function tokens(value: string): string[] {
  return sortedUniqueStrings(
    value
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function normalizedPaths(values: ReadonlyArray<string> | undefined): string[] {
  return sortedUniqueStrings((values ?? []).map((value) =>
    normalizeMemoryRepositoryPath(value, "specialist routing path")
  ));
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TeamMemoryError("invalid_input", "specialist routing limits must be non-negative integers");
  }
  return Math.min(resolved, maximum);
}

function normalizeRequest(request: SpecialistRoutingRequest): Required<SpecialistRoutingRequest> {
  const taskDescription = request.task_description.trim();
  if (taskDescription.length === 0) {
    throw new TeamMemoryError("invalid_input", "specialist routing requires a task description");
  }
  return {
    task_description: taskDescription,
    candidate_paths: normalizedPaths(request.candidate_paths),
    changed_files: normalizedPaths(request.changed_files),
    contracts: sortedUniqueStrings(request.contracts ?? []),
    risk_category: request.risk_category ?? "low",
    prior_successful_specialist_ids: sortedUniqueStrings(
      request.prior_successful_specialist_ids ?? [],
    ),
    max_specialists: boundedLimit(
      request.max_specialists,
      MAX_ROUTED_SPECIALISTS,
      MAX_ROUTED_SPECIALISTS,
    ),
    max_procedures: boundedLimit(
      request.max_procedures,
      MAX_ROUTED_PROCEDURES,
      MAX_ROUTED_PROCEDURES,
    ),
  };
}

function addReason(reasons: RoutingReason[], reason: RoutingReason): void {
  const existing = reasons.find((candidate) =>
    candidate.kind === reason.kind && candidate.signal === reason.signal
  );
  if (!existing) reasons.push(reason);
  else existing.weight = Math.max(existing.weight, reason.weight);
}

function textSignals(specialist: SpecialistDefinition): string[] {
  return tokens([
    specialist.domain,
    specialist.purpose,
    ...specialist.contracts,
    ...specialist.patterns,
    ...specialist.pitfalls,
  ].join(" "));
}

function contractMatches(
  requested: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): string[] {
  const matches: string[] = [];
  for (const request of requested) {
    const requestTokens = tokens(request);
    if (requestTokens.length === 0) continue;
    for (const candidate of available) {
      const candidateTokens = new Set(tokens(candidate));
      if (requestTokens.every((token) => candidateTokens.has(token))) {
        matches.push(request);
        break;
      }
    }
  }
  return sortedUniqueStrings(matches);
}

function riskSignals(
  specialist: SpecialistDefinition,
  risk: Required<SpecialistRoutingRequest>["risk_category"],
): string[] {
  if (risk === "low") return [];
  const specialistTokens = new Set(textSignals(specialist));
  const vocabulary = risk === "critical" || risk === "high"
    ? [
        "auth", "authorization", "credential", "database", "deploy", "migration",
        "payment", "permission", "production", "release", "secret", "security",
      ]
    : ["database", "migration", "permission", "release", "security"];
  return vocabulary.filter((token) => specialistTokens.has(token));
}

function scoreSpecialist(
  specialist: SpecialistDefinition,
  request: Required<SpecialistRoutingRequest>,
): SpecialistRoutingSelection | null {
  const reasons: RoutingReason[] = [];
  const paths = sortedUniqueStrings([...request.candidate_paths, ...request.changed_files]);
  for (const candidatePath of paths) {
    if (specialist.owned_paths.some((scope) => pathMatchesScope(candidatePath, scope))) {
      addReason(reasons, { kind: "owned_path", signal: candidatePath, weight: 12 });
      continue;
    }
    if (specialist.observed_paths.some((scope) => pathMatchesScope(candidatePath, scope))) {
      addReason(reasons, { kind: "observed_path", signal: candidatePath, weight: 7 });
    }
  }

  for (const contract of contractMatches(request.contracts, specialist.contracts)) {
    addReason(reasons, { kind: "contract", signal: contract, weight: 9 });
  }

  const taskTokens = new Set(tokens(request.task_description));
  for (const signal of textSignals(specialist)) {
    if (taskTokens.has(signal)) {
      addReason(reasons, { kind: "task_signal", signal, weight: 2 });
    }
  }

  for (const signal of riskSignals(specialist, request.risk_category)) {
    addReason(reasons, {
      kind: "risk_signal",
      signal: `${request.risk_category}:${signal}`,
      weight: request.risk_category === "critical" ? 6 : 4,
    });
  }

  if (request.prior_successful_specialist_ids.includes(specialist.specialist_id)) {
    addReason(reasons, {
      kind: "prior_success",
      signal: specialist.specialist_id,
      weight: 2,
    });
  }

  const score = reasons.reduce((total, reason) => total + reason.weight, 0);
  if (score < 4) return null;
  return {
    specialist_id: specialist.specialist_id,
    score,
    reasons: reasons.sort((left, right) => {
      const byWeight = right.weight - left.weight;
      if (byWeight !== 0) return byWeight;
      const byKind = left.kind.localeCompare(right.kind);
      return byKind !== 0 ? byKind : left.signal.localeCompare(right.signal);
    }),
  };
}

function procedureTextSignals(procedure: ProcedureDefinition): string[] {
  return tokens([
    procedure.name,
    procedure.purpose,
    ...procedure.trigger_conditions,
    ...procedure.side_effects,
  ].join(" "));
}

function scoreProcedure(
  procedure: ProcedureDefinition,
  request: Required<SpecialistRoutingRequest>,
  selectedSpecialistIds: ReadonlySet<string>,
): ProcedureRoutingSelection | null {
  const reasons: RoutingReason[] = [];
  const paths = sortedUniqueStrings([...request.candidate_paths, ...request.changed_files]);
  for (const candidatePath of paths) {
    if (procedure.required_context_paths.some((scope) => pathMatchesScope(candidatePath, scope))) {
      addReason(reasons, {
        kind: "procedure_context",
        signal: candidatePath,
        weight: 8,
      });
    }
  }

  const taskTokens = new Set(tokens(request.task_description));
  for (const signal of procedureTextSignals(procedure)) {
    if (taskTokens.has(signal)) {
      addReason(reasons, { kind: "procedure_trigger", signal, weight: 3 });
    }
  }

  if (
    procedure.owner_specialist_id !== null
    && selectedSpecialistIds.has(procedure.owner_specialist_id)
  ) {
    addReason(reasons, {
      kind: "procedure_trigger",
      signal: `selected-owner:${procedure.owner_specialist_id}`,
      weight: 4,
    });
  }

  if (
    request.risk_category !== "low"
    && procedure.validation_commands.length > 0
    && procedure.procedure_id.startsWith("validate-")
  ) {
    addReason(reasons, {
      kind: "risk_signal",
      signal: `${request.risk_category}:validation`,
      weight: request.risk_category === "critical" ? 5 : 3,
    });
  }

  const score = reasons.reduce((total, reason) => total + reason.weight, 0);
  if (score <= 0) return null;
  return {
    procedure_id: procedure.procedure_id,
    score,
    reasons: reasons.sort((left, right) => {
      const byWeight = right.weight - left.weight;
      if (byWeight !== 0) return byWeight;
      const byKind = left.kind.localeCompare(right.kind);
      return byKind !== 0 ? byKind : left.signal.localeCompare(right.signal);
    }),
  };
}

function unmatchedSignals(
  portfolio: SpecialistPortfolio,
  request: Required<SpecialistRoutingRequest>,
  specialists: ReadonlyArray<SpecialistRoutingSelection>,
  procedures: ReadonlyArray<ProcedureRoutingSelection>,
): string[] {
  const matchedPaths = new Set<string>();
  const matchedContracts = new Set<string>();
  const matchedTokens = new Set<string>();
  for (const selection of [...specialists, ...procedures]) {
    for (const reason of selection.reasons) {
      if (reason.kind === "owned_path" || reason.kind === "observed_path" || reason.kind === "procedure_context") {
        matchedPaths.add(reason.signal);
      } else if (reason.kind === "contract") {
        matchedContracts.add(reason.signal);
      } else if (reason.kind === "task_signal" || reason.kind === "procedure_trigger") {
        matchedTokens.add(reason.signal);
      }
    }
  }
  const signals: string[] = [];
  for (const candidatePath of [...request.candidate_paths, ...request.changed_files]) {
    if (!matchedPaths.has(candidatePath)) signals.push(`path:${candidatePath}`);
  }
  for (const contract of request.contracts) {
    if (!matchedContracts.has(contract)) signals.push(`contract:${contract}`);
  }
  void portfolio;
  for (const token of tokens(request.task_description)) {
    if (!matchedTokens.has(token)) signals.push(`task:${token}`);
  }
  return sortedUniqueStrings(signals);
}

export function routeSpecialistPortfolio(
  portfolio: SpecialistPortfolio,
  requestInput: SpecialistRoutingRequest,
): SpecialistRoutingReport {
  validateSpecialistPortfolio(portfolio);
  const request = normalizeRequest(requestInput);
  const selectedSpecialists = portfolio.specialists
    .map((specialist) => scoreSpecialist(specialist, request))
    .filter((selection): selection is SpecialistRoutingSelection => selection !== null)
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore !== 0
        ? byScore
        : left.specialist_id.localeCompare(right.specialist_id);
    })
    .slice(0, request.max_specialists);
  const selectedSpecialistIds = new Set(
    selectedSpecialists.map((selection) => selection.specialist_id),
  );
  const selectedProcedures = portfolio.procedures
    .map((procedure) => scoreProcedure(procedure, request, selectedSpecialistIds))
    .filter((selection): selection is ProcedureRoutingSelection => selection !== null)
    .sort((left, right) => {
      const byScore = right.score - left.score;
      return byScore !== 0
        ? byScore
        : left.procedure_id.localeCompare(right.procedure_id);
    })
    .slice(0, request.max_procedures);
  return {
    task_digest: digestCanonical(request),
    selected_specialists: selectedSpecialists,
    selected_procedures: selectedProcedures,
    unmatched_signals: unmatchedSignals(
      portfolio,
      request,
      selectedSpecialists,
      selectedProcedures,
    ),
  };
}

function dependentPathMatches(
  changedPath: string,
  dependencies: ReadonlyArray<string>,
): boolean {
  return dependencies.some((dependency) => pathMatchesScope(changedPath, dependency));
}

export function assessExpertiseInvalidation(
  portfolio: SpecialistPortfolio,
  changedFiles: ReadonlyArray<string>,
): ExpertiseInvalidationReport {
  validateSpecialistPortfolio(portfolio);
  const normalized = normalizedPaths(changedFiles);
  const reasons: Record<string, string[]> = {};
  const specialistIds: string[] = [];
  const procedureIds: string[] = [];

  for (const specialist of portfolio.specialists) {
    const matched = normalized.filter((file) =>
      dependentPathMatches(file, specialist.freshness_dependencies)
    );
    if (matched.length > 0) {
      specialistIds.push(specialist.specialist_id);
      reasons[specialist.specialist_id] = matched.map((file) =>
        `${file} intersects specialist freshness dependencies`
      );
    }
  }

  for (const procedure of portfolio.procedures) {
    const matched = normalized.filter((file) =>
      dependentPathMatches(file, procedure.freshness_dependencies)
    );
    if (matched.length > 0) {
      procedureIds.push(procedure.procedure_id);
      reasons[procedure.procedure_id] = matched.map((file) =>
        `${file} intersects procedure freshness dependencies`
      );
    }
  }

  return {
    specialist_ids: specialistIds.sort((left, right) => left.localeCompare(right)),
    procedure_ids: procedureIds.sort((left, right) => left.localeCompare(right)),
    reasons: Object.fromEntries(
      Object.entries(reasons)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, sortedUniqueStrings(value)]),
    ),
  };
}
