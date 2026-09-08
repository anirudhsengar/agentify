import * as fs from "node:fs";
import * as path from "node:path";
import type {
  InspectRepositoryOptions,
  InstallerBlocker,
  InstallerDisposition,
  InstallerProcessResult,
  RepositoryInstallationIdentity,
  RepositoryInstallationPreflight,
} from "./contracts.ts";
import { discoverRepositoryCommands } from "./command-discovery.ts";
import {
  conciseProcessFailure,
  DEFAULT_INSTALLER_PROCESS_RUNNER,
} from "./process-runner.ts";
import { detectRestrictiveRepositoryPolicy } from "./repository-policy.ts";

interface GitHubRepositoryResponse {
  id?: unknown;
  full_name?: unknown;
  default_branch?: unknown;
  permissions?: unknown;
}

interface GitHubUserResponse {
  login?: unknown;
}

const PROTECTED_PATHS = [
  ".git",
  ".github/workflows",
  ".github/agentify",
  ".github/agentify-task-policy.json",
  ".agentify/policies",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  "Gemfile",
  "Gemfile.lock",
  "Makefile",
  "makefile",
  "AGENTS.md",
  "SETUP.md",
] as const;

function blocker(
  code: InstallerBlocker["code"],
  message: string,
  remediation: string,
): InstallerBlocker {
  return { code, message, remediation };
}

function successful(result: InstallerProcessResult): boolean {
  return result.status === 0 && !result.timedOut && result.errorMessage === null;
}

function normalizeRemote(value: string): string | null {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const match = /github\.com(?::|\/)([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function parseRepositoryResponse(value: string): GitHubRepositoryResponse | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as GitHubRepositoryResponse
      : null;
  } catch {
    return null;
  }
}

function parseUserLogin(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as GitHubUserResponse;
    return parsed && typeof parsed.login === "string" && parsed.login.trim()
      ? parsed.login.trim()
      : null;
  } catch {
    return null;
  }
}

function actorPermission(value: unknown): RepositoryInstallationIdentity["actor_permission"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "none";
  const permissions = value as Record<string, unknown>;
  if (permissions.admin === true) return "admin";
  if (permissions.maintain === true) return "maintain";
  if (permissions.push === true) return "write";
  if (permissions.triage === true) return "triage";
  if (permissions.pull === true) return "read";
  return "none";
}

