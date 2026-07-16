// CLI entry for `agentify`. The hand-rolled `node:readline/promises`
// UI was extracted to `./core/ui/console-ui.ts` and is used only when
// the `AGENTIFY_OLD_UI=1` env flag is set. ClackUi is the default in
// 0.2.x — see `./core/ui/clack-ui.ts` for the design notes.

import { stdin as input, stdout as output, stderr as errOutput } from "node:process";
import { PiSdkRuntime } from "./core/pi-sdk-runtime.ts";
import { readPackageVersion } from "./core/package-version.ts";
import { runAgentifyApp } from "./core/agentify-app.ts";
import { defaultConfigDir } from "./core/agentify-config.ts";
import {
  dispatchSubcommand,
  printSubcommandHelp,
  type SubcommandContext,
} from "./core/cli-commands.ts";
import { parseCliArgs } from "./core/cli-parser.ts";
import { ClackUi, ConsoleUi, printBanner } from "./core/ui/index.ts";

function printHelp(): void {
  output.write(`agentify ${readPackageVersion()}

Usage:
  agentify [options]
  agentify <subcommand> [subcommand-options]

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print the version and exit.
  --mode <kind>              Skip project-kind classification for ambiguous
                             repos. <kind> is 'brownfield' or 'greenfield'.
  --targets <csv>            Skip the agent-target picker. Comma-separated
                             agent IDs (e.g. 'claude-code,codex,cursor').
                             Skips the picker entirely for non-interactive
                             use; persisted targets are NOT respected.
  --migrate-state            With --targets, explicitly migrate one unambiguous
                             prior provider state tree to the selected provider.
                             The prior tree is retained unchanged.

Run agentify in the current repository. Existing repos are audited and exported to
the coding agents you select — by default Claude Code, Codex, and Pi, prompted
interactively. Empty/new repos start a local-first greenfield chat.

agentify exposes one public runtime entrypoint: \`agentify\` with no positional
arguments. Bootstrap, attach, and recovery all start there. After bootstrap, work
through GitHub issues, comments, and PRs (see docs/lifecycle/README.md).
`);
  printSubcommandHelp(output);
}

function shouldPrintBanner(): boolean {
  // Banner prints once per invocation when the user is at a terminal
  // (so the first-run experience is rich) and they have not opted into
  // the historic readline-based UI. Piped runs and CI keep their
  // machine-greppable output untouched.
  return Boolean(input.isTTY) && !("AGENTIFY_OLD_UI" in process.env);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = parseCliArgs(argv);
  if (command.kind === "version") {
    // Preserves the one-line, machine-readable contract that shell
    // dotfiles and CI scripts depend on.
    output.write(`${readPackageVersion()}\n`);
    return;
  }
  if (shouldPrintBanner()) {
    printBanner(readPackageVersion());
  }
  if (command.kind === "help") {
    printHelp();
    return;
  }

  const useOldUi = "AGENTIFY_OLD_UI" in process.env;
  const ui = useOldUi ? new ConsoleUi() : new ClackUi();
  if (command.kind === "subcommand") {
    const subcommandCtx: SubcommandContext = {
      cwd: process.cwd(),
      configDir: defaultConfigDir(),
      ui,
      out: output,
      err: errOutput,
    };
    await dispatchSubcommand(command.argv, subcommandCtx);
    return;
  }

  await runAgentifyApp({
    args: [],
    cwd: process.cwd(),
    ui,
    runtime: new PiSdkRuntime(),
    mode: command.mode,
    targetsOverride: command.targetsOverride,
    migrateState: command.migrateState,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agentify: ${message}\n`);
    process.exitCode = 1;
  });
}
