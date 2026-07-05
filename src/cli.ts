import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultConfigDir } from "./core/agentify-config.ts";
import { PiSdkRuntime, packageRoot } from "./core/pi-sdk-runtime.ts";
import { runAgentifyApp } from "./core/agentify-app.ts";
import type { AgentifyUi } from "./core/types.ts";

class ConsoleUi implements AgentifyUi {
  constructor(private readonly nonInteractive = false) {}

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
    if (this.nonInteractive) {
      throw new Error(
        `${message} Running non-interactively (--non-interactive). ` +
          "Pre-configure auth via a provider env var (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY) " +
          "or ~/.agentify/auth.json, and pass --assume brownfield|greenfield for ambiguous repos.",
      );
    }
    if (!input.isTTY) {
      throw new Error(
        `${message} Cannot prompt because stdin is not interactive. ` +
          "Pre-configure auth via a provider env var or ~/.agentify/auth.json, " +
          "or run with --non-interactive and --assume for scripted use.",
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

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print the version and exit.
  --config-dir <dir>         Use a different agentify state dir (default ~/.agentify).
  --non-interactive, --yes   Never prompt. Requires pre-configured auth
                             (provider env var or ~/.agentify/auth.json).
  --assume <kind>            Skip classification for ambiguous repos.
                             <kind> is 'brownfield' or 'greenfield'.

Run agentify in the current repository. Existing repos are audited and exported for
Codex, Claude Code, and Pi. Empty/new repos start a local-first greenfield chat.

agentify exposes one public CLI entrypoint. Bootstrap, attach, and recovery all
start from \`agentify\` itself. After bootstrap, work through GitHub issues, comments,
and PRs (see docs/lifecycle/README.md).
`);
}

function takeFlagValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i])) {
      const value = argv[i + 1];
      argv.splice(i, value ? 2 : 1);
      return value;
    }
  }
  return undefined;
}

function takeBooleanFlag(argv: string[], names: string[]): boolean {
  let found = false;
  for (let i = argv.length - 1; i >= 0; i--) {
    if (names.includes(argv[i])) {
      argv.splice(i, 1);
      found = true;
    }
  }
  return found;
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
  // Parse flags from argv so the single public entrypoint stays one
  // command while supporting non-interactive/scripted use.
  const configDir = takeFlagValue(argv, ["--config-dir", "--configDir"])
    ?? defaultConfigDir();
  const nonInteractive = takeBooleanFlag(argv, ["--non-interactive", "--yes", "-y"]);
  const assumeRaw = takeFlagValue(argv, ["--assume", "--assume-kind"]);
  let assumeProjectKind: "brownfield" | "greenfield" | undefined;
  if (assumeRaw !== undefined) {
    if (assumeRaw !== "brownfield" && assumeRaw !== "greenfield") {
      throw new Error(
        `--assume must be 'brownfield' or 'greenfield' (got '${assumeRaw}').`,
      );
    }
    assumeProjectKind = assumeRaw;
  }

  await runAgentifyApp({
    args: argv,
    cwd: process.cwd(),
    configDir,
    ui: new ConsoleUi(nonInteractive),
    runtime: new PiSdkRuntime(),
    assumeProjectKind,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agentify: ${message}\n`);
    process.exitCode = 1;
  });
}

