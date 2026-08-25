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
).replaceAll("\r\n", "\n");

test("compiled CLI help is byte-stable and focused on the repository team", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "dist", "cli.js")), "npm run build must create dist/cli.js");
  const sandbox = createCliSandbox("agentify-parity-help");
  try {
    const result = runCompiledCli(["--help"], sandbox);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, EXPECTED_HELP);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Install Agentify once in an existing GitHub repository/);
    assert.match(result.stdout, /exactly one builder/);
    assert.match(result.stdout, /unmerged draft pull request/);
    assert.match(result.stdout, /human\s+retains application merge authority/i);
    assert.doesNotMatch(result.stdout, /^\s*--mode\b/m);
    assert.doesNotMatch(result.stdout, /^\s*--targets\b/m);
    assert.doesNotMatch(result.stdout, /^\s*--migrate-state\b/m);
    assert.doesNotMatch(result.stdout, /^\s*--github-runtime\b/m);
    assert.doesNotMatch(result.stdout, /^\s*agentify engage\b/m);
    assert.doesNotMatch(result.stdout, /^\s*agentify eval\b/m);
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

test("unexpected positional arguments identify only public maintenance commands", () => {
  const sandbox = createCliSandbox("agentify-parity-positional");
  try {
    const result = runCompiledCli(["unsupported-command"], sandbox);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "agentify: unknown subcommand 'unsupported-command'. Known subcommands: login, logout, models. Run `agentify --help` for usage.\n",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("public utility subcommands retain argv dispatch and output channels", () => {
  const sandbox = createCliSandbox("agentify-parity-utility");
  try {
    // OAuth-only providers cannot sign in without a TTY: the CLI fails
    // closed on stderr and points at the interactive flow.
    const login = runCompiledCli(["login", "--provider", "openai-codex"], sandbox);
    assert.notEqual(login.status, 0);
    assert.equal(login.stdout, "");
    assert.equal(
      login.stderr,
      "agentify: login: openai-codex requires an interactive sign-in; run `agentify login` in a terminal\n",
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

test("default execution is focused and unsupported options are rejected", () => {
  const defaultSandbox = createCliSandbox("agentify-parity-noninteractive-default");
  try {
    const focused = runCompiledCli([], defaultSandbox);
    assert.notEqual(focused.status, 0);
    assert.equal(focused.stdout, "");
    assert.match(focused.stderr, /blocker \[not_git_repository\]/);

    for (const unsupported of ["--mode", "--targets", "--migrate-state", "--github-runtime"]) {
      const rejected = runCompiledCli([unsupported], defaultSandbox);
      assert.notEqual(rejected.status, 0);
      assert.equal(rejected.stdout, "");
      assert.match(rejected.stderr, /unknown option/i);
    }
  } finally {
    defaultSandbox.cleanup();
  }
});
