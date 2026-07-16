// Tests for `src/core/ui/clack-ui.ts`.
//
// `ClackUi` is the `AgentifyUi` adapter backed by `@clack/prompts`. We
// only test the surface that does not require a real TTY: the
// status/info/error writers (which are pure console writes) and the
// non-interactive throw from `ensureInteractive` (which is what every
// CI and piped invocation will see). The interactive picker shapes are
// covered by `tests/package/installed-cli-smoke.mjs` and manual
// smoke runs against a throwaway target repo.

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { ClackUi } from "../../../src/core/ui/clack-ui.ts";

class CapturingWritable extends Writable {
  chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

const requireNonInteractiveStdin = (): boolean => process.stdin.isTTY === false || process.stdin.isTTY === undefined;

test("status writes the message plus a newline to stdout", () => {
  const ui = new ClackUi();
  const capture = new CapturingWritable();
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = capture.write.bind(capture);
  try {
    ui.status("agentify: hello");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }
  assert.equal(capture.text(), "agentify: hello\n");
});

test("info writes the message plus a newline to stdout", () => {
  const ui = new ClackUi();
  const capture = new CapturingWritable();
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = capture.write.bind(capture);
  try {
    ui.info("agentify: world");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }
  assert.equal(capture.text(), "agentify: world\n");
});

test("error writes the message plus a newline to stderr verbatim (no clack symbol)", () => {
  const ui = new ClackUi();
  const capture = new CapturingWritable();
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = capture.write.bind(capture);
  try {
    ui.error("agentify: login: unknown provider 'foo'");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }
  const output = capture.text();
  assert.equal(output, "agentify: login: unknown provider 'foo'\n");
  // Critically: no clack-style prefix symbol. The bin wrapper in
  // `bin/agentify.js` produces the leading `agentify:` itself, and
  // stacking `clack.log.error`'s red ✗ on top would break the
  // `tests/cli-options.test.ts` regex.
  assert.ok(!output.includes("✗"), "error path must not include clack's ✗ symbol");
});

test("promptSelect throws when stdin is not interactive and embeds the prompt message", async () => {
  // In a `tsx <testfile>` invocation stdin is typically not a TTY.
  // If the runner is itself attached to a TTY, we coerce isTTY=false
  // via Object.defineProperty for the duration of this assertion.
  if (!requireNonInteractiveStdin()) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  }
  const ui = new ClackUi();
  await assert.rejects(
    () => ui.promptSelect("Choose a provider:", [
      { label: "OpenAI", value: "openai" },
      { label: "Anthropic", value: "anthropic" },
    ]),
    (err: Error) => {
      // Pre-clack ConsoleUi embedded the prompt message followed by
      // a stable suffix; that contract survives the move to clack.
      return (
        err.message.startsWith("Choose a provider:") &&
        err.message.includes("Cannot prompt because stdin is not interactive")
      );
    },
  );
});

test("promptSecret throws when stdin is not interactive", async () => {
  if (!requireNonInteractiveStdin()) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  }
  const ui = new ClackUi();
  await assert.rejects(
    () => ui.promptSecret("API key"),
    (err: Error) =>
      err.message.startsWith("API key") &&
      err.message.includes("Cannot prompt because stdin is not interactive"),
  );
});

test("promptMultiSelect throws when stdin is not interactive", async () => {
  if (!requireNonInteractiveStdin()) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  }
  const ui = new ClackUi();
  await assert.rejects(
    () => ui.promptMultiSelect("Pick agents:", [
      { label: "Claude Code", value: "claude-code", hint: ".claude/skills" },
    ]),
    (err: Error) =>
      err.message.startsWith("Pick agents:") &&
      err.message.includes("Cannot prompt because stdin is not interactive"),
  );
});