function trackedWritePaths(cwd: string, trackedOutput: string): string[] {
  const candidates = new Set<string>();
  for (const raw of trackedOutput.split("\0")) {
    const relative = raw.trim().replaceAll("\\", "/");
    if (!relative) continue;
    const first = relative.split("/")[0]!;
    if (first.startsWith(".")) continue;
    if (PROTECTED_PATHS.some((protectedPath) => (
      relative === protectedPath || relative.startsWith(`${protectedPath}/`)
    ))) continue;
    const candidate = relative.includes("/") ? first : relative;
    try {
      const stat = fs.lstatSync(path.join(cwd, candidate));
      if (stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left.localeCompare(right));
}

function dispositionFor(
  analysisAllowed: boolean,
  identity: RepositoryInstallationIdentity | null,
  blockers: ReadonlyArray<InstallerBlocker>,
  validationExecuted: boolean,
): InstallerDisposition {
  if (!analysisAllowed) return "blocked";
  if (blockers.length > 0 || identity === null) return "analyzable-only";
  return validationExecuted ? "ready" : "partially-ready";
}

export function inspectRepositoryForInstallation(
  options: InspectRepositoryOptions,
): RepositoryInstallationPreflight {
  const cwd = fs.realpathSync.native(path.resolve(options.cwd));
  const runner = options.runner ?? DEFAULT_INSTALLER_PROCESS_RUNNER;
  const blockers: InstallerBlocker[] = [];
  let analysisAllowed = true;

  const root = runner.run({ program: "git", args: ["rev-parse", "--show-toplevel"], cwd, timeoutMs: 10_000 });
  if (!successful(root)) {
    return {
      disposition: "blocked",
      analysis_allowed: false,
      identity: null,
      commands: [],
      allowed_write_paths: [],
      protected_paths: [...PROTECTED_PATHS],
      blockers: [blocker(
        "not_git_repository",
        "The target is not an existing Git repository.",
        "Run Agentify from the root of an existing cloned GitHub repository.",
      )],
    };
  }
  let reportedRoot: string;
  try {
    reportedRoot = fs.realpathSync.native(path.resolve(root.stdout.trim()));
  } catch {
    reportedRoot = path.resolve(root.stdout.trim());
  }
  if (reportedRoot.toLowerCase() !== cwd.toLowerCase()) {
    blockers.push(blocker(
      "repository_root_mismatch",
      `Agentify was invoked from ${cwd}, but the Git repository root is ${reportedRoot}.`,
      "Run Agentify from the repository root so every ownership boundary is unambiguous.",
    ));
    analysisAllowed = false;
  }

  const head = runner.run({ program: "git", args: ["rev-parse", "--verify", "HEAD^{commit}"], cwd, timeoutMs: 10_000 });
  if (!successful(head) || !/^[0-9a-f]{40,64}$/i.test(head.stdout.trim())) {
    blockers.push(blocker(
      "no_git_history",
      "The repository does not have a valid committed HEAD.",
      "Create at least one reviewed commit before installing Agentify.",
    ));
    analysisAllowed = false;
  }
  const branch = runner.run({ program: "git", args: ["branch", "--show-current"], cwd, timeoutMs: 10_000 });
  const origin = runner.run({ program: "git", args: ["remote", "get-url", "origin"], cwd, timeoutMs: 10_000 });
  const normalizedOrigin = successful(origin) ? normalizeRemote(origin.stdout) : null;
  if (!normalizedOrigin) {
    blockers.push(blocker(
      "non_github_remote",
      "The canonical origin remote is missing or is not hosted on GitHub.",
      "Configure exactly one canonical GitHub repository as the origin remote.",
    ));
    analysisAllowed = false;
  }

  const tracked = runner.run({ program: "git", args: ["ls-files", "-z"], cwd, timeoutMs: 20_000 });
  const trackedPaths = successful(tracked)
    ? tracked.stdout.split("\0").filter((candidate) => candidate.length > 0)
    : [];
  const restrictivePolicy = successful(tracked)
    ? detectRestrictiveRepositoryPolicy(cwd, trackedPaths)
    : null;
  if (restrictivePolicy !== null) {
    blockers.push(blocker(
      "repository_policy_prohibits_ai",
      `Tracked repository policy ${restrictivePolicy.path} explicitly prohibits AI/LLM-authored persistent repository work: ${restrictivePolicy.summary}`,
      "A repository maintainer must change or explicitly supersede that tracked policy before Agentify may analyze, generate diagnostics, or install files.",
    ));
    analysisAllowed = false;
  }

  const ghVersion = runner.run({ program: "gh", args: ["--version"], cwd, timeoutMs: 10_000 });
  if (!successful(ghVersion)) {
    blockers.push(blocker(
      "github_cli_unavailable",
      "GitHub CLI is unavailable.",
      "Install GitHub CLI and authenticate it with repository administration access.",
    ));
  }
  const ghAuth = successful(ghVersion)
    ? runner.run({ program: "gh", args: ["auth", "status"], cwd, timeoutMs: 15_000 })
    : null;
  if (ghAuth && !successful(ghAuth)) {
    blockers.push(blocker(
      "github_auth_unavailable",
      "GitHub CLI authentication could not be verified.",
      "Run `gh auth login`, then verify access to the canonical repository.",
    ));
  }

  let identity: RepositoryInstallationIdentity | null = null;
  if (normalizedOrigin && ghAuth && successful(ghAuth)) {
    const api = runner.run({
      program: "gh",
      args: ["api", `repos/${normalizedOrigin}`],
      cwd,
      timeoutMs: 20_000,
    });
    const response = successful(api) ? parseRepositoryResponse(api.stdout) : null;
    if (
      !response
      || (typeof response.id !== "number" && typeof response.id !== "string")
      || typeof response.full_name !== "string"
      || typeof response.default_branch !== "string"
    ) {
      blockers.push(blocker(
        "github_auth_unavailable",
        `GitHub repository metadata could not be verified: ${conciseProcessFailure(api)}.`,
        "Grant the authenticated actor read and administration access to the repository.",
      ));
    } else if (response.full_name.toLowerCase() !== normalizedOrigin) {
      blockers.push(blocker(
        "repository_identity_mismatch",
        `GitHub resolved ${response.full_name}, which does not match origin ${normalizedOrigin}.`,
        "Correct the origin remote or GitHub authentication context before installation.",
      ));
      analysisAllowed = false;
    } else {
      const permission = actorPermission(response.permissions);
      if (permission !== "admin" && permission !== "maintain" && permission !== "write") {
        blockers.push(blocker(
          "missing_github_permission",
          `The authenticated actor has ${permission} permission; write or stronger is required.`,
          "Use an authenticated maintainer with repository write or administration permission.",
        ));
      }
      const protection = runner.run({
        program: "gh",
        args: ["api", `repos/${normalizedOrigin}/branches/${encodeURIComponent(response.default_branch)}/protection`],
        cwd,
        timeoutMs: 20_000,
      });
      const absentProtection = permission === "admin"
        && protection.status !== 0
        && /(?:HTTP\s+404|Not Found)/i.test(`${protection.stderr}\n${protection.stdout}`);
      const branchPolicy = successful(protection) ? "protected" : absentProtection ? "unprotected" : "unknown";
      if (branchPolicy === "unknown") {
        blockers.push(blocker(
          "unknown_branch_policy",
          "The default-branch policy could not be determined.",
          "Grant branch-policy read access or configure a verifiable repository ruleset.",
        ));
      }
      const user = runner.run({
        program: "gh",
        args: ["api", "user"],
        cwd,
        timeoutMs: 20_000,
      });
      const actorLogin = successful(user) ? parseUserLogin(user.stdout) : null;
      if (!actorLogin) {
        blockers.push(blocker(
          "github_auth_unavailable",
          "The authenticated GitHub actor identity could not be verified.",
          "Re-authenticate GitHub CLI and grant access to read the current actor identity.",
        ));
      }
      identity = {
        repository_id: String(response.id),
        full_name: response.full_name,
        default_branch: response.default_branch,
        current_commit: head.stdout.trim().toLowerCase(),
        current_branch: branch.stdout.trim() || "detached",
        origin_url: origin.stdout.trim(),
        actor_login: actorLogin ?? "unknown",
        actor_permission: permission,
        default_branch_policy: branchPolicy,
      };
    }
  }

  const commandDiscovery = discoverRepositoryCommands(
    cwd,
    runner,
    options.runValidation === true,
  );
  blockers.push(...commandDiscovery.blockers);
  const allowedWritePaths = successful(tracked) ? trackedWritePaths(cwd, tracked.stdout) : [];
  if (allowedWritePaths.length === 0) {
    blockers.push(blocker(
      "missing_deterministic_validation",
      "No safe application write scope could be derived from tracked repository files.",
      "Commit application source beneath a bounded repository path before installation.",
    ));
  }

  return {
    disposition: dispositionFor(analysisAllowed, identity, blockers, options.runValidation === true),
    analysis_allowed: analysisAllowed,
    identity,
    commands: commandDiscovery.commands,
    allowed_write_paths: allowedWritePaths,
    protected_paths: [...PROTECTED_PATHS],
    blockers,
  };
}
