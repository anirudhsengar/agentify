import { parseArgs } from "node:util";
import { isKnownAgent, type AgentId } from "./agent-registry.ts";
import { SUBCOMMAND_NAMES, type SubcommandName } from "./cli-commands.ts";

export type CliMode = "brownfield" | "greenfield";

export type ParsedCliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "subcommand"; name: SubcommandName; argv: readonly string[] }
  | {
      kind: "run";
      mode?: CliMode;
      targetsOverride?: readonly AgentId[];
    };

const SUBCOMMAND_SET = new Set<string>(SUBCOMMAND_NAMES);

function countLongOption(argv: readonly string[], name: string): number {
  const exact = `--${name}`;
  const prefix = `${exact}=`;
  return argv.reduce(
    (count, token) => count + (token === exact || token.startsWith(prefix) ? 1 : 0),
    0,
  );
}

function assertNoDuplicateSingletonOptions(argv: readonly string[]): void {
  for (const name of ["mode", "targets"] as const) {
    if (countLongOption(argv, name) > 1) {
      throw new Error(`--${name} may only be specified once.`);
    }
  }
}

function parseTargets(raw: string): readonly AgentId[] {
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--targets must include at least one agent ID.");
  }

  const seen = new Set<AgentId>();
  const targets: AgentId[] = [];
  for (const value of parts) {
    if (!isKnownAgent(value)) {
      throw new Error(
        `--targets includes unknown agent '${value}'. ` +
          "Run `agentify` with no flags to see the supported list.",
      );
    }
    if (seen.has(value)) continue;
    seen.add(value);
    targets.push(value);
  }
  return targets;
}

function normalizeParseError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/option '--mode' argument missing/i.test(message)) {
    return new Error("--mode requires a value.");
  }
  if (/option '--targets' argument missing/i.test(message)) {
    return new Error("--targets requires a comma-separated list of agent IDs.");
  }
  return new Error(message.replace(/^TypeError \[ERR_PARSE_ARGS_[^\]]+\]:\s*/, ""));
}

/**
 * Parse the public CLI boundary without mutating argv.
 *
 * Utility subcommands retain ownership of their own flags. Top-level runtime
 * options are parsed only when no subcommand is selected.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };

  const head = argv[0];
  if (head && SUBCOMMAND_SET.has(head)) {
    return {
      kind: "subcommand",
      name: head as SubcommandName,
      argv: [...argv],
    };
  }

  assertNoDuplicateSingletonOptions(argv);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        mode: { type: "string" },
        targets: { type: "string" },
      },
    });
  } catch (error) {
    throw normalizeParseError(error);
  }

  if (parsed.positionals.length > 0) {
    const unknown = parsed.positionals[0];
    throw new Error(
      `unknown subcommand '${unknown}'. Known subcommands: ${SUBCOMMAND_NAMES.join(", ")}. ` +
        "Run `agentify --help` for usage.",
    );
  }

  const modeValue = parsed.values.mode;
  let mode: CliMode | undefined;
  if (modeValue !== undefined) {
    if (modeValue !== "brownfield" && modeValue !== "greenfield") {
      throw new Error(`--mode must be 'brownfield' or 'greenfield' (got '${modeValue}').`);
    }
    mode = modeValue;
  }

  const targetsValue = parsed.values.targets;
  const targetsOverride = targetsValue === undefined ? undefined : parseTargets(targetsValue);

  return {
    kind: "run",
    ...(mode === undefined ? {} : { mode }),
    ...(targetsOverride === undefined ? {} : { targetsOverride }),
  };
}
