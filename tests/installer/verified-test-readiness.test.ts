import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildRepositoryTaskPolicyConfiguration,
  discoverRepositoryCommands,
  refinePreflightWithAudit,
  type InstallerProcessRunner,
  type RepositoryInstallationPreflight,
} from "../../src/core/installer/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

const COMMIT = "a".repeat(40);

function repositoryIdentity() {
  return {
    repository_id: "123",
    full_name: "owner/repo",
    default_branch: "main",
    current_commit: COMMIT,
    current_branch: "main",
    origin_url: "https://github.com/owner/repo.git",
    actor_login: "maintainer",
    actor_permission: "admin" as const,
    default_branch_policy: "protected" as const,
  };
}

function fixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-verified-test-"));
  fs.writeFileSync(path.join(cwd, "Makefile"), "fmt:\n\t@true\n\ntest:\n\t@true\n");
  const git = (...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("config", "user.name", "Agentify Test").status, 0);
  assert.equal(git("config", "user.email", "agentify@example.invalid").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "-qm", "fixture").status, 0);
  return cwd;
}

function runner(passing: ReadonlySet<string>): InstallerProcessRunner {
  return {
    run(request) {
      const command = `${request.program} ${request.args.join(" ")}`;
      const success = passing.has(command);
      return {
        status: success ? 0 : 1,
        stdout: success ? "passed\n" : "",
        stderr: success ? "" : "failed\n",
        timedOut: false,
        errorMessage: null,
      };
    },
  };
}

function preflight(commands: RepositoryInstallationPreflight["commands"]): RepositoryInstallationPreflight {
  return {
    disposition: "analyzable-only",
    analysis_allowed: true,
    identity: repositoryIdentity(),
    commands,
    allowed_write_paths: ["src"],
    protected_paths: [".git", "Makefile"],
    blockers: [{
      code: "validation_failed",
      message: "validation failed",
      remediation: "repair validation",
    }],
  };
}


