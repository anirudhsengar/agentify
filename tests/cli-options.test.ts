import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCliArgs } from "../src/core/cli-parser.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

function assertThrowsMessage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern);
}

function sanitizedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || key.endsWith("_TOKEN")) delete env[key];
  }
  return env;
}

function assertBinaryRecognizesOptions(
  args: readonly string[],
  expectedValidationError: RegExp,
): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cli-options-cwd-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-cli-options-home-"));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "bin", "agentify.js"), ...args],
      {
        cwd,
        env: sanitizedEnv(home),
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined, `binary failed to start: ${result.error?.message ?? "unknown"}`);
    assert.notEqual(result.status, 0, "the validation fixture must stop before runtime setup");
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.doesNotMatch(output, /unknown subcommand '--(?:mode|targets)'/);
    assert.match(output, expectedValidationError);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testParsesRunOptions(): Promise<void> {
  assert.deepEqual(parseCliArgs([]), { kind: "run" });
  assert.deepEqual(parseCliArgs(["--mode", "brownfield"]), {
    kind: "run",
    mode: "brownfield",
  });
  assert.deepEqual(parseCliArgs(["--targets=codex,claude-code,codex"]), {
    kind: "run",
    targetsOverride: ["codex", "claude-code"],
  });
  assert.deepEqual(
    parseCliArgs(["--targets", "codex", "--mode", "greenfield"]),
    { kind: "run", mode: "greenfield", targetsOverride: ["codex"] },
  );
}

async function testPreservesSubcommandArguments(): Promise<void> {
  assert.deepEqual(parseCliArgs(["login", "--provider", "openai-codex"]), {
    kind: "subcommand",
    name: "login",
    argv: ["login", "--provider", "openai-codex"],
  });
  assert.deepEqual(parseCliArgs(["models", "list", "--provider", "openai"]), {
    kind: "subcommand",
    name: "models",
    argv: ["models", "list", "--provider", "openai"],
  });
}

async function testHelpAndVersionTakePrecedence(): Promise<void> {
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["login", "--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
}

async function testRejectsInvalidInput(): Promise<void> {
  assertThrowsMessage(() => parseCliArgs(["--mode"]), /--mode requires a value/);
  assertThrowsMessage(() => parseCliArgs(["--targets"]), /--targets requires/);
  assertThrowsMessage(() => parseCliArgs(["--mode", "bogus"]), /brownfield.*greenfield/);
  assertThrowsMessage(() => parseCliArgs(["--targets", "not-an-agent"]), /unknown agent/);
  assertThrowsMessage(() => parseCliArgs(["--mode", "brownfield", "--mode=greenfield"]), /only be specified once/);
  assertThrowsMessage(() => parseCliArgs(["--unknown"]), /Unknown option|unknown option/i);
  assertThrowsMessage(() => parseCliArgs(["unknown-command"]), /unknown subcommand 'unknown-command'/);
}

async function testPublishedBinaryRecognizesDocumentedOptions(): Promise<void> {
  assertBinaryRecognizesOptions(
    ["--mode", "brownfield", "--targets", "not-an-agent"],
    /--targets includes unknown agent 'not-an-agent'/,
  );
  assertBinaryRecognizesOptions(
    ["--targets", "codex", "--mode", "bogus"],
    /--mode must be 'brownfield' or 'greenfield'/,
  );
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "parsesRunOptions", fn: testParsesRunOptions },
  { name: "preservesSubcommandArguments", fn: testPreservesSubcommandArguments },
  { name: "helpAndVersionTakePrecedence", fn: testHelpAndVersionTakePrecedence },
  { name: "rejectsInvalidInput", fn: testRejectsInvalidInput },
  { name: "publishedBinaryRecognizesDocumentedOptions", fn: testPublishedBinaryRecognizesDocumentedOptions },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}
console.log(`cli-options tests passed (${passed}/${tests.length}).`);
