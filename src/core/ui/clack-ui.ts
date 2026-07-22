// `AgentifyUi` implementation backed by `@clack/prompts`.
//
// Design choices (from `docs/plans/lexical-petting-mitten.md`):
//
// 1. **TTY gating.** `clack.select`/`multiselect`/`password` drive
//    raw-mode I/O themselves. If stdin is not interactive we throw
//    the same `Ensure interactive` error `ConsoleUi.ensureInteractive`
//    threw, so the bin's stderr catch in `bin/agentify.js` continues
//    to produce a recognisable message. The wording is preserved
//    verbatim to keep that substring testable.
//
// 2. **Cancel-symbol translation.** Clack returns a sentinel symbol on
//    Ctrl-C. We catch it and re-throw `Error("Interrupted.")` so the
//    bin's catch handler prints `agentify: Interrupted.` on stderr and
//    sets exit code 1 — matching `ConsoleUi.promptSecret`.
//
// 3. **Status/info/error are NOT routed through `clack.log`.** Most
//    call sites in `src/core/runs/` and `src/core/agentify-app.ts`
//    already prepend `agentify:` to their messages; clack's log
//    helpers would stack a red ✗-symbol on top and corrupt the
//    pinned substring tests (`tests/cli-options.test.ts:308` etc.).
//
// 4. **`header` and `initialValue` are skipped** on `promptSelect`
//    due to an upstream rendering bug in clack where the header
//    carries the initial value over. `initialValues` IS used on
//    `promptMultiSelect` so the default-target flow stays one click.

import { stdin as input } from "node:process";
import type { AgentifyUi } from "../types.ts";
import * as clack from "@clack/prompts";
import { runCheckboxPicker, runSelectPicker } from "./checkbox-picker.ts";

const NON_TTY_TAIL =
  "Cannot prompt because stdin is not interactive. " +
  "Pre-configure auth via a provider env var (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY) " +
  "or ~/.agentify/auth.json before running agentify.";

export class ClackUi implements AgentifyUi {
  status(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  info(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  /**
   * Write the message verbatim to stderr. The convention is that the
   * caller decides the prefix (e.g., `agentify: login: unknown
   * provider 'foo'`); we must not double-stack a clack symbol.
   *
   * The bin's `agentify: <message>` catch handler in
   * `bin/agentify.js:7` is what produces the leading `agentify:` prefix
   * for top-level errors, so `tests/cli-options.test.ts` continues to
   * match.
   */
  error(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  private ensureInteractive(label: string): void {
    if (!input.isTTY) {
      // Embed the prompt's `message` argument in the error so a user
      // running non-interactively sees WHICH prompt failed (e.g.,
      // "Choose an LLM provider for agentify:" rather than only
      // "Agentify needs an interactive terminal"). This matches the
      // pre-clack `ConsoleUi.ensureInteractive` contract and keeps the
      // parity tests' substring assertions stable.
      throw new Error(
        `${label} ${NON_TTY_TAIL}`,
      );
    }
  }

  async promptSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string }>,
  ): Promise<string> {
    this.ensureInteractive(message);
    return runSelectPicker(message, choices);
  }

  async promptMultiSelect(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string; hint?: string }>,
  ): Promise<ReadonlyArray<string>> {
    this.ensureInteractive(message);
    return runCheckboxPicker(message, choices);
  }

  async promptCheckboxList(
    message: string,
    choices: ReadonlyArray<{ label: string; value: string; hint?: string }>,
    options?: {
      initialValues?: ReadonlyArray<string>;
      cursorAt?: string;
    },
  ): Promise<ReadonlyArray<string>> {
    this.ensureInteractive(message);
    return runCheckboxPicker(message, choices, options);
  }

  async promptSecret(message: string): Promise<string> {
    this.ensureInteractive(message);
    const result = await clack.password({
      message,
      mask: "*",
    });
    if (clack.isCancel(result)) {
      throw new Error("Interrupted.");
    }
    return result as string;
  }

  async promptText(message: string): Promise<string> {
    this.ensureInteractive(message);
    const result = await clack.text({ message });
    if (clack.isCancel(result)) throw new Error("Interrupted.");
    return (result as string).trim();
  }
}
