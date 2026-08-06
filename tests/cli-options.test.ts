import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/core/cli-parser.ts";

test("empty argv selects the focused installer", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "run" });
});

test("public utility subcommands preserve argv", () => {
  for (const name of ["login", "logout", "models"] as const) {
    assert.deepEqual(parseCliArgs([name, "--help"]), {
      kind: "subcommand",
      name,
      argv: [name, "--help"],
    });
  }
});

test("top-level help and version remain exact", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
  assert.deepEqual(parseCliArgs(["-v"]), { kind: "version" });
});

test("unexpected positionals expose only the public command inventory", () => {
  assert.throws(
    () => parseCliArgs(["unknown-command"]),
    (error: unknown) => error instanceof Error
      && /Known subcommands: login, logout, models/.test(error.message),
  );
});
