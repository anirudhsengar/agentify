import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildRepositoryTaskPolicyConfiguration,
  createRepositoryValidationApproval,
  configureGitHubInstallation,
  finalizeOneTimeInstallation,
  inspectRepositoryForInstallation,
  prepareOneTimeInstallationState,
  refinePreflightWithAudit,
  repairInstalledRuntime,
  repositoryTaskPolicySchemaStatus,
  repositoryValidationApprovalCurrent,
  type InstallerProcessRequest,
  type InstallerProcessResult,
  type InstallerProcessRunner,
  DEFAULT_INSTALLER_PROCESS_RUNNER,
} from "../../src/core/installer/index.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";
import { attestCodebaseMap } from "../fixtures/codebase-map.ts";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import { installScaffoldRuntime } from "../../src/core/scaffold-installer.ts";
import { packageRoot as installedPackageRoot } from "../../src/core/pi-sdk-runtime.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyUi,
} from "../../src/core/types.ts";

const HEAD = "a".repeat(40);

function approvedConfiguration(cwd: string, preflight: ReturnType<typeof inspectRepositoryForInstallation>) {
  const approval = createRepositoryValidationApproval({
    cwd,
    preflight,
    approvedBy: "maintainer",
    approvedAt: "2026-08-05T00:00:00.000Z",
  });
  return {
    approval,
    configuration: buildRepositoryTaskPolicyConfiguration(preflight, approval, cwd),
  };
}

class InstallerTestUi implements AgentifyUi {
  readonly messages: string[] = [];
  status(message: string): void { this.messages.push(message); }
  info(message: string): void { this.messages.push(message); }
  error(message: string): void { this.messages.push(message); }
  async promptSelect(): Promise<string> { throw new Error("installer test must not prompt"); }
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("installer test must not prompt"); }
  async promptCheckboxList(): Promise<ReadonlyArray<string>> { throw new Error("installer test must not prompt"); }
  async promptSecret(): Promise<string> { throw new Error("installer test must not prompt"); }
  async promptText(): Promise<string> { throw new Error("installer test must not prompt"); }
}

class InstallerAuditRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const stateDir = options.spawnExplorerStateDir ?? ".agentify/runtime/audit";
    const destination = path.join(options.cwd, stateDir, "codebase_map.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const fixtureMap = makeSpecialistFixtureMap();
    fixtureMap.concern_evidence?.concerns[0]?.touchpoints.push({
      path: "src/lib.ts",
      symbol: null,
      role: "Public package entry point owned by authentication in this fixture.",
      line_range: null,
      centrality: "supporting",
    });
    const map = JSON.stringify(fixtureMap, null, 2)
      .replaceAll(".pi/", ".agents/");
    fs.writeFileSync(destination, `${map}\n`);
    options.onEvent?.({
      type: "tool_execution_end",
      toolName: "spawn_explorer",
      resultText: "Sub-agent (mode=concern_scout) explored . in 1ms.\n\n## Report\n",
      details: {
        mode: "concern_scout",
        target_path: ".",
        focus: null,
        report_concern: null,
      },
    } as never);
    for (const concern of fixtureMap.concern_evidence?.concerns ?? []) {
      options.onEvent?.({
        type: "tool_execution_end",
        toolName: "spawn_explorer",
        resultText: `Sub-agent (mode=concern_tracer) explored . in 1ms.\n\n## Report\nconcern: ${concern.concern}\n`,
        details: {
          mode: "concern_tracer",
          target_path: ".",
          focus: concern.concern,
          report_concern: concern.concern,
        },
      } as never);
    }
    return { turns: 1, costUsd: 0, aborted: false };
  }
}

function tempRepo(prefix: string, scripts: Record<string, string> = {
  typecheck: "tsc --noEmit",
  test: "node --test",
}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "tests", "index.test.ts"), "// test\n");
  fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Test fixture\n");
  return cwd;
}

function ok(stdout = ""): InstallerProcessResult {
  return { status: 0, stdout, stderr: "", timedOut: false, errorMessage: null };
}