test("command discovery keeps a passing lint-only repository fail-closed", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-lint-only-"));
  try {
    fs.writeFileSync(path.join(cwd, "Makefile"), "lint:\n\t@true\n");
    const discovered = discoverRepositoryCommands(
      cwd,
      runner(new Set(["make lint"])),
      true,
    );
    assert.ok(discovered.commands.some((command) =>
      command.kind === "lint" && command.assessment === "verified"
    ));
    assert.ok(discovered.blockers.some((blocker) =>
      blocker.code === "missing_deterministic_validation"
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a verified formatter cannot establish repository readiness", () => {
  const cwd = fixture();
  try {
    const map = makeSpecialistFixtureMap();
    map.validation_surface.test_command = "make test";
    map.validation_surface.per_change_type.feature.mandatory = ["make fmt"];
    const refined = refinePreflightWithAudit({
      cwd,
      map,
      runner: runner(new Set(["make fmt"])),
      preflight: preflight([{
        command_id: "lint-make-fmt",
        kind: "lint",
        argv: ["make", "fmt"],
        cwd: ".",
        timeout_ms: 60_000,
        required: true,
        assessment: "verified",
        exit_code: 0,
        output_digest: "b".repeat(64),
        detail: "formatter passed",
      }]),
    });
    assert.equal(refined.preflight.disposition, "analyzable-only");
    assert.equal(refined.validationApproval, null);
    assert.ok(refined.preflight.blockers.some((blocker) =>
      blocker.code === "missing_deterministic_validation"
    ));
    assert.equal(
      buildRepositoryTaskPolicyConfiguration(refined.preflight, null, cwd).configured,
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a passing audited test replaces a failed test and closes readiness", () => {
  const cwd = fixture();
  try {
    const map = makeSpecialistFixtureMap();
    map.validation_surface.test_command = "make test";
    map.validation_surface.per_change_type.feature.mandatory = ["make fmt"];
    const refined = refinePreflightWithAudit({
      cwd,
      map,
      runner: runner(new Set(["make test"])),
      preflight: preflight([
        {
          command_id: "test-go-test",
          kind: "test",
          argv: ["go", "test", "./..."],
          cwd: ".",
          timeout_ms: 60_000,
          required: true,
          assessment: "failed",
          exit_code: 1,
          output_digest: "c".repeat(64),
          detail: "failed",
        },
        {
          command_id: "lint-make-fmt",
          kind: "lint",
          argv: ["make", "fmt"],
          cwd: ".",
          timeout_ms: 60_000,
          required: true,
          assessment: "verified",
          exit_code: 0,
          output_digest: "d".repeat(64),
          detail: "formatter passed",
        },
      ]),
    });
    assert.equal(refined.preflight.disposition, "ready");
    assert.ok(refined.validationApproval);
    assert.ok(refined.preflight.commands.some((command) =>
      command.kind === "test"
      && command.assessment === "verified"
      && command.argv.join(" ") === "make test"
    ));
    assert.ok(!refined.preflight.commands.some((command) =>
      command.kind === "test" && command.assessment === "failed"
    ));
    assert.equal(
      buildRepositoryTaskPolicyConfiguration(
        refined.preflight,
        refined.validationApproval,
        cwd,
      ).configured,
      true,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("audited validation is confined to a disposable checkout", () => {
  const cwd = fixture();
  try {
    const map = makeSpecialistFixtureMap();
    map.validation_surface.test_command = "make test";
    const validationCwds: string[] = [];
    const mutatingRunner: InstallerProcessRunner = {
      run(request) {
        validationCwds.push(request.cwd);
        fs.mkdirSync(path.join(request.cwd, ".cache"), { recursive: true });
        fs.writeFileSync(path.join(request.cwd, ".cache", "generated"), "residue\n");
        return {
          status: 0,
          stdout: "passed\n",
          stderr: "",
          timedOut: false,
          errorMessage: null,
        };
      },
    };
    const refined = refinePreflightWithAudit({
      cwd,
      map,
      runner: mutatingRunner,
      preflight: preflight([{
        command_id: "test-existing-failure",
        kind: "test",
        argv: ["false"],
        cwd: ".",
        timeout_ms: 60_000,
        required: true,
        assessment: "failed",
        exit_code: 1,
        output_digest: "a".repeat(64),
        detail: "failed",
      }]),
    });
    assert.equal(refined.preflight.disposition, "ready");
    assert.ok(validationCwds.length > 0);
    assert.ok(validationCwds.every((validationCwd) => validationCwd !== cwd));
    assert.ok(validationCwds.every((validationCwd) => !fs.existsSync(validationCwd)));
    assert.equal(fs.existsSync(path.join(cwd, ".cache")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a passing audited test does not mask a failed required linter", () => {
  const cwd = fixture();
  try {
    const map = makeSpecialistFixtureMap();
    map.validation_surface.test_command = "make test";
    const refined = refinePreflightWithAudit({
      cwd,
      map,
      runner: runner(new Set(["make test"])),
      preflight: preflight([
        {
          command_id: "test-go-test",
          kind: "test",
          argv: ["go", "test", "./..."],
          cwd: ".",
          timeout_ms: 60_000,
          required: true,
          assessment: "failed",
          exit_code: 1,
          output_digest: "e".repeat(64),
          detail: "test failed",
        },
        {
          command_id: "lint-golangci",
          kind: "lint",
          argv: ["golangci-lint", "run"],
          cwd: ".",
          timeout_ms: 60_000,
          required: true,
          assessment: "failed",
          exit_code: 1,
          output_digest: "f".repeat(64),
          detail: "lint failed",
        },
      ]),
    });
    assert.equal(refined.preflight.disposition, "analyzable-only");
    assert.equal(refined.validationApproval, null);
    assert.ok(refined.preflight.commands.some((command) =>
      command.kind === "test" && command.assessment === "verified"
    ));
    assert.ok(refined.preflight.commands.some((command) =>
      command.kind === "lint" && command.assessment === "failed"
    ));
    assert.ok(refined.preflight.blockers.some((blocker) =>
      blocker.code === "validation_failed"
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
