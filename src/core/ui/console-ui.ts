// Hand-rolled `node:readline/promises` UI. Retained as the fallback
// `AgentifyUi` implementation behind the `AGENTIFY_OLD_UI=1` environment
// flag for users who hit an incompatibility with the clack-based UI
// (e.g., a custom terminal that does not negotiate raw mode).
//
// All other entry points should use `ClackUi` from `./clack-ui.ts` so
// the first-run flow stays searchable and the secret prompt stays
// masked. The two UIs implement the same `AgentifyUi` contract; only
// `ClackUi` is the supported default in 0.2.x.

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AgentifyUi } from "../types.ts";

export class ConsoleUi implements AgentifyUi {
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
        if (chunk === "") {
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
        if (chunk === "") {
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
