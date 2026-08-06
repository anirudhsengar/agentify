import { parseArgs } from "node:util";
import { SUBCOMMAND_NAMES, type SubcommandName } from "./cli-commands.ts";
import { PUBLIC_SUBCOMMAND_NAMES } from "./public-cli-contract.ts";

export type ParsedCliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "subcommand"; name: SubcommandName; argv: readonly string[] }
  | { kind: "run" };

const SUBCOMMAND_SET = new Set<string>(SUBCOMMAND_NAMES);

function normalizeParseError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^TypeError \[ERR_PARSE_ARGS_[^\]]+\]:\s*/, ""));
}

/** Parse the complete installed CLI contract without mutating argv. */
export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  const head = argv[0];
  if (head && SUBCOMMAND_SET.has(head)) {
    return { kind: "subcommand", name: head as SubcommandName, argv: [...argv] };
  }
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };

  const parsed = (() => {
    try {
      return parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: {} });
    } catch (error) {
      throw normalizeParseError(error);
    }
  })();

  if (parsed.positionals.length > 0) {
    const unknown = parsed.positionals[0];
    throw new Error(
      `unknown subcommand '${unknown}'. Known subcommands: ${PUBLIC_SUBCOMMAND_NAMES.join(", ")}. ` +
        "Run `agentify --help` for usage.",
    );
  }
  return { kind: "run" };
}
