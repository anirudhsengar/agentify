import { sortedUniqueStrings } from "../memory/serialization.ts";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const EXECUTABLE_TOKEN = /^(?:[A-Za-z0-9_@.+~-]+|(?:(?:[A-Za-z]:)?[\\/]|\.{1,2}[\\/])?[A-Za-z0-9_@.+~:\\/-]+)$/;
const DIRECTIVE_VERBS = new Set([
  "add",
  "create",
  "document",
  "ensure",
  "extend",
  "fix",
  "record",
  "rerun",
  "review",
  "update",
  "write",
]);
const DIRECTIVE_OBJECTS = new Set([
  "a",
  "an",
  "case",
  "cases",
  "coverage",
  "crate",
  "documentation",
  "fixture",
  "fixtures",
  "lockfile",
  "regression",
  "snapshot",
  "snapshots",
  "test",
  "tests",
  "the",
  "unit",
]);
const DIRECTIVE_CONNECTORS = new Set(["and", "or", "then", "to"]);
const CONDITIONAL_MARKERS = new Set(["if", "unless", "when"]);
const QUALIFIER_MARKERS = new Set([
  "affected",
  "api",
  "changed",
  "documentation",
  "docs",
  "platform",
  "public",
  "source",
  "supported",
  "typed",
]);

interface CommandToken {
  value: string;
  quoted: boolean;
}

/**
 * Tokenize one command without invoking a shell.
 *
 * The parser deliberately supports only the quoting required to recognize a
 * command line. It rejects shell composition and interpolation because a
 * persisted validation command is an argv contract, not a shell program.
 */
function tokenizeCommand(value: string): CommandToken[] | null {
  const tokens: CommandToken[] = [];
  let buffer = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  let escaped = false;

  const flush = (): void => {
    if (buffer.length === 0) return;
    tokens.push({ value: buffer, quoted });
    buffer = "";
    quoted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (next !== undefined && (/\s/.test(next) || next === "\\" || next === "'" || next === '"')) {
        escaped = true;
      } else {
        buffer += character;
      }
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        quoted = true;
      } else {
        buffer += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (";|&<>`".includes(character)) return null;
    if (character === "$" && value[index + 1] === "(") return null;
    buffer += character;
  }

  if (quote !== null || escaped) return null;
  flush();
  return tokens;
}

function containsDirectiveProse(tokens: ReadonlyArray<CommandToken>, executableIndex: number): boolean {
  const executable = tokens[executableIndex]?.value.toLowerCase() ?? "";
  if (DIRECTIVE_VERBS.has(executable)) {
    const lookahead = tokens
      .slice(executableIndex + 1, executableIndex + 7)
      .filter((token) => !token.quoted)
      .map((token) => token.value.toLowerCase());
    if (lookahead.some((token) =>
      DIRECTIVE_OBJECTS.has(token)
      || DIRECTIVE_CONNECTORS.has(token)
      || DIRECTIVE_VERBS.has(token)
    )) {
      return true;
    }
  }

  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.quoted) continue;
    const normalized = token.value.toLowerCase();
    if (CONDITIONAL_MARKERS.has(normalized)) return true;
    if (normalized !== "for") continue;
    const qualifier = tokens[index + 1];
    if (
      qualifier !== undefined
      && !qualifier.quoted
      && QUALIFIER_MARKERS.has(qualifier.value.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

/** True only for a single, concrete argv-like command rather than prose. */
export function executableValidationCommandArgv(value: string): string[] | null {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 2_048
    || normalized !== value
    || CONTROL_CHARACTER.test(normalized)
  ) {
    return null;
  }
  const tokens = tokenizeCommand(normalized);
  if (tokens === null || tokens.length === 0) return null;

  let executableIndex = 0;
  while (
    executableIndex < tokens.length
    && !tokens[executableIndex]!.quoted
    && ENV_ASSIGNMENT.test(tokens[executableIndex]!.value)
  ) {
    executableIndex += 1;
  }
  if (executableIndex >= tokens.length) return null;
  const executable = tokens[executableIndex]!;
  if (
    executable.quoted
    || executable.value.startsWith("-")
    || !EXECUTABLE_TOKEN.test(executable.value)
  ) {
    return null;
  }
  if (containsDirectiveProse(tokens, executableIndex)) return null;
  return tokens.map((token) => token.value);
}

/** True only for a single, concrete argv-like command rather than prose. */
export function isExecutableValidationCommand(value: string): boolean {
  return executableValidationCommandArgv(value) !== null;
}

export function validationCommandArgvKey(argv: ReadonlyArray<string>): string {
  return JSON.stringify(argv);
}

export function executableValidationCommands(
  values: ReadonlyArray<string>,
): { commands: string[]; rejected: string[] } {
  const normalized = sortedUniqueStrings(values.map((value) => value.trim()).filter(Boolean));
  return {
    commands: normalized.filter(isExecutableValidationCommand),
    rejected: normalized.filter((command) => !isExecutableValidationCommand(command)),
  };
}
