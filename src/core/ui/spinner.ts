// Wrapper around `@clack/prompts`' spinner that gates every operation
// on `process.stdin.isTTY && process.stdout.isTTY`. When the process is
// not attached to a terminal (CI run, output piped to a file, the bash
// smoke tests) the spinner becomes a set of no-ops so structured logs
// stay free of ANSI cursor escape sequences.
//
// Coarse-grained-events only: callers should update the spinner on
// turn boundaries (`message_end`), tool-completion events
// (`tool_execution_end` with `toolName === "write_map"` or
// `"spawn_explorer"`), and `agent_end`. Updating on streaming events
// (`message_update`, `tool_execution_update`) shreds the rendered
// spinner and burns CPU for zero user-visible benefit.

import * as clack from "@clack/prompts";

export type SpinnerKind = "success" | "error" | "info" | "warn";

export interface SpinnerHandle {
  /** Update the spinner's trailing text. No-op when not on a TTY. */
  update(message: string): void;
  /**
   * Stop the spinner and append a final line. `kind` selects the
   * clack icon and color (default `"success"`).
   */
  stop(message: string, kind?: SpinnerKind): void;
  /** Underlying clack spinner; escape hatch for callers that need it. */
  raw: ReturnType<typeof clack.spinner>;
}

function ttyOk(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Start a spinner only when stdin/stdout are both TTYs; otherwise
 * return a no-op handle so callers can wire the audit pipeline
 * unconditionally.
 *
 * The initial message prints via `clack.log.info` even on non-TTY
 * so a piped log file gets a clear start marker.
 */
export function startSpinner(initialMessage: string): SpinnerHandle {
  if (!ttyOk()) {
    if (initialMessage) {
      process.stdout.write(`${initialMessage}\n`);
    }
    const noop = {
      update: (_msg: string) => {
        /* no-op */
      },
      stop: (msg: string) => {
        if (msg) process.stdout.write(`${msg}\n`);
      },
      raw: null as unknown as ReturnType<typeof clack.spinner>,
    };
    return noop;
  }

  const sp = clack.spinner();
  sp.start(initialMessage);
  return {
    update(message: string): void {
      if (!ttyOk()) return;
      sp.message(message);
    },
    stop(message: string, kind: SpinnerKind = "success"): void {
      if (!ttyOk()) {
        if (message) process.stdout.write(`${message}\n`);
        return;
      }
      // clack stop codes: 0 = success ✓, 1 = error ✗, 2 = warn ▲, 3 = info ·
      const code =
        kind === "success" ? 0 : kind === "error" ? 1 : kind === "warn" ? 2 : 3;
      sp.stop(message, code);
    },
    raw: sp,
  };
}
