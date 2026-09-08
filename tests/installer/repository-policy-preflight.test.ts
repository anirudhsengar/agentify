import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  inspectRepositoryForInstallation,
  prepareOneTimeInstallationState,
  type InstallerProcessRequest,
  type InstallerProcessResult,
  type InstallerProcessRunner,
} from "../../src/core/installer/index.ts";

function result(status: number, stdout = "", stderr = ""): InstallerProcessResult {
  return { status, stdout, stderr, timedOut: false, errorMessage: null };
}

function createRepository(policy: string, policyPath = "CONTRIBUTING.md"): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-restrictive-policy-"));
  fs.mkdirSync(path.join(cwd, "app"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Community application\n");
  fs.writeFileSync(path.join(cwd, "app", "story.rb"), "class Story\nend\n");
  fs.writeFileSync(path.join(cwd, "Gemfile"), "source 'https://rubygems.org'\n");
  fs.writeFileSync(path.join(cwd, "Gemfile.lock"), "GEM\n\nBUNDLED WITH\n   2.6.0\n");
  fs.mkdirSync(path.dirname(path.join(cwd, policyPath)), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, policyPath),
    `${policy}\n`,
  );
  const git = (...args: string[]): void => {
    const execution = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  };
  git("init", "-q");
  git("config", "user.name", "Agentify Test");
  git("config", "user.email", "agentify@example.invalid");
  git("add", ".");
  git("commit", "-qm", "pinned restrictive-policy fixture");
  git("remote", "add", "origin", "https://github.com/lobsters/lobsters.git");
  return cwd;
}

class PolicyRunner implements InstallerProcessRunner {
  run(request: InstallerProcessRequest): InstallerProcessResult {
    if (request.program === "git") {
      const execution = spawnSync("git", ["-C", request.cwd, ...request.args], { encoding: "utf8" });
      return result(execution.status ?? 1, execution.stdout, execution.stderr);
    }
    const command = `${request.program} ${request.args.join(" ")}`;
    if (command === "gh --version") return result(0, "gh version 2.0.0\n");
    if (command === "gh auth status") return result(0, "authenticated\n");
    if (command === "gh api repos/lobsters/lobsters") {
      return result(0, JSON.stringify({ id: 123, full_name: "lobsters/lobsters", default_branch: "main", permissions: { push: true } }));
    }
    if (command.startsWith("gh api repos/lobsters/lobsters/branches/main/protection")) return result(0, "{}");
    if (command === "gh api user") return result(0, JSON.stringify({ login: "maintainer" }));
    return result(1, "", `unexpected command: ${command}`);
  }
}

