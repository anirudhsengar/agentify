import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errOutput } from "node:process";
import { PiSdkRuntime, packageRoot } from "./core/pi-sdk-runtime.ts";
import { runAgentifyApp } from "./core/agentify-app.ts";
import { defaultConfigDir } from "./core/agentify-config.ts";
import {
  dispatchSubcommand,
  printSubcommandHelp,
  type SubcommandContext,
} from "./core/cli-commands.ts";
import { isKnownAgent } from "./core/agent-registry.ts";
import type { AgentifyUi } from "./core/types.ts";

class ConsoleUi implements AgentifyUi {
  status(message: string): void {
    output.write(`${message}\n`);
  }

  info(message: string): void {
    output.write(`${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  private ensureInteractive(message: string): void {
    if (!input.isTTY) {
      throw new Error(
        `${message} Cannot prompt because stdin is not interactive. ` +
          "Pre-configure auth via a provider env var (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY) " +
          "or ~/.agentify/auth.json before running agentify.",
      );
    }
  }

  async promptSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string }>,
  ): Promise<string> {
    this.ensureInteractive(message);
    const rl = readline.createInterface({ input, output });
    try {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label}\n`));
      while (true) {
        const answer = (await rl.question("> ")).trim();
        const index = Number.parseInt(answer, 10);
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
          return choices[index - 1].value;
        }
        const byValue = choices.find((choice) => choice.value === answer);
        if (byValue) return byValue.value;
        output.write(`Enter 1-${choices.length}.\n`);
      }
    } finally {
      rl.close();
    }
  }

  async promptMultiSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string; hint?: string }>,
  ): Promise<ReadonlyArray<string>> {
    this.ensureInteractive(message);
    const rl = readline.createInterface({ input, output });
    try {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => {
        const hint = choice.hint ? `  → ${choice.hint}` : "";
        output.write(`  ${index + 1}. ${choice.label}${hint}\n`);
      });
      output.write("(comma-separated numbers, 'all', or 'none')\n");
      while (true) {
        const answer = (await rl.question("> ")).trim().toLowerCase();
        if (answer === "all") return choices.map((choice) => choice.value);
        if (answer === "none") return [];
        const parts = answer.split(",").map((part) => part.trim()).filter(Boolean);
        if (parts.length === 0) {
          output.write(`Enter 1-${choices.length} (comma-separated), 'all', or 'none'.\n`);
          continue;
        }
        const indices = parts.map((part) => Number.parseInt(part, 10));
        const allNumeric = indices.every(
          (idx) => Number.isInteger(idx) && idx >= 1 && idx <= choices.length,
        );
        if (!allNumeric) {
          output.write(`Enter 1-${choices.length} (comma-separated), 'all', or 'none'.\n`);
          continue;
        }
        const seen = new Set<string>();
        const result: string[] = [];
        for (const idx of indices) {
          const value = choices[idx - 1].value;
          if (seen.has(value)) continue;
          seen.add(value);
          result.push(value);
        }
        return result;
      }
    } finally {
      rl.close();
    }
  }

  async promptSecret(message: string): Promise<string> {
    this.ensureInteractive(message);
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      const stdout = process.stdout;
      const wasRaw = stdin.isRaw;
      let value = "";
      stdout.write(`${message}: `);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf-8");
      const onData = (chunk: string): void => {
        if (chunk === "\u0003") {
          cleanup();
          reject(new Error("Interrupted."));
          return;
        }
        if (chunk === "\r" || chunk === "\n") {
          stdout.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        if (chunk === "\u007f") {
          value = value.slice(0, -1);
          return;
        }
        value += chunk;
      };
      const cleanup = (): void => {
        stdin.off("data", onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
      };
      stdin.on("data", onData);
    });
  }
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(packageRoot(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

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
                             use; persisted targets are NOT respected
                             (ADR 0018).

Run agentify in the current repository. Existing repos are audited and exported to
the coding agents you select — by default Claude Code, Codex, and Pi, prompted
interactively. Empty/new repos start a local-first greenfield chat.

agentify exposes one public runtime entrypoint: \`agentify\` with no positional
arguments. Bootstrap, attach, and recovery all start there. After bootstrap, work
through GitHub issues, comments, and PRs (see docs/lifecycle/README.md).
`);
  printSubcommandHelp(output);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    output.write(`${readPackageVersion()}\n`);
    return;
  }

  // Subcommand dispatch runs BEFORE --mode parsing so that flags belonging
  // to a subcommand (e.g. `models list --provider x`) are not consumed by
  // the top-level parser.
  const ui = new ConsoleUi();
  const subcommandCtx: SubcommandContext = {
    cwd: process.cwd(),
    configDir: defaultConfigDir(),
    ui,
    out: output,
    err: errOutput,
  };
  if (argv.length > 0) {
    const head = argv[0];
    if (head === "login" || head === "logout" || head === "models") {
      await dispatchSubcommand(argv, subcommandCtx);
      return;
    }
    throw new Error(
      `unknown subcommand '${head}'. Known subcommands: login, logout, models. Run \`agentify --help\` for usage.`,
    );
  }

  let mode: "brownfield" | "greenfield" | undefined;
  const modeIndex = argv.indexOf("--mode");
  if (modeIndex >= 0) {
    const value = argv[modeIndex + 1];
    if (value !== "brownfield" && value !== "greenfield") {
      throw new Error(
        `--mode must be 'brownfield' or 'greenfield' (got '${value}').`,
      );
    }
    mode = value;
    argv.splice(modeIndex, 2);
  }

  // --targets <csv>: comma-separated list of agent IDs. Skips the
  // interactive picker. Validated against the agent registry — unknown
  // IDs throw with a clear message naming the bad entries.
  let targetsOverride: ReadonlyArray<string> | undefined;
  const targetsIndex = argv.indexOf("--targets");
  if (targetsIndex >= 0) {
    const raw = argv[targetsIndex + 1];
    if (raw === undefined) {
      throw new Error("--targets requires a comma-separated list of agent IDs.");
    }
    const parsed = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (parsed.length === 0) {
      throw new Error("--targets must include at least one agent ID.");
    }
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const id of parsed) {
      if (!isKnownAgent(id)) {
        throw new Error(
          `--targets includes unknown agent '${id}'. ` +
            `Run \`agentify\` with no flags to see the supported list.`,
        );
      }
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    targetsOverride = deduped;
    argv.splice(targetsIndex, 2);
  }

  await runAgentifyApp({
    args: argv,
    cwd: process.cwd(),
    ui,
    runtime: new PiSdkRuntime(),
    mode,
    targetsOverride,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agentify: ${message}\n`);
    process.exitCode = 1;
  });
}