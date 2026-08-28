import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

function createRepository(policy: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-restrictive-policy-"));
  fs.mkdirSync(path.join(cwd, "app"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Community application\n");
  fs.writeFileSync(path.join(cwd, "app", "story.rb"), "class Story\nend\n");
  fs.writeFileSync(path.join(cwd, "Gemfile"), "source 'https://rubygems.org'\n");
  fs.writeFileSync(path.join(cwd, "Gemfile.lock"), "GEM\n\nBUNDLED WITH\n   2.6.0\n");
  fs.writeFileSync(
    path.join(cwd, "CONTRIBUTING.md"),
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
