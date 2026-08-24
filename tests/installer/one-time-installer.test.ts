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
  recognizedManagedInstallationPaths,
  repositoryTaskPolicySchemaStatus,
  repositoryValidationApprovalCurrent,
  type InstallerProcessRequest,
  type InstallerProcessResult,
  type InstallerProcessRunner,
  DEFAULT_INSTALLER_PROCESS_RUNNER,
} from "../../src/core/installer/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";
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
}

class InstallerAuditRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    const stateDir = options.spawnExplorerStateDir ?? ".agentify/runtime/audit";
    const destination = path.join(options.cwd, stateDir, "codebase_map.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const map = JSON.stringify(makeSpecialistFixtureMap(), null, 2)
      .replaceAll(".pi/", ".agents/");
    fs.writeFileSync(destination, `${map}\n`);
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
  // The evidence gate verifies quotations against the file, so the fixture
  // README must contain the excerpt the fixture map cites.
  fs.writeFileSync(path.join(cwd, "README.md"), "# Test fixture\n\nTest fixture evidence citation.\n");
  return cwd;
}

function ok(stdout = ""): InstallerProcessResult {
  return { status: 0, stdout, stderr: "", timedOut: false, errorMessage: null };
}

function failed(stderr: string, status = 1): InstallerProcessResult {
  return { status, stdout: "", stderr, timedOut: false, errorMessage: null };
}

