import type { CodebaseMap } from "../audit/schema.ts";
import { sortedUniqueStrings } from "../memory/serialization.ts";
import type {
  ProcedureDefinition,
  SpecialistDefinition,
  SpecialistPortfolio,
} from "./contracts.ts";
import {
  discoverSpecialistPortfolio as discoverSpecialistPortfolioBase,
} from "./discovery-base.ts";
import {
  specialistPortfolioDigest,
  validateSpecialistPortfolio,
} from "./validation.ts";

export {
  pathMatchesScope,
  specialistSlug,
} from "./discovery-base.ts";

const COMMAND_TOKEN = /^(?:[A-Za-z0-9_./@:+-]+)(?:\s|$)/;
const PROSE_LEAD = /^(?:add|change|consider|create|document|ensure|include|preserve|review|update|write)\b/i;
const PROSE_PHRASE_LEAD = /^(?:check|verify|run|rerun)\s+(?:a|an|all|any|that|the|this)\b/i;
const NATURAL_LANGUAGE_TAIL = /\s(?:if|when|unless)\s+(?:dependencies?|documentation|docs?|files?|needed|necessary|public|source|types?|typing)\b|\sfor\s+(?:affected|changed|modified|public|typed)\b|\sas\s+needed\b/i;
const MAX_COMMAND_LENGTH = 2_048;

function outsideQuotedText(value: string): string {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let result = "";
  for (const character of value) {
    if (escaped) {
      result += quote === null ? character : " ";
      escaped = false;
      continue;
    }
    if (character === "\\") {
      result += quote === null ? character : " ";
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      result += " ";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += " ";
      continue;
    }
    result += character;
  }
  return result;
}

/** Reject model-authored prose while remaining agnostic to language and toolchain. */
export function normalizeExecutableCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (
    command.length === 0
    || command.length > MAX_COMMAND_LENGTH
    || command.includes("\0")
    || /[\r\n]/.test(command)
    || /^[-*]\s+/.test(command)
    || /^\d+[.)]\s+/.test(command)
    || PROSE_LEAD.test(command)
    || PROSE_PHRASE_LEAD.test(command)
    || !COMMAND_TOKEN.test(command)
  ) {
    return null;
  }
  if (NATURAL_LANGUAGE_TAIL.test(outsideQuotedText(command))) return null;
  return command;
}

function sanitizeCommands(
  values: ReadonlyArray<string>,
  discarded: Set<string>,
): string[] {
  const commands: string[] = [];
  for (const value of values) {
    const normalized = normalizeExecutableCommand(value);
    if (normalized === null) {
      if (value.trim()) discarded.add(value.trim());
      continue;
    }
    commands.push(normalized);
  }
  return sortedUniqueStrings(commands);
}

function sanitizeSpecialist(
  specialist: SpecialistDefinition,
  discarded: Set<string>,
): SpecialistDefinition {
  return {
    ...specialist,
    validation_commands: sanitizeCommands(specialist.validation_commands, discarded).slice(0, 32),
  };
}

function sanitizeProcedure(
  procedure: ProcedureDefinition,
  discarded: Set<string>,
): ProcedureDefinition | null {
  const allowedCommands = sanitizeCommands(procedure.allowed_commands, discarded).slice(0, 64);
  const validationCommands = sanitizeCommands(procedure.validation_commands, discarded).slice(0, 64);
  if (allowedCommands.length === 0 || validationCommands.length === 0) return null;
  return {
    ...procedure,
    allowed_commands: allowedCommands,
    validation_commands: validationCommands,
  };
}

export function discoverSpecialistPortfolio(
  map: CodebaseMap,
  supportingCommit: string,
  trackedRepositoryFiles?: ReadonlyArray<string>,
): SpecialistPortfolio {
  const base = discoverSpecialistPortfolioBase(
    map,
    supportingCommit,
    trackedRepositoryFiles,
  );
  const discarded = new Set<string>();
  const specialists = base.specialists.map((specialist) =>
    sanitizeSpecialist(specialist, discarded)
  );
  const procedures = base.procedures
    .map((procedure) => sanitizeProcedure(procedure, discarded))
    .filter((procedure): procedure is ProcedureDefinition => procedure !== null);
  const warnings = [...base.warnings];
  if (discarded.size > 0) {
    const values = [...discarded].sort((left, right) => left.localeCompare(right));
    warnings.push(
      `Ignored ${values.length} non-executable validation instruction(s): ${values.slice(0, 8).map((value) => JSON.stringify(value)).join(", ")}${values.length > 8 ? ", …" : ""}.`,
    );
  }
  const evidencePaths = sortedUniqueStrings([
    ...specialists.flatMap((specialist) => specialist.evidence_paths),
    ...procedures.flatMap((procedure) => procedure.evidence_paths),
  ]).slice(0, 256);
  const portfolio: SpecialistPortfolio = {
    ...base,
    evidence_paths: evidencePaths,
    specialists,
    procedures,
    warnings: sortedUniqueStrings(warnings),
    source_map_digest: specialistPortfolioDigest({
      evidence_paths: evidencePaths,
      specialists,
      procedures,
    }),
  };
  return validateSpecialistPortfolio(portfolio);
}