test("CLI policy refusal retains one external terminal diagnostic without model calls or repository writes", () => {
  const cwd = createRepository("No unsupervised agentic tools.");
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-policy-log-"));
  try {
    const script = `
      import os from "node:os";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const realSpawn = childProcess.spawnSync;
      childProcess.spawnSync = (program, ...args) => program === "gh"
        ? { status: 1, stdout: "", stderr: "fixture has no GitHub access" }
        : realSpawn(program, ...args);
      os.homedir = () => process.argv[2];
      syncBuiltinESMExports();
      const { PiSdkRuntime } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/core/pi-sdk-runtime.ts")).href)});
      PiSdkRuntime.prototype.runSession = async () => { throw new Error("MODEL_MUST_NOT_RUN"); };
      const { main } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/cli.ts")).href)});
      process.chdir(process.argv[1]);
      try { await main([]); } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, cwd, configRoot], {
      cwd: path.resolve("."), encoding: "utf8", timeout: 20_000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /repository is not safe to analyze/);
    assert.doesNotMatch(child.stderr, /MODEL_MUST_NOT_RUN/);
    const logDir = path.join(configRoot, ".agentify/logs/agentify");
    assert.ok(fs.existsSync(logDir), "early refusal must retain an external audit diagnostic");
    const logs = fs.readdirSync(logDir);
    assert.equal(logs.length, 1);
    const events = fs.readFileSync(path.join(logDir, logs[0]!), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event: string; payload: string });
    assert.deepEqual(events.map((event) => event.event), ["agentify.run_end"]);
    const terminal = JSON.parse(events[0]!.payload);
    assert.equal(terminal.status, "error");
    assert.equal(terminal.exit_code, 1);
    assert.equal(terminal.files_written, 0);
    assert.equal(terminal.total_turns, 0);
    assert.equal(terminal.total_cost_usd, 0);
    assert.match(terminal.error_message, /repository_policy_prohibits_ai/);
    assert.match(terminal.error_message, /CONTRIBUTING.md/);
    assert.match(child.stdout, /audit log written to/);
    const status = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
    assert.equal(status.status, 0);
    assert.equal(status.stdout, "");
    assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
});

test("restrictive repository policy blocks analysis and installation before any persistent write", () => {
  const cwd = createRepository("Do not submit code written by LLM-powered coding tools because of uncertainty around their output's copyright.");
  try {
    const status = (): string => {
      const execution = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      return execution.stdout;
    };
    const before = status();
    const preflight = inspectRepositoryForInstallation({ cwd, runner: new PolicyRunner() });
    assert.equal(preflight.analysis_allowed, false);
    assert.equal(preflight.disposition, "blocked");
    assert.ok(preflight.blockers.some((blocker) => (
      String(blocker.code) === "repository_policy_prohibits_ai"
      && blocker.message.includes("CONTRIBUTING.md")
      && blocker.remediation.includes("maintainer")
    )));
    assert.throws(
      () => prepareOneTimeInstallationState(cwd, preflight),
      /preflight forbids analysis/i,
    );
    assert.equal(status(), before);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false);
    assert.equal(fs.existsSync(path.join(cwd, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "workflows", "agentify-issue.yml")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const policy of [
  "AI-assisted contributions are welcome when contributors review and test them.",
  "Do not commit credentials, including credentials suggested by AI tools.",
  "Project maintainers who do not follow or enforce the Code of Conduct in good faith may face temporary or permanent repercussions.",
  "Known AI-assisted code patterns are documented and welcome.",
  "No unsupervised deployments. Reviewed AI-assisted contributions are welcome.",
  "You may use AI tools to contribute when you review and understand the output.",
  "Contributing with LLM assistance is allowed. Do not commit credentials.",
]) {
  test(`non-prohibitive policy remains analyzable: ${policy}`, () => {
    const cwd = createRepository(policy);
    try {
      const preflight = inspectRepositoryForInstallation({ cwd, runner: new PolicyRunner() });
      assert.equal(preflight.analysis_allowed, true);
      assert.ok(!preflight.blockers.some((blocker) => String(blocker.code) === "repository_policy_prohibits_ai"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const [policyPath, policy] of [
  [".github/automated-contribution-policy.md", "Absolutely **no** unsupervised agentic tools."],
  ["docs/working-rules.md", "Autonomous coding agents are not allowed."],
  [".github/PULL_REQUEST_TEMPLATE.md", "Do not submit AI-generated pull requests."],
  ["docs/contributing.md", "Do not use LLM or AI tools to contribute at all."],
  ["CONTRIBUTING.md", "Contributing with AI tools is prohibited."],
] as const) {
  test(`policy discovery and autonomous-use prohibition precede writes: ${policyPath}`, () => {
    const cwd = createRepository(policy, policyPath);
    try {
      const preflight = inspectRepositoryForInstallation({ cwd, runner: new PolicyRunner() });
      assert.equal(preflight.analysis_allowed, false);
      assert.ok(preflight.blockers.some((blocker) => blocker.message.includes(policyPath)));
      assert.throws(() => prepareOneTimeInstallationState(cwd, preflight), /preflight forbids analysis/i);
      assert.equal(spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }).stdout, "");
      assert.equal(fs.existsSync(path.join(cwd, ".agentify")), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("source prose outside a policy surface does not become an authority", () => {
  const cwd = createRepository("No unsupervised agentic tools.", "app/example.md");
  try {
    const preflight = inspectRepositoryForInstallation({ cwd, runner: new PolicyRunner() });
    assert.equal(preflight.analysis_allowed, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
