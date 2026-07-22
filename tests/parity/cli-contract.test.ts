import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  createCliSandbox,
  repoRoot,
  runCompiledCli,
} from "./helpers/cli-process.ts";

interface PackageMetadata {
  version: string;
}

const ROOT = repoRoot();
const PACKAGE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
) as PackageMetadata;
const EXPECTED_HELP = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "cli-help.txt"),
  "utf-8",
);

test("compiled CLI help is byte-stable on stdout", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "dist", "cli.js")), "npm run build must create dist/cli.js");
  const sandbox = createCliSandbox("agentify-parity-help");
  try {
    const result = runCompiledCli(["--help"], sandbox);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, EXPECTED_HELP);
    assert.equal(result.stderr, "");
  } finally {
    sandbox.cleanup();
  }
});

test("compiled CLI version is package version on stdout", () => {
  const sandbox = createCliSandbox("agentify-parity-version");
  try {
    const result = runCompiledCli(["--version"], sandbox);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${PACKAGE.version}\n`);
    assert.equal(result.stderr, "");
  } finally {
    sandbox.cleanup();
  }
});

test("invalid top-level options fail concisely on stderr", () => {
  const sandbox = createCliSandbox("agentify-parity-invalid-option");
  try {
    const result = runCompiledCli(["--unknown"], sandbox);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^agentify: .*unknown option '--unknown'/i);
    assert.doesNotMatch(result.stderr, /\n\s*at |Error:/);
  } finally {
    sandbox.cleanup();
  }
});

test("unexpected positional arguments identify the supported utility commands", () => {
  const sandbox = createCliSandbox("agentify-parity-positional");
  try {
    const result = runCompiledCli(["unsupported-command"], sandbox);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "agentify: unknown subcommand 'unsupported-command'. Known subcommands: login, logout, models, revert, engage, eval. Run `agentify --help` for usage.\n",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("utility subcommands retain argv dispatch and output channels", () => {
  const sandbox = createCliSandbox("agentify-parity-utility");
  try {
    const login = runCompiledCli(["login", "--provider", "openai-codex"], sandbox);
    assert.equal(login.status, 0);
    assert.equal(login.stderr, "");
    assert.equal(
      login.stdout,
      "OpenAI Codex uses OAuth and cannot be configured via the agentify CLI.\n" +
        "Run `pi auth login openai-codex` to complete the OAuth flow; agentify will pick up the saved credentials.\n",
    );

    const models = runCompiledCli(["models"], sandbox);
    assert.notEqual(models.status, 0);
    assert.equal(models.stdout, "");
    assert.equal(
      models.stderr,
      "agentify: models: missing sub-action. Usage: agentify models <list|show|set|unset>\n",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("non-interactive runs bypass target prompting with defaults or explicit targets", () => {
  const defaultSandbox = createCliSandbox("agentify-parity-noninteractive-default");
  const explicitSandbox = createCliSandbox("agentify-parity-noninteractive-explicit");
  try {
    for (const [args, sandbox] of [
      [[], defaultSandbox],
      [["--targets", "claude-code"], explicitSandbox],
    ] as const) {
      const result = runCompiledCli(args, sandbox);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /^agentify: Choose an LLM provider for agentify: Cannot prompt because stdin is not interactive\./,
      );
      assert.doesNotMatch(result.stderr, /comma-separated numbers|Choose coding agents/i);
    }
  } finally {
    defaultSandbox.cleanup();
    explicitSandbox.cleanup();
  }
});