function failed(stderr: string, status = 1): InstallerProcessResult {
  return { status, stdout: "", stderr, timedOut: false, errorMessage: null };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

interface FakeRunnerOptions {
  origin?: string;
  head?: string | null;
  permission?: Record<string, boolean>;
  protection?: "protected" | "unprotected" | "unknown";
  validationStatus?: number;
  validationFailsAfterInstall?: boolean;
  requests?: InstallerProcessRequest[];
  legacyVariables?: ReadonlyArray<string>;
}

function fakeRunner(cwd: string, options: FakeRunnerOptions = {}): InstallerProcessRunner {
  return {
    run(request): InstallerProcessResult {
      options.requests?.push(request);
      const key = `${request.program} ${request.args.join(" ")}`;
      if (key === "git rev-parse --show-toplevel") return ok(cwd);
      if (key === "git rev-parse --verify HEAD^{commit}") {
        return options.head === null ? failed("unknown revision") : ok(options.head ?? HEAD);
      }
      if (key === "git branch --show-current") return ok("main\n");
      if (key === "git remote get-url origin") return ok(options.origin ?? "git@github.com:owner/repo.git\n");
      if (key === "git ls-files -z") {
        return ok("src/index.ts\0tests/index.test.ts\0package.json\0package-lock.json\0AGENTS.md\0SETUP.md\0.github/workflows/ci.yml\0");
      }
      if (key === "gh --version" || key === "gh auth status") return ok();
      if (key === "gh api repos/owner/repo") {
        return ok(JSON.stringify({
          id: 123,
          full_name: "owner/repo",
          default_branch: "main",
          permissions: options.permission ?? { admin: true, push: true, pull: true },
        }));
      }
      if (key === "gh api user") return ok(JSON.stringify({ login: "maintainer" }));
      if (key === "gh api repos/owner/repo/actions/permissions/workflow") {
        return ok(JSON.stringify({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false }));
      }
      if (key === "gh api --method PUT repos/owner/repo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true") {
        return ok();
      }
      if (key === "gh variable list --repo owner/repo --json name") {
        return ok(JSON.stringify((options.legacyVariables ?? []).map((name) => ({ name }))));
      }
      if (key === "gh api repos/owner/repo/branches/main/protection") {
        if (options.protection === "unknown") return failed("HTTP 403: Resource not accessible");
        if (options.protection === "unprotected") return failed("HTTP 404: Not Found");
        return ok("{}");
      }
      if (key.startsWith("npm run ")) {
        const status = options.validationFailsAfterInstall
          && fs.existsSync(path.join(cwd, ".github", "agentify", "task-runtime.mjs"))
          ? 1
          : options.validationStatus ?? 0;
        return status === 0 ? ok("passed\n") : failed("failed validation", status);
      }
      if (key.startsWith("gh label create ") || key.startsWith("gh variable set ") || key.startsWith("gh variable delete ") || key.startsWith("gh secret set ")) {
        return ok();
      }
      return failed(`unexpected command: ${key}`);
    },
  };
}

async function testInstalledFilesMustPreserveValidation(): Promise<void> {
  const cwd = tempRepo("agentify-installer-post-install-validation-");
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const requests: InstallerProcessRequest[] = [];
    const runner = fakeRunner(cwd, {
      head: commit,
      validationFailsAfterInstall: true,
      requests,
    });
    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
    assert.equal(preflight.disposition, "ready");
    prepareOneTimeInstallationState(cwd, preflight);
    const mapPath = path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(attestCodebaseMap(makeSpecialistFixtureMap(), commit), null, 2)}\n`);

    const report = finalizeOneTimeInstallation({
      cwd,
      preflight,
      agentifyVersion: "1.0.0",
      provider: "minimax",
      model: "MiniMax-M2.1",
      providerVerified: true,
      validationApproval: approvedConfiguration(cwd, preflight).approval,
      runner,
    });
    assert.equal(report.disposition, "analyzable-only");
    assert.ok(report.blockers.some((entry) => (
      entry.code === "validation_failed" && /after Agentify installed/.test(entry.message)
    )));
    assert.ok(report.blockers.some((entry) => (
      entry.code === "installation_canary_failed"
      && /Atomic installation rolled back/.test(entry.message)
      && /readiness blocker\(s\) reported above/.test(entry.remediation)
    )));
    assert.equal(report.specialists_installed, 0);
    assert.equal(report.github_issue_intake_enabled, false);
    assert.equal(report.procedures_installed, 0);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "agents")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "agentify-task-policy.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "agentify")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "scripts")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "workflows", "agentify-issue.yml")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "workflows", "agentify-learn.yml")), false);
    assert.equal(fs.existsSync(path.join(cwd, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(cwd, "SETUP.md")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github")), false);
    assert.equal(fs.existsSync(mapPath), true, "the externally permitted diagnostic map survives rollback");
    assert.equal(
      requests.some((request) => request.program === "gh" && request.args[0] === "label"),
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testValidationRunsInDisposableCheckout(): Promise<void> {
  const cwd = tempRepo("agentify-installer-validation-isolation-");
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const delegate = fakeRunner(cwd, { head: commit });
    const validationCwds: string[] = [];
    const runner: InstallerProcessRunner = {
      run(request): InstallerProcessResult {
        if (request.program === "npm" && request.args[0] === "run") {
          validationCwds.push(request.cwd);
          fs.mkdirSync(path.join(request.cwd, ".venv"), { recursive: true });
          fs.writeFileSync(path.join(request.cwd, ".venv", "validation-cache"), "generated\n");
        }
        return delegate.run(request);
      },
    };

    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });

    assert.equal(preflight.disposition, "ready");
    assert.ok(validationCwds.length > 0);
    assert.ok(validationCwds.every((validationCwd) => validationCwd !== cwd));
    assert.equal(
      fs.existsSync(path.join(cwd, ".venv")),
      false,
      "validation-generated ignored files must never enter the installation target",
    );
    assert.ok(validationCwds.every((validationCwd) => !fs.existsSync(validationCwd)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testEligibleRepositoryAndPolicy(): Promise<void> {
  const cwd = tempRepo("agentify-installer-eligible-");
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd),
      runValidation: true,
    });
    assert.equal(preflight.disposition, "ready");
    assert.equal(preflight.identity?.repository_id, "123");
    assert.equal(preflight.identity?.full_name, "owner/repo");
    assert.equal(preflight.identity?.default_branch, "main");
    assert.equal(preflight.identity?.current_commit, HEAD);
    assert.equal(preflight.identity?.actor_login, "maintainer");
    assert.deepEqual(preflight.allowed_write_paths, ["src", "tests"]);
    assert.ok(preflight.commands.some((command) => command.kind === "install" && command.assessment === "characterized"));
    assert.ok(preflight.commands.filter((command) => command.required).every((command) => command.assessment === "verified"));

    const configuration = approvedConfiguration(cwd, preflight).configuration;
    assert.equal(configuration.configured, true);
    assert.equal(configuration.policy?.approval_required, true);
    assert.equal(configuration.policy?.maximum_fix_cycles, 2);
    assert.deepEqual(configuration.policy?.allowed_write_paths, ["src", "tests"]);
    assert.ok(configuration.policy?.forbidden_actions.includes("application merge"));
    assert.equal(configuration.model_network_posture, "denied-by-default");
    assert.equal(configuration.dependency_change_policy, "maintainer-approval-required");
    assert.equal(configuration.protected_path_policy_known, true);
    assert.equal(configuration.validation_services_attested, true);
    assert.equal(configuration.validation_execution.network_isolation, "not-provided");
    assert.equal(configuration.validation_execution.os_sandbox, "not-provided");
    assert.equal(configuration.validation_approval?.approved_by, "maintainer");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testValidationApprovalBinding(): Promise<void> {
  const cwd = tempRepo("agentify-installer-validation-approval-", {
    typecheck: "tsc --noEmit",
    test: "npm run test:unit",
    "test:unit": "node --test",
  });
  try {
    const requests: InstallerProcessRequest[] = [];
    const characterized = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { requests }),
      runValidation: false,
    });
    assert.equal(characterized.disposition, "partially-ready");
    assert.equal(requests.some((request) => request.program === "npm"), false);
    assert.equal(buildRepositoryTaskPolicyConfiguration(characterized, null, cwd).configured, false);

    const approval = createRepositoryValidationApproval({
      cwd,
      preflight: characterized,
      approvedBy: "maintainer",
      approvedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight: characterized, approval }), true);

    const verified = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: true });
    const configured = buildRepositoryTaskPolicyConfiguration(verified, approval, cwd);
    assert.equal(configured.configured, true);
    assert.equal(configured.schema_version, "2");
    assert.equal(configured.validation_approval?.commands_sha256, approval.commands_sha256);

    const packagePath = path.join(cwd, "package.json");
    const originalPackage = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(originalPackage) as { scripts: Record<string, string> };
    parsed.scripts["test:unit"] = "node --test --test-reporter=spec";
    fs.writeFileSync(packagePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const nestedChanged = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: false });
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight: nestedChanged, approval }), false);

    fs.writeFileSync(packagePath, originalPackage);
    const metadata = JSON.parse(originalPackage) as Record<string, unknown>;
    metadata.description = "changed without modifying validation scripts";
    fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
    const manifestChanged = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: false });
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight: manifestChanged, approval }), false);

    fs.writeFileSync(packagePath, originalPackage);
    const direct = JSON.parse(originalPackage) as { scripts: Record<string, string> };
    direct.scripts.test = "node --test";
    fs.writeFileSync(packagePath, `${JSON.stringify(direct, null, 2)}\n`);
    const directChanged = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: false });
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight: directChanged, approval }), false);

    fs.writeFileSync(packagePath, originalPackage);
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "{\"changed\":true}\n");
    const lockChanged = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: false });
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight: lockChanged, approval }), false);

    fs.mkdirSync(path.join(cwd, ".github"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".github", "agentify-task-policy.json"), JSON.stringify({
      format: "agentify_task_policy_configuration",
      schema_version: "1",
      configured: true,
    }));
    assert.equal(repositoryTaskPolicySchemaStatus(cwd), "legacy");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testValidationEnvironmentRemovesCredentials(): Promise<void> {
  const cwd = tempRepo("agentify-installer-sanitized-env-");
  const beforeProvider = process.env.MINIMAX_API_KEY;
  const beforeGitHub = process.env.GH_TOKEN;
  try {
    process.env.MINIMAX_API_KEY = "provider-secret-placeholder";
    process.env.GH_TOKEN = "github-secret-placeholder";
    const result = DEFAULT_INSTALLER_PROCESS_RUNNER.run({
      program: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "process.exit(process.env.MINIMAX_API_KEY || process.env.GH_TOKEN ? 1 : 0)",
      ],
      cwd,
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-placeholder/);
  } finally {
    if (beforeProvider === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = beforeProvider;
    if (beforeGitHub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = beforeGitHub;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testNoHistoryBlocksAnalysis(): Promise<void> {
  const cwd = tempRepo("agentify-installer-no-history-");
  try {
    const preflight = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd, { head: null }) });
    assert.equal(preflight.disposition, "blocked");
    assert.equal(preflight.analysis_allowed, false);
    assert.ok(preflight.blockers.some((entry) => entry.code === "no_git_history"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testNonGitHubRemoteBlocksAnalysis(): Promise<void> {
  const cwd = tempRepo("agentify-installer-remote-");
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { origin: "git@gitlab.com:owner/repo.git" }),
    });
    assert.equal(preflight.disposition, "blocked");
    assert.ok(preflight.blockers.some((entry) => entry.code === "non_github_remote"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testUnauthorizedActorIsAnalyzableOnly(): Promise<void> {
  const cwd = tempRepo("agentify-installer-permission-");
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { permission: { pull: true }, protection: "unprotected" }),
      runValidation: true,
    });
    assert.equal(preflight.disposition, "analyzable-only");
    assert.ok(preflight.blockers.some((entry) => entry.code === "missing_github_permission"));
    const configuration = buildRepositoryTaskPolicyConfiguration(preflight);
    assert.equal(configuration.configured, false);
    assert.equal(configuration.protected_path_policy_known, false);
    assert.equal(configuration.validation_services_attested, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testMissingAndUnsafeValidation(): Promise<void> {
  const missing = tempRepo("agentify-installer-missing-validation-", { build: "tsc" });
  const unsafe = tempRepo("agentify-installer-unsafe-validation-", {
    test: "node test.js --url=$DATABASE_URL",
  });
  try {
    const missingResult = inspectRepositoryForInstallation({
      cwd: missing,
      runner: fakeRunner(missing),
      runValidation: true,
    });
    assert.ok(missingResult.blockers.some((entry) => entry.code === "missing_deterministic_validation"));
    const unsafeResult = inspectRepositoryForInstallation({
      cwd: unsafe,
      runner: fakeRunner(unsafe),
      runValidation: true,
    });
    assert.ok(unsafeResult.blockers.some((entry) => entry.code === "unsafe_production_credentials"));
    assert.equal(unsafeResult.commands.find((command) => command.kind === "test")?.assessment, "unsafe");
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(unsafe, { recursive: true, force: true });
  }
}

async function testValidationSmokeScaffoldedWhenMissing(): Promise<void> {
  const cwd = tempRepo("agentify-installer-validation-smoke-", { build: "tsc" });
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { head: git(cwd, "rev-parse", "HEAD") }),
      runValidation: true,
    });
    assert.ok(preflight.blockers.some((entry) => entry.code === "missing_deterministic_validation"));

    const refined = refinePreflightWithAudit({ cwd, preflight, map: null });
    const smoke = refined.preflight.commands.find(
      (command) => command.command_id === "test-agentify-validation-smoke",
    );
    assert.ok(smoke, "the validation smoke must be scaffolded when no repository command verifies");
    assert.equal(smoke.assessment, "verified");
    assert.equal(smoke.required, true);
    assert.deepEqual(smoke.argv, ["node", ".github/agentify/validation-smoke.mjs"]);
    assert.ok(
      refined.preflight.blockers.some((entry) => entry.code === "missing_deterministic_validation"),
      "the Agentify-owned smoke must not impersonate a repository test command",
    );
    assert.equal(refined.preflight.disposition, "analyzable-only");
    const asset = path.join(cwd, ".github", "agentify", "validation-smoke.mjs");
    assert.ok(fs.existsSync(asset), "validation smoke asset must be installed");
    assert.match(fs.readFileSync(asset, "utf-8"), /^#!\/usr\/bin\/env node\r?\n\/\/ agentify:managed\r?\n/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDependencyValidationRequiresLockfile(): Promise<void> {
  const cwd = tempRepo("agentify-installer-missing-lock-");
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify({
      scripts: { test: "ava" },
      devDependencies: { ava: "^5.2.0" },
    }, null, 2)}\n`);
    fs.rmSync(path.join(cwd, "package-lock.json"));
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd),
      runValidation: true,
    });
    assert.equal(preflight.disposition, "analyzable-only");
    assert.ok(preflight.blockers.some((entry) => entry.code === "missing_dependency_lock"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testGitHubConfigurationAndSecretStdin(): Promise<void> {
  const cwd = tempRepo("agentify-installer-github-");
  const requests: InstallerProcessRequest[] = [];
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd),
      runValidation: true,
    });
    assert.ok(preflight.identity);
    const result = configureGitHubInstallation({
      cwd,
      repository: preflight.identity,
      agentifyVersion: "1.0.0",
      provider: "minimax",
      model: "MiniMax-M2.1",
      providerSecret: {
        name: "PI_API_KEY",
        value: "never-on-command-line",
        explicitConsent: true,
      },
      credentialSecret: {
        name: "PI_AUTH_JSON",
        value: `${JSON.stringify({
          anthropic: { type: "oauth", refresh: "refresh-token", access: "access-token", expires: 4_000_000_000_000 },
        }, null, 2)}\n`,
        explicitConsent: true,
      },
      automationSecret: {
        name: "AGENT_PAT",
        value: "also-never-on-command-line",
        explicitConsent: true,
      },
      runner: fakeRunner(cwd, { requests, legacyVariables: ["PI_VERSION", "AGENT_BOT_LOGIN"] }),
    });
    assert.ok(result.labels_configured >= 10);
    assert.ok(result.variables_configured.includes("AGENTIFY_REPOSITORY_ID"));
    assert.ok(!result.variables_configured.includes("PI_VERSION"));
    assert.ok(!result.variables_configured.includes("AGENT_BOT_LOGIN"));
    assert.equal(result.provider_secret_configured, "PI_API_KEY");
    assert.equal(result.credential_secret_configured, "PI_AUTH_JSON");
    assert.equal(result.automation_secret_configured, "AGENT_PAT");
    assert.ok(requests.some((request) => request.args.join(" ") === "variable delete PI_VERSION --repo owner/repo"));
    assert.ok(requests.some((request) => request.args.join(" ") === "variable delete AGENT_BOT_LOGIN --repo owner/repo"));
    assert.ok(requests.some((request) => request.args.join(" ") === "api --method PUT repos/owner/repo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true"));
    const secrets = requests.filter((request) => request.program === "gh" && request.args[0] === "secret");
    assert.equal(secrets.length, 3);
    assert.equal(secrets.find((request) => request.args.includes("PI_API_KEY"))?.input, "never-on-command-line");
    assert.match(String(secrets.find((request) => request.args.includes("PI_AUTH_JSON"))?.input), /refresh-token/);
    assert.equal(secrets.find((request) => request.args.includes("AGENT_PAT"))?.input, "also-never-on-command-line");
    assert.ok(secrets.every((request) => (
      !request.args.includes("never-on-command-line")
      && !request.args.includes("also-never-on-command-line")
      && !request.args.includes("refresh-token")
    )));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testCredentialSecretValidation(): Promise<void> {
  const cwd = tempRepo("agentify-installer-auth-json-");
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd),
      runValidation: true,
    });
    assert.ok(preflight.identity);
    const configure = (value: string) => configureGitHubInstallation({
      cwd,
      repository: preflight.identity!,
      agentifyVersion: "1.0.0",
      provider: "anthropic",
      model: "claude-sonnet",
      credentialSecret: { name: "PI_AUTH_JSON", value, explicitConsent: true },
      runner: fakeRunner(cwd),
    });
    assert.equal(configure(`${JSON.stringify({ anthropic: { type: "api_key", key: "sk" } })}\n`).credential_secret_configured, "PI_AUTH_JSON");
    assert.throws(() => configure("not json"), /not valid JSON/);
    assert.throws(() => configure(JSON.stringify(["anthropic"])), /provider credential object/);
    assert.throws(() => configure(""), /bounded size/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testInitialInstallationAndIdempotentAttach(): Promise<void> {
  const cwd = tempRepo("agentify-installer-finalize-");
  try {
    for (const relative of [
      "src/lib.ts",
      "src/billing/index.ts",
      "src/billing/types.ts",
      "tests/billing.test.ts",
      "scripts/prime-db.sh",
    ]) {
      const destination = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, `${relative}\n`);
    }
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const runner = fakeRunner(cwd, { head: commit });
    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
    assert.equal(preflight.disposition, "ready");
    prepareOneTimeInstallationState(cwd, preflight);

    const mapPath = path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(attestCodebaseMap(makeSpecialistFixtureMap(), commit), null, 2)}\n`);
    for (const relative of [
      ".github/workflows/agentify-issue.yml",
      ".github/workflows/agentify-learn.yml",
    ]) {
      const destination = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "# agentify:managed\nname: fixture\n");
    }
    for (const relative of [
      ".github/agentify/task-runtime.mjs",
      ".github/agentify/learning-runtime.mjs",
    ]) {
      const destination = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "// agentify:managed\n");
    }
    const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
    const approved = approvedConfiguration(cwd, preflight);
    fs.writeFileSync(policyPath, `${JSON.stringify(approved.configuration, null, 2)}\n`);

    const first = finalizeOneTimeInstallation({
      cwd,
      preflight,
      agentifyVersion: "1.0.0",
      provider: "minimax",
      model: "MiniMax-M2.1",
      providerVerified: true,
      validationApproval: approved.approval,
      runner,
    });
    assert.equal(first.disposition, "ready");
    assert.equal(first.specialists_installed, 1);
    assert.ok(first.procedures_installed > 0);
    assert.ok(fs.existsSync(path.join(cwd, ".agentify/manifest.json")));
    for (const relative of [
      ".agentify/agents/orchestrator.json",
      ".agentify/agents/roles/builder.json",
      ".agentify/agents/roles/reviewer.json",
      ".agentify/agents/roles/knowledge-maintainer.json",
    ]) assert.ok(fs.existsSync(path.join(cwd, relative)), relative);

    const manifestBefore = fs.readFileSync(path.join(cwd, ".agentify/manifest.json"), "utf-8");
    const second = finalizeOneTimeInstallation({
      cwd,
      preflight,
      agentifyVersion: "1.0.0",
      provider: "minimax",
      model: "MiniMax-M2.1",
      providerVerified: true,
      validationApproval: approved.approval,
      runner,
    });
    assert.equal(second.disposition, "ready");
    assert.equal(fs.readFileSync(path.join(cwd, ".agentify/manifest.json"), "utf-8"), manifestBefore);
    const unsupportedProvider = finalizeOneTimeInstallation({
      cwd,
      preflight,
      agentifyVersion: "1.0.0",
      provider: null,
      model: null,
      providerVerified: false,
      validationApproval: approved.approval,
      runner,
    });
    assert.equal(unsupportedProvider.disposition, "analyzable-only");
    assert.ok(unsupportedProvider.blockers.some((entry) => entry.code === "unsupported_provider_or_model"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testBootstrapEvidencePreservesTrackedPathCasing(): Promise<void> {
  const cwd = tempRepo("agentify-installer-path-casing-");
  try {
    fs.writeFileSync(path.join(cwd, "readme.md"), "# Lowercase tracked README\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { head: commit }),
      runValidation: true,
    });
    prepareOneTimeInstallationState(cwd, preflight);
    const orchestrator = JSON.parse(
      fs.readFileSync(path.join(cwd, ".agentify/agents/orchestrator.json"), "utf-8"),
    ) as { evidence: Array<{ repository_path: string | null }> };
    assert.equal(orchestrator.evidence[0]?.repository_path, "readme.md");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testOneCommandInitialAuditInstallation(): Promise<void> {
  const cwd = tempRepo("agentify-installer-one-command-");
  try {
    for (const relative of [
      "src/lib.ts",
      ...SPECIALIST_FIXTURE_TRACKED_FILES,
      "src/billing/types.ts",
      "scripts/prime-db.sh",
    ]) {
      const destination = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, `${relative}\n`);
    }
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const runner = fakeRunner(cwd, { head: commit });
    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
    assert.equal(preflight.disposition, "ready");
    prepareOneTimeInstallationState(cwd, preflight);

    const ui = new InstallerTestUi();
    await runAgentifyApp({
      args: [],
      cwd,
      ui,
      runtime: new InstallerAuditRuntime(),
      configOverride: {
        schemaVersion: 1,
        provider: "minimax",
        thinkingLevel: "high",
        models: { primary: { provider: "minimax", model: "MiniMax-M2.1" } },
      },
    });
    const report = finalizeOneTimeInstallation({
      cwd,
      preflight,
      agentifyVersion: "1.0.0",
      provider: "minimax",
      model: "MiniMax-M2.1",
      providerVerified: true,
      validationApproval: approvedConfiguration(cwd, preflight).approval,
      runner,
    });
    assert.equal(report.disposition, "ready", JSON.stringify(report.blockers, null, 2));
    const policyPath = path.join(cwd, ".github/agentify-task-policy.json");
    assert.ok(fs.existsSync(policyPath), ui.messages.join("\n"));
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8")) as {
      configured: boolean;
    };
    assert.equal(policy.configured, true);
    assert.ok(fs.existsSync(path.join(cwd, ".github/workflows/agentify-issue.yml")));
    assert.ok(fs.existsSync(path.join(cwd, ".github/workflows/agentify-learn.yml")));
    assert.ok(fs.existsSync(path.join(cwd, ".agentify/manifest.json")));
    assert.ok(installedPackageRoot().length > 0);

    fs.writeFileSync(path.join(cwd, ".gitignore"), ".agentify/\n");
    const ignoredMap = finalizeOneTimeInstallation({
      cwd,
      preflight,
      agentifyVersion: "1.0.0",
      provider: "minimax",
      model: "MiniMax-M2.1",
      validationApproval: approvedConfiguration(cwd, preflight).approval,
      providerVerified: true,
      runner,
    });
    assert.equal(ignoredMap.disposition, "analyzable-only");
    assert.ok(ignoredMap.blockers.some((entry) =>
      entry.code === "installation_canary_failed"
      && entry.message.includes("canonical-audit-map-versioned")
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testUserOwnedWorkflowConflictFailsClosed(): Promise<void> {
  const cwd = tempRepo("agentify-installer-workflow-conflict-");
  try {
    const preflight = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: true });
    const workflow = path.join(cwd, ".github", "workflows", "agentify-issue.yml");
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    fs.writeFileSync(workflow, "name: user-owned\n");
    assert.equal(fs.readFileSync(workflow, "utf-8"), "name: user-owned\n");
    const configuration = buildRepositoryTaskPolicyConfiguration({ ...preflight, disposition: "analyzable-only" });
    assert.equal(configuration.configured, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDriftedAgentifyPolicyRecognizedAsOwned(): Promise<void> {
  const cwd = tempRepo("agentify-policy-drift-");
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-policy-package-"));
  try {
    fs.mkdirSync(path.join(packageRoot, "scaffold", ".github"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "scaffold", ".github", "agentify-task-policy.json"), "{}\n");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    for (const name of ["task-runtime.mjs", "learning-runtime.mjs"]) {
      fs.writeFileSync(path.join(packageRoot, "dist", name), "// agentify:managed\n");
    }
    const preflight = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: true });
    const configuration = approvedConfiguration(cwd, preflight).configuration;
    const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });

    // A drifted but Agentify-written policy (for example a fail-closed
    // placeholder left by an interrupted install) is overwritten, not
    // preserved as a user conflict.
    fs.writeFileSync(policyPath, `${JSON.stringify({
      format: "agentify_task_policy_configuration",
      schema_version: "2",
      configured: false,
      repository: null,
    })}\n`);
    const repaired = installScaffoldRuntime({ cwd, packageRoot, taskPolicyConfiguration: configuration });
    const policyWrite = repaired.find((write) => write.path === policyPath);
    assert.equal(policyWrite?.action, "written");
    assert.ok(!repaired.some((write) => write.action === "alongside"), JSON.stringify(repaired));
    const written = JSON.parse(fs.readFileSync(policyPath, "utf-8")) as { configured: boolean };
    assert.equal(written.configured, true);

    // A non-Agentify JSON document at the same path still fails closed.
    fs.writeFileSync(policyPath, "{\"configured\":false}\n");
    const conflicted = installScaffoldRuntime({ cwd, packageRoot, taskPolicyConfiguration: configuration });
    const conflictWrite = conflicted.find((write) => write.path === policyPath);
    assert.equal(conflictWrite?.action, "alongside");
    assert.equal(fs.readFileSync(policyPath, "utf-8"), "{\"configured\":false}\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
}

async function testRecognizedRuntimeRepairPreservesUserWorkflow(): Promise<void> {
  const cwd = tempRepo("agentify-installer-repair-");
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-installer-package-"));
  try {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { head: commit }),
      runValidation: true,
    });
    const scaffoldFiles: Record<string, string> = {
      ".github/workflows/agentify-issue.yml": "# agentify:managed\nname: issue\n",
      ".github/workflows/agentify-learn.yml": "# agentify:managed\nname: learn\n",
      ".github/agentify-task-policy.json": "{}\n",
      "SETUP.md": "<!-- agentify:managed -->\nsetup\n",
    };
    for (const [relative, content] of Object.entries(scaffoldFiles)) {
      const destination = path.join(packageRoot, "scaffold", relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    for (const name of ["task-runtime.mjs", "learning-runtime.mjs"]) {
      const destination = path.join(packageRoot, "dist", name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "// agentify:managed\n");
    }
    prepareOneTimeInstallationState(cwd, preflight);
    const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, "{\"configured\":false}\n");
    const userWorkflow = path.join(cwd, ".github", "workflows", "agentify-issue.yml");
    fs.mkdirSync(path.dirname(userWorkflow), { recursive: true });
    fs.writeFileSync(userWorkflow, "name: user-owned\n");

    const repair = repairInstalledRuntime({
      cwd,
      packageRoot,
      agentifyVersion: "1.0.0",
      preflight,
      validationApproval: approvedConfiguration(cwd, preflight).approval,
    });
    assert.equal(repair.status, "conflict");
    assert.equal(fs.readFileSync(userWorkflow, "utf-8"), "name: user-owned\n");
    assert.ok(fs.existsSync(path.join(cwd, ".github/workflows/agentify-issue.agentify.yml")));
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8")) as { configured: boolean };
    assert.equal(policy.configured, true);
    assert.ok(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "eligible repository and policy", fn: testEligibleRepositoryAndPolicy },
  { name: "validation approval binding", fn: testValidationApprovalBinding },
  { name: "validation environment removes credentials", fn: testValidationEnvironmentRemovesCredentials },
  { name: "validation runs in disposable checkout", fn: testValidationRunsInDisposableCheckout },
  { name: "installed files preserve repository validation", fn: testInstalledFilesMustPreserveValidation },
  { name: "no history blocks analysis", fn: testNoHistoryBlocksAnalysis },
  { name: "non-GitHub remote blocks analysis", fn: testNonGitHubRemoteBlocksAnalysis },
  { name: "unauthorized actor is analyzable only", fn: testUnauthorizedActorIsAnalyzableOnly },
  { name: "missing and unsafe validation", fn: testMissingAndUnsafeValidation },
  { name: "validation smoke scaffolded when missing", fn: testValidationSmokeScaffoldedWhenMissing },
  { name: "dependency validation requires lockfile", fn: testDependencyValidationRequiresLockfile },
  { name: "GitHub configuration and secret stdin", fn: testGitHubConfigurationAndSecretStdin },
  { name: "PI_AUTH_JSON credential secret validation", fn: testCredentialSecretValidation },
  { name: "initial installation and idempotent attach", fn: testInitialInstallationAndIdempotentAttach },
  { name: "bootstrap evidence preserves tracked path casing", fn: testBootstrapEvidencePreservesTrackedPathCasing },
  { name: "one-command initial audit installation", fn: testOneCommandInitialAuditInstallation },
  { name: "user-owned workflow conflict fails closed", fn: testUserOwnedWorkflowConflictFailsClosed },
  { name: "drifted Agentify policy recognized as owned", fn: testDriftedAgentifyPolicyRecognizedAsOwned },
  { name: "recognized runtime repair preserves user workflow", fn: testRecognizedRuntimeRepairPreservesUserWorkflow },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  }
}
console.log(`one-time installer tests passed (${passed}/${tests.length}).`);
