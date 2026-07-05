import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultConfigDir } from "./core/agentify-config.ts";
import { PiSdkRuntime, packageRoot } from "./core/pi-sdk-runtime.ts";
import { runAgentifyApp } from "./core/agentify-app.ts";
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

  async promptSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string }>,
  ): Promise<string> {
    if (!input.isTTY) {
      throw new Error(`${message} Cannot prompt because stdin is not interactive.`);
    }
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
    if (!input.isTTY) {
      throw new Error(`${message} Cannot prompt because stdin is not interactive.`);
    }
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
  agentify
  agentify --help
  agentify --version

Run agentify in the current repository. Existing repos are audited and exported for
Codex, Claude Code, and Pi. Empty/new repos start a local-first greenfield chat.

agentify exposes one public CLI entrypoint. Bootstrap, attach, and recovery all
start from \`agentify\` itself.
`);
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
  // Parse --config-dir (or --configDir) from argv so the single public
  // entrypoint can target a different agentify runtime state directory.
  let configDir = defaultConfigDir();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config-dir" || argv[i] === "--configDir") {
      const v = argv[i + 1];
      if (v) {
        configDir = v;
        argv.splice(i, 2);
        i -= 1;
      }
    }
  }
  await runAgentifyApp({
    args: argv,
    cwd: process.cwd(),
    configDir,
    ui: new ConsoleUi(),
    runtime: new PiSdkRuntime(),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agentify: ${message}\n`);
    process.exitCode = 1;
  });
}