function writeFixtureDist(packageRoot: string): void {
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  for (const name of ["task-runtime.mjs", "learning-runtime.mjs"]) {
    fs.writeFileSync(path.join(packageRoot, "dist", name), "// agentify:managed\n");
  }
  fs.writeFileSync(
    path.join(packageRoot, "dist", "runtime-inventory.json"),
    `${JSON.stringify({ schema_version: "1", files: [] }, null, 2)}\n`,
  );
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

interface FakeRunnerOptions {
  origin?: string;
  head?: string | null;
  contributionBranches?: ReadonlyArray<string>;
  branchLookup?: "error";
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
      if (key.startsWith("gh api repos/owner/repo/branches/") && !key.endsWith("/protection")) {
        if (options.branchLookup === "error") return failed("HTTP 500: Internal Server Error");
        const encoded = key.slice("gh api repos/owner/repo/branches/".length);
        const branch = decodeURIComponent(encoded);
        return options.contributionBranches?.includes(branch)
          ? ok(JSON.stringify({ name: branch }))
          : failed("HTTP 404: Not Found");
      }
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
    fs.writeFileSync(mapPath, `${JSON.stringify(makeSpecialistFixtureMap(), null, 2)}\n`);

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
      entry.code === "validation_failed" && /against the tree Agentify staged/.test(entry.message)
    )), `expected a staged validation failure; got ${JSON.stringify(report.blockers, null, 2)}`);
    assert.equal(report.github_issue_intake_enabled, false);
    // A refused installation must not leave memory that claims to be promoted.
    const memory = JSON.parse(
      fs.readFileSync(path.join(cwd, ".agentify/manifest.json"), "utf-8"),
    ) as { activation?: { state: string; disposition: string; promoted_at: string | null } };
    assert.equal(memory.activation?.state, "analysis_only");
    assert.equal(memory.activation?.disposition, "analyzable-only");
    assert.equal(memory.activation?.promoted_at, null);
    assert.equal(
      requests.some((request) => request.program === "gh" && request.args[0] === "label"),
      false,
    );
    const enabledWrites = requests
      .filter((request) => request.args.join(" ").startsWith("variable set AGENTIFY_ENABLED --body "))
      .map((request) => request.args[4]);
    // Disabled before the readiness checks and again after the rollback, so a
    // refused installation never leaves workflows enabled without their files.
    assert.ok(enabledWrites.length >= 1);
    assert.deepEqual([...new Set(enabledWrites)], ["false"]);
    for (const relative of [
      "AGENTS.md",
      "SETUP.md",
      ".github/agentify/task-runtime.mjs",
      ".github/agentify/learning-runtime.mjs",
      ".github/workflows/agentify-issue.yml",
      ".github/workflows/agentify-learn.yml",
    ]) {
      assert.equal(fs.existsSync(path.join(cwd, relative)), false, `${relative} must be rolled back`);
    }
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
      !refined.preflight.blockers.some((entry) => entry.code === "missing_deterministic_validation"),
      "the scaffolded verified command must clear the missing-validation blocker",
    );
    const asset = path.join(cwd, ".github", "agentify", "validation-smoke.mjs");
    assert.ok(fs.existsSync(asset), "validation smoke asset must be installed");
    assert.match(fs.readFileSync(asset, "utf-8"), /^#!\/usr\/bin\/env node\r?\n\/\/ agentify:managed\r?\n/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testFailedRepositoryValidationIsNotReplacedBySmoke(): Promise<void> {
  const cwd = tempRepo("agentify-installer-no-smoke-mask-", { test: "node --test" });
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd, { validationStatus: 1 }),
      runValidation: true,
    });
    assert.ok(preflight.blockers.some((entry) => entry.code === "validation_failed"));
    const refined = refinePreflightWithAudit({ cwd, preflight, map: null });
    assert.ok(refined.preflight.blockers.some((entry) => entry.code === "validation_failed"));
    assert.equal(
      refined.preflight.commands.some((command) => command.command_id === "test-agentify-validation-smoke"),
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testCompleteNodeValidationScriptIsPreferred(): Promise<void> {
  const cwd = tempRepo("agentify-installer-test-all-", {
    test: "node --test",
    "test-all": "node --test && npm run check",
    check: "eslint .",
  });
  try {
    const preflight = inspectRepositoryForInstallation({
      cwd,
      runner: fakeRunner(cwd),
      runValidation: false,
    });
    assert.deepEqual(
      preflight.commands.find((command) => command.kind === "test")?.argv,
      ["npm", "run", "test-all"],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testVerifiedContributionBranchMismatchBlocksActivation(): Promise<void> {
  const blocked = (
    label: string,
    configure: (map: ReturnType<typeof makeSpecialistFixtureMap>) => void,
    options: FakeRunnerOptions,
  ): void => {
    const cwd = tempRepo(`agentify-installer-branch-${label}-`);
    try {
      const runner = fakeRunner(cwd, options);
      const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
      const map = makeSpecialistFixtureMap();
      configure(map);
      const refined = refinePreflightWithAudit({ cwd, preflight, map, runner });
      assert.equal(refined.preflight.disposition, "analyzable-only", label);
      assert.ok(
        refined.preflight.blockers.some((entry) => entry.code === "unsupported_contribution_branch"),
        `${label}: expected an unsupported_contribution_branch blocker`,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };

  blocked("main-branch", (map) => {
    map.operational_surface.git_workflow.main_branch = "develop";
  }, { contributionBranches: ["develop"] });

  // The structured policy is authoritative even when main_branch is the default.
  blocked("structured", (map) => {
    map.operational_surface.git_workflow.contribution_branches = [{
      name: "develop",
      purpose: "pull_request_base",
      evidence: { path: "CONTRIBUTING.md", line_start: 15, line_end: 15 },
    }];
  }, { contributionBranches: ["develop"] });

  // Failing to verify must fail closed: publishing against the wrong base is
  // worse than refusing to activate.
  blocked("unverifiable", (map) => {
    map.operational_surface.git_workflow.main_branch = "develop";
  }, { branchLookup: "error" });

  // A documented branch the repository does not have is a stale or wrong-repository
  // policy, not permission to publish against the default branch instead.
  blocked("absent", (map) => {
    map.operational_surface.git_workflow.main_branch = "develop";
  }, { contributionBranches: [] });

  // The documented base matching the default branch is the only passing case.
  const cwd = tempRepo("agentify-installer-branch-match-");
  try {
    const runner = fakeRunner(cwd, { contributionBranches: ["main"] });
    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
    const map = makeSpecialistFixtureMap();
    map.operational_surface.git_workflow.main_branch = "main";
    const refined = refinePreflightWithAudit({ cwd, preflight, map, runner });
    assert.equal(
      refined.preflight.blockers.some((entry) => entry.code === "unsupported_contribution_branch"),
      false,
      "a contribution branch equal to the default branch must not block",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testControllerReadsOnlyFieldsTheInstallerEmits(): Promise<void> {
  const cwd = tempRepo("agentify-installer-policy-binding-");
  try {
    const preflight = inspectRepositoryForInstallation({ cwd, runner: fakeRunner(cwd), runValidation: true });
    const { configuration } = approvedConfiguration(cwd, preflight);
    assert.equal(configuration.configured, true);

    const controller = fs.readFileSync(
      path.join(installedPackageRoot(), "scaffold", ".github", "scripts", "run-task-lifecycle.mjs"),
      "utf-8",
    );

    // Every policy field the trusted controller reads without a fallback must
    // exist in the artifact the installer actually writes. A read of a field
    // the installer never emits is a check that silently never runs.
    const required = new Set<string>();
    for (const match of controller.matchAll(/policyConfig\??\.([A-Za-z_][A-Za-z0-9_]*)([^\n]*)/g)) {
      const field = match[1]!;
      const rest = match[2] ?? "";
      if (/^\s*(?:\?\?|\|\|)/.test(rest)) continue;
      required.add(field);
    }
    assert.ok(required.has("repository"), "the controller must bind the repository identity");
    const record = configuration as unknown as Record<string, unknown>;
    const missing = [...required].filter((field) => !(field in record)).sort();
    assert.deepEqual(missing, [], `controller reads policy fields the installer never emits: ${missing.join(", ")}`);

    // The nested identity comparison must resolve against the emitted shape.
    const identity = record.repository as Record<string, unknown> | null;
    assert.ok(identity);
    for (const field of ["repository_id", "full_name", "default_branch"]) {
      assert.equal(typeof identity[field], "string", `repository.${field} must be emitted as a string`);
      assert.ok(String(identity[field]).length > 0, `repository.${field} must not be empty`);
    }
    assert.equal("repository_id" in record, false, "identity must not be read from a nonexistent top-level field");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRepositoryValidationEnvironmentIsNotForcedMonochrome(): Promise<void> {
  const baseEnvironment = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const probe = "console.log(`NO_COLOR=${process.env.NO_COLOR ?? \"unset\"} CI=${process.env.CI ?? \"unset\"}`)";

  // NO_COLOR is a behavioral contract, not formatting. Forcing it on repository
  // validation makes a repository that implements NO_COLOR fail its own colour
  // tests, so Agentify would break the validation it is trying to verify.
  const validation = DEFAULT_INSTALLER_PROCESS_RUNNER.run({
    program: process.execPath,
    args: ["-e", probe],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    env: baseEnvironment,
  });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /NO_COLOR=unset/);
  assert.match(validation.stdout, /CI=1/);

  // An explicit NO_COLOR in the maintainer's own environment still passes through.
  const inherited = DEFAULT_INSTALLER_PROCESS_RUNNER.run({
    program: process.execPath,
    args: ["-e", probe],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    env: { ...baseEnvironment, NO_COLOR: "1" },
  });
  assert.match(inherited.stdout, /NO_COLOR=1/);
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
      automationSecret: {
        name: "AGENT_PAT",
        value: "also-never-on-command-line",
        explicitConsent: true,
      },
      runner: fakeRunner(cwd, { requests, legacyVariables: ["PI_VERSION", "AGENT_BOT_LOGIN"] }),
    });
    assert.ok(result.labels_configured >= 10);
    assert.ok(result.variables_configured.includes("AGENTIFY_REPOSITORY_ID"));
    assert.ok(result.variables_configured.includes("AGENTIFY_ENABLED"));
    assert.ok(!result.variables_configured.includes("PI_VERSION"));
    assert.ok(!result.variables_configured.includes("AGENT_BOT_LOGIN"));
    assert.equal(result.provider_secret_configured, "PI_API_KEY");
    assert.equal(result.automation_secret_configured, "AGENT_PAT");
    assert.ok(requests.some((request) => request.args.join(" ") === "variable delete PI_VERSION --repo owner/repo"));
    assert.ok(requests.some((request) => request.args.join(" ") === "variable delete AGENT_BOT_LOGIN --repo owner/repo"));
    assert.ok(requests.some((request) => request.args.join(" ") === "api --method PUT repos/owner/repo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true"));
    const secrets = requests.filter((request) => request.program === "gh" && request.args[0] === "secret");
    assert.equal(secrets.length, 2);
    assert.equal(secrets.find((request) => request.args.includes("PI_API_KEY"))?.input, "never-on-command-line");
    assert.equal(secrets.find((request) => request.args.includes("AGENT_PAT"))?.input, "also-never-on-command-line");
    assert.ok(secrets.every((request) => (
      !request.args.includes("never-on-command-line")
      && !request.args.includes("also-never-on-command-line")
    )));
    const enabledWrites = requests.filter((request) =>
      request.args.join(" ").startsWith("variable set AGENTIFY_ENABLED --body ")
    );
    assert.deepEqual(enabledWrites.map((request) => request.args[4]), ["false", "true"]);
    assert.ok(requests.indexOf(enabledWrites[1]!) > requests.indexOf(secrets.at(-1)!));
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
    fs.writeFileSync(mapPath, `${JSON.stringify(makeSpecialistFixtureMap(), null, 2)}\n`);
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
    const promotedMemory = JSON.parse(
      fs.readFileSync(path.join(cwd, ".agentify/manifest.json"), "utf-8"),
    ) as { activation?: { state: string; promoted_at: string | null } };
    assert.equal(promotedMemory.activation?.state, "promoted");
    assert.equal(typeof promotedMemory.activation?.promoted_at, "string");
    assert.ok(first.specialists_installed >= 1);
    assert.equal(
      first.specialist_warnings.some((warning) =>
        warning.startsWith("Critical specialist ownership is incomplete:")
      ),
      false,
    );
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
    const manifestAfter = fs.readFileSync(path.join(cwd, ".agentify/manifest.json"), "utf-8");
    if (manifestAfter !== manifestBefore) {
      const a = JSON.parse(manifestBefore) as Record<string, unknown>;
      const b = JSON.parse(manifestAfter) as Record<string, unknown>;
      const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
        .map((key) => `${key}: ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`);
      assert.fail(`manifest changed on idempotent rerun:\n${differing.join("\n").slice(0, 1200)}`);
    }
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
    writeFixtureDist(packageRoot);
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
    writeFixtureDist(packageRoot);
    prepareOneTimeInstallationState(cwd, preflight);
    const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, "{\"configured\":false}\n");
    const userWorkflow = path.join(cwd, ".github", "workflows", "agentify-issue.yml");
    fs.mkdirSync(path.dirname(userWorkflow), { recursive: true });
    fs.writeFileSync(userWorkflow, "name: user-owned\n");

    const knownManagedPaths = recognizedManagedInstallationPaths(cwd);
    assert.equal(knownManagedPaths.has(".github/agentify-task-policy.json"), true);
    assert.equal(knownManagedPaths.has(".github/workflows/agentify-issue.yml"), false);
    const repaired = installScaffoldRuntime({
      cwd,
      packageRoot,
      taskPolicyConfiguration: buildRepositoryTaskPolicyConfiguration(
        preflight,
        approvedConfiguration(cwd, preflight).approval,
        cwd,
      ),
      knownManagedPaths,
    });
    assert.ok(repaired.some((write) => write.action === "alongside"));
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
  { name: "installed files preserve repository validation", fn: testInstalledFilesMustPreserveValidation },
  { name: "no history blocks analysis", fn: testNoHistoryBlocksAnalysis },
  { name: "non-GitHub remote blocks analysis", fn: testNonGitHubRemoteBlocksAnalysis },
  { name: "unauthorized actor is analyzable only", fn: testUnauthorizedActorIsAnalyzableOnly },
  { name: "missing and unsafe validation", fn: testMissingAndUnsafeValidation },
  { name: "validation smoke scaffolded when missing", fn: testValidationSmokeScaffoldedWhenMissing },
  { name: "failed repository validation is not replaced by smoke", fn: testFailedRepositoryValidationIsNotReplacedBySmoke },
  { name: "complete Node validation script is preferred", fn: testCompleteNodeValidationScriptIsPreferred },
  { name: "verified contribution branch mismatch blocks activation", fn: testVerifiedContributionBranchMismatchBlocksActivation },
  { name: "controller reads only policy fields the installer emits", fn: testControllerReadsOnlyFieldsTheInstallerEmits },
  { name: "repository validation environment is not forced monochrome", fn: testRepositoryValidationEnvironmentIsNotForcedMonochrome },
  { name: "dependency validation requires lockfile", fn: testDependencyValidationRequiresLockfile },
  { name: "GitHub configuration and secret stdin", fn: testGitHubConfigurationAndSecretStdin },
  { name: "initial installation and idempotent attach", fn: testInitialInstallationAndIdempotentAttach },
  { name: "bootstrap evidence preserves tracked path casing", fn: testBootstrapEvidencePreservesTrackedPathCasing },
  { name: "one-command initial audit installation", fn: testOneCommandInitialAuditInstallation },
  { name: "user-owned workflow conflict fails closed", fn: testUserOwnedWorkflowConflictFailsClosed },
  { name: "drifted Agentify policy recognized as owned", fn: testDriftedAgentifyPolicyRecognizedAsOwned },
  { name: "recognized managed paths preserve a user workflow", fn: testRecognizedRuntimeRepairPreservesUserWorkflow },
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
