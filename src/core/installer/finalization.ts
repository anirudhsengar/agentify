import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadCanonicalMapAt } from "../audit/write-map-tool.ts";
import { AUDIT_STATE_RELATIVE_DIR } from "../audit/paths.ts";
import { refinePreflightWithAudit } from "./agent-validation-discovery.ts";
import {
  hasRecognizedManifestMarker,
  acceptMemoryCandidate,
  initializeTeamMemoryStore,
  proposeMemoryCandidate,
  readMemoryRecord,
  readTeamMemoryManifest,
  TeamMemoryError,
} from "../memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  readGitCommitTimestamp,
} from "../specialists/evidence.ts";
import {
  synchronizeRepositorySpecialists,
  type RepositorySpecialistSyncResult,
} from "../specialists/runtime.ts";
import { assessTaskReadiness } from "../task-lifecycle/readiness.ts";
import { validateTaskLifecyclePolicy } from "../task-lifecycle/schema.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import { installScaffoldRuntime } from "../scaffold-installer.ts";
import type {
  GitHubConfigurationInput,
  InstallationCanaryResult,
  InstallerBlocker,
  InstallerProcessRunner,
  OneTimeInstallationReport,
  RepositoryInstallationPreflight,
  RepositoryValidationApproval,
} from "./contracts.ts";
import { configureGitHubInstallation } from "./github-configuration.ts";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "./process-runner.ts";
import {
  buildRepositoryTaskPolicyConfiguration,
  readRepositoryTaskPolicyConfiguration,
} from "./task-policy.ts";

export interface FinalizeOneTimeInstallationInput {
  cwd: string;
  preflight: RepositoryInstallationPreflight;
  agentifyVersion: string;
  provider: string | null;
  model: string | null;
  providerVerified: boolean;
  validationApproval?: RepositoryValidationApproval;
  providerSecret?: GitHubConfigurationInput["providerSecret"];
  automationSecret?: GitHubConfigurationInput["automationSecret"];
  runner?: InstallerProcessRunner;
  repairedPaths?: ReadonlyArray<string>;
}

function managedFile(cwd: string, relativePath: string, marker: string): boolean {
  const filePath = path.join(cwd, relativePath);
  return fs.existsSync(filePath)
    && fs.lstatSync(filePath).isFile()
    && fs.readFileSync(filePath, "utf-8").includes(marker);
}

function bootstrapEvidencePath(cwd: string, preflight: RepositoryInstallationPreflight): string {
  const listed = spawnSync("git", ["-C", cwd, "ls-files", "-z"], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (listed.status !== 0) {
    throw new Error("cannot enumerate exact tracked repository paths for persistent-team bootstrap evidence");
  }
  const tracked = listed.stdout
    .split("\0")
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const preferred = ["README.md", "package.json"];
  const candidates = [
    ...preferred.flatMap((name) => tracked.filter((candidate) => candidate.toLowerCase() === name.toLowerCase())),
    ...preflight.allowed_write_paths.flatMap((scope) => tracked.filter((candidate) => (
      candidate === scope || candidate.startsWith(`${scope}/`)
    ))),
    ...tracked,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const absolute = path.join(cwd, ...candidate.split("/"));
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  throw new Error("no tracked repository file is available for persistent-team bootstrap evidence");
}

function initializePersistentTeam(
  cwd: string,
  preflight: RepositoryInstallationPreflight,
): void {
  if (hasRecognizedManifestMarker(cwd)) {
    const manifest = readTeamMemoryManifest(cwd);
    if (manifest.repository_id !== preflight.identity?.full_name) {
      throw new Error(
        `persistent team belongs to ${manifest.repository_id}, not ${preflight.identity?.full_name ?? "unknown"}`,
      );
    }
    ensureSelfUpdatePolicy(cwd, preflight);
    return;
  }
  if (!preflight.identity) throw new Error("verified repository identity is required to initialize persistent memory");
  const evidencePath = bootstrapEvidencePath(cwd, preflight);
  const observedAt = readGitCommitTimestamp(cwd, preflight.identity.current_commit);
  const evidence = buildSpecialistEvidenceReference({
    cwd,
    supportingCommit: preflight.identity.current_commit,
    repositoryPath: evidencePath,
    sourceType: "validated_bootstrap",
    observedAt,
    actor: preflight.identity.actor_login,
  });
  initializeTeamMemoryStore({
    cwd,
    repositoryId: preflight.identity.full_name,
    supportingCommit: preflight.identity.current_commit,
    evidence: [evidence],
    actor: "agentify-installer",
  });
  ensureSelfUpdatePolicy(cwd, preflight);
}

/**
 * Establish the persistent store before the model-backed audit starts so its
 * recoverable operational map can live beneath `.agentify/runtime`.
 */
export function prepareOneTimeInstallationState(
  cwd: string,
  preflight: RepositoryInstallationPreflight,
): void {
  initializePersistentTeam(cwd, preflight);
}

function ensureSelfUpdatePolicy(
  cwd: string,
  preflight: RepositoryInstallationPreflight,
): void {
  try {
    const existing = readMemoryRecord(cwd, "self-update-allowlist");
    if (existing.kind !== "policy" || existing.payload.policy_key !== "self-update-allowlist") {
      throw new Error("self-update-allowlist memory ID is occupied by incompatible durable memory");
    }
    return;
  } catch (error) {
    if (!(error instanceof TeamMemoryError) || error.code !== "not_found") throw error;
  }
  if (!preflight.identity) throw new Error("verified repository identity is required for self-update policy");
  const repositoryPath = bootstrapEvidencePath(cwd, preflight);
  const acceptedAt = readGitCommitTimestamp(cwd, preflight.identity.current_commit);
  const evidence = buildSpecialistEvidenceReference({
    cwd,
    supportingCommit: preflight.identity.current_commit,
    repositoryPath,
    sourceType: "maintainer_instruction",
    observedAt: acceptedAt,
    actor: preflight.identity.actor_login,
  });
  const candidate = proposeMemoryCandidate({
    schema_version: "1",
    candidate_id: "installer-self-update-policy-v1",
    memory_id: "self-update-allowlist",
    kind: "policy",
    proposed_by_agent_id: "knowledge-maintainer",
    owning_agent_id: "knowledge-maintainer",
    statement: "Automatic learning is confined to versioned Agentify knowledge, identity, history, manifest, and canonical ignore-rule paths.",
    source_type: "maintainer_instruction",
    supporting_commit: preflight.identity.current_commit,
    evidence: [evidence],
    confidence: "verified",
    dependent_paths: [".agentify/manifest.json"],
    invalidation_conditions: ["trusted installer upgrade changes the self-update boundary"],
    contradicts: [],
    human_attribution: {
      actor: preflight.identity.actor_login,
      source_ref: `installer:${preflight.identity.current_commit}`,
      accepted_at: acceptedAt,
    },
    tags: ["policy", "self-update", "allowlist"],
    proposed_at: acceptedAt,
    payload: {
      policy_key: "self-update-allowlist",
      rule: "Only .agentify agents, knowledge, history, manifest, and canonical ignore rules may self-update; policies, application source, dependencies, workflows, runtime code, and operational state are immutable to learning.",
      protected_paths: [
        ".agentify/policies",
        ".agentify/runtime",
        ".agentify/state-transactions",
        ".github",
        "package.json",
        "package-lock.json",
      ],
      allowed_tools: [],
      forbidden_actions: [
        "application source update",
        "dependency update",
        "policy update",
        "workflow update",
        "runtime code update",
        "permission expansion",
      ],
      approval_required: true,
      numeric_limit: null,
      unit: null,
    },
  });
  acceptMemoryCandidate(
    cwd,
    candidate,
    "knowledge-maintainer",
    "install the maintainer-attributed self-update allowlist",
  );
}

function runInstallationCanaries(
  cwd: string,
  preflight: RepositoryInstallationPreflight,
  specialistSync: RepositorySpecialistSyncResult,
): InstallationCanaryResult {
  const checks: InstallationCanaryResult["checks"] = [];
  const add = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  add("persistent-memory-manifest", hasRecognizedManifestMarker(cwd), "vendor-neutral .agentify manifest is recognized");
  add(
    "self-update-allowlist",
    fs.existsSync(path.join(cwd, ".agentify/policies/self-update-allowlist.json")),
    "self-update allowlist is versioned in the real-byte memory manifest",
  );
  for (const file of [
    ".agentify/agents/orchestrator.json",
    ".agentify/agents/roles/builder.json",
    ".agentify/agents/roles/reviewer.json",
    ".agentify/agents/roles/knowledge-maintainer.json",
  ]) add(`identity:${file}`, fs.existsSync(path.join(cwd, file)), `${file} is materialized`);
  add(
    "specialist-portfolio",
    specialistSync.status === "synchronized",
    specialistSync.status === "synchronized"
      ? `${specialistSync.portfolio.specialists.length} specialists and ${specialistSync.portfolio.procedures.length} procedures`
      : `specialist synchronization status is ${specialistSync.status}`,
  );
  const mapIgnore = spawnSync(
    "git",
    ["-C", cwd, "check-ignore", "--no-index", "-q", "--", ".agentify/runtime/audit/codebase_map.json"],
    { encoding: "utf-8", windowsHide: true },
  );
  add(
    "canonical-audit-map-versioned",
    mapIgnore.status === 1,
    mapIgnore.status === 0
      ? "canonical audit map is excluded by repository ignore rules"
      : "canonical audit map is available to commit for installed workflow routing",
  );
  add(
    "canonical-issue-workflow",
    managedFile(cwd, ".github/workflows/agentify-issue.yml", "agentify:managed"),
    "canonical issue intake workflow is Agentify-owned",
  );
  add(
    "canonical-learning-workflow",
    managedFile(cwd, ".github/workflows/agentify-learn.yml", "agentify:managed"),
    "canonical accepted-merge learning workflow is Agentify-owned",
  );
  for (const file of [
    ".github/agentify/task-runtime.mjs",
    ".github/agentify/learning-runtime.mjs",
    ".github/agentify/validation-smoke.mjs",
  ]) add(`runtime:${file}`, fs.existsSync(path.join(cwd, file)), `${file} is installed`);

  const configuration = readRepositoryTaskPolicyConfiguration(cwd);
  let policyValid = false;
  if (configuration?.configured === true && configuration.policy) {
    try {
      validateTaskLifecyclePolicy(configuration.policy);
      policyValid = configuration.repository?.repository_id === preflight.identity?.repository_id
        && configuration.repository?.current_commit === preflight.identity?.current_commit;
    } catch {
      policyValid = false;
    }
  }
  add("repository-task-policy", policyValid, "repository-specific typed task policy is configured and identity-bound");
  if (preflight.identity && configuration?.policy) {
    const lifecycle = assessTaskReadiness({
      repository: {
        repository_id: preflight.identity.repository_id,
        full_name: preflight.identity.full_name,
        default_branch: preflight.identity.default_branch,
      },
      installation_repository_id: preflight.identity.repository_id,
      issue_number: 1,
      issue_open: true,
      actor_authorized: true,
      expected_base_commit: preflight.identity.current_commit,
      current_base_commit: preflight.identity.current_commit,
      active_task_id: null,
      conflicting_pull_request: null,
      acceptance_criteria: [{ criterion_id: "installer-canary", statement: "canary passes", verification: "deterministic" }],
      proposed_paths: [preflight.allowed_write_paths[0]!],
      validation_commands: configuration.policy.validation_commands,
      protected_path_policy_known: configuration.policy.protected_paths.length > 0,
      validation_services_attested: configuration.validation_services_attested,
      validation_policy_current: configuration.validation_approval !== null,
      available_budget_usd: configuration.policy.maximum_cost_usd,
      issue_text: "Deterministic local lifecycle installation canary. Do not merge or deploy.",
    });
    add("lifecycle-readiness", lifecycle.disposition === "ready", `lifecycle canary disposition is ${lifecycle.disposition}`);
  } else {
    add("lifecycle-readiness", false, "verified identity or configured task policy is missing");
  }
  return { passed: checks.every((check) => check.passed), checks };
}

function withBlocker(
  blockers: InstallerBlocker[],
  code: InstallerBlocker["code"],
  message: string,
  remediation: string,
): void {
  blockers.push({ code, message, remediation });
}

export function finalizeOneTimeInstallation(
  input: FinalizeOneTimeInstallationInput,
): OneTimeInstallationReport {
  const map = loadCanonicalMapAt(input.cwd, AUDIT_STATE_RELATIVE_DIR);
  const { preflight: effectivePreflight, validationApproval: refinedApproval } = refinePreflightWithAudit({
    cwd: input.cwd,
    preflight: input.preflight,
    map,
    runner: input.runner,
  });
  const validationApproval = refinedApproval ?? input.validationApproval ?? undefined;
  const blockers = [...effectivePreflight.blockers];
  let installedValidationCommands = effectivePreflight.commands;
  if (!input.providerVerified || !input.provider || !input.model) {
    withBlocker(
      blockers,
      "unsupported_provider_or_model",
      "A supported authenticated primary provider/model could not be resolved.",
      "Run `agentify login` and `agentify models set <provider>/<model>` with a supported model, then verify again.",
    );
  }
  let specialistSync: RepositorySpecialistSyncResult = { status: "memory_absent" };
  try {
    initializePersistentTeam(input.cwd, effectivePreflight);
    specialistSync = synchronizeRepositorySpecialists(input.cwd);
  } catch (error) {
    withBlocker(
      blockers,
      error instanceof Error && /ambiguous/i.test(error.message)
        ? "ambiguous_agentify_state"
        : "installation_canary_failed",
      error instanceof Error ? error.message : String(error),
      "Resolve the reported persistent-state ownership or provenance problem without deleting retained evidence.",
    );
  }

  try {
    const writes = installScaffoldRuntime({
      cwd: input.cwd,
      packageRoot: packageRoot(),
      taskPolicyConfiguration: buildRepositoryTaskPolicyConfiguration(
        effectivePreflight,
        validationApproval ?? null,
        input.cwd,
      ),
    });
    const conflicts = writes.filter(
      (write) => write.action === "alongside",
    );
    if (conflicts.length > 0) {
      withBlocker(
        blockers,
        "user_owned_workflow_conflict",
        `User-owned files conflict with ${conflicts.length} required Agentify installation path(s).`,
        "Review the preserved *.agentify.* files and explicitly resolve each conflict.",
      );
    }
  } catch (error) {
    withBlocker(
      blockers,
      "installation_canary_failed",
      error instanceof Error ? error.message : String(error),
      "Rebuild the exact Agentify package and repair only verified Agentify-owned runtime paths.",
    );
  }

  if (effectivePreflight.disposition === "ready") {
    const verified = effectivePreflight.commands.filter((c) => c.kind !== "install" && c.required);
    for (const cmd of verified) {
      const res = (input.runner ?? DEFAULT_INSTALLER_PROCESS_RUNNER).run({
        program: cmd.argv[0]!,
        args: cmd.argv.slice(1),
        cwd: path.resolve(input.cwd, cmd.cwd),
        timeoutMs: cmd.timeout_ms,
      });
      if (res.status !== 0 || res.timedOut) {
        withBlocker(
          blockers,
          "validation_failed",
          `Validation command failed after Agentify installed its managed files: ${cmd.argv.join(" ")}`,
          "Configure repository validation to accept or explicitly exclude Agentify-owned generated assets, then rerun the installer.",
        );
      }
    }
    installedValidationCommands = effectivePreflight.commands;
  }

  const canary = runInstallationCanaries(input.cwd, effectivePreflight, specialistSync);
  if (!canary.passed) {
    withBlocker(
      blockers,
      "installation_canary_failed",
      `Installation canaries failed: ${canary.checks.filter((check) => !check.passed).map((check) => check.name).join(", ")}.`,
      "Repair only the reported Agentify-owned installation paths, then rerun verification.",
    );
  }

  if (effectivePreflight.identity && blockers.length === 0 && canary.passed) {
    try {
      configureGitHubInstallation({
        cwd: input.cwd,
        repository: effectivePreflight.identity,
        agentifyVersion: input.agentifyVersion,
        provider: input.provider,
        model: input.model,
        providerSecret: input.providerSecret,
        automationSecret: input.automationSecret,
        runner: input.runner,
      });
    } catch (error) {
      withBlocker(
        blockers,
        "github_configuration_failed",
        error instanceof Error ? error.message : String(error),
        "Verify maintainer permissions, GitHub CLI authentication, and repository variable/label access.",
      );
    }
  }

  const synchronized = specialistSync.status === "synchronized" ? specialistSync : null;
  const ready = effectivePreflight.disposition === "ready" && blockers.length === 0 && canary.passed;
  return {
    disposition: ready ? "ready" : effectivePreflight.analysis_allowed ? "analyzable-only" : "blocked",
    repository: effectivePreflight.identity,
    specialists_installed: synchronized?.portfolio.specialists.length ?? 0,
    specialist_warnings: synchronized?.portfolio.warnings ?? [],
    procedures_installed: synchronized?.portfolio.procedures.length ?? 0,
    validation_commands_verified: installedValidationCommands.filter((command) => command.assessment === "verified").length,
    github_issue_intake_enabled: ready,
    draft_pr_publication_enabled: ready,
    automatic_knowledge_refresh_enabled: ready,
    automatic_application_merge_enabled: false,
    repaired_paths: [...(input.repairedPaths ?? [])],
    blockers,
  };
}

export function formatOneTimeInstallationReport(report: OneTimeInstallationReport): string[] {
  const lines = [
    `Agentify readiness: ${report.disposition}`,
    report.repository
      ? `Repository identity verified (${report.repository.repository_id}, ${report.repository.full_name}, ${report.repository.default_branch}@${report.repository.current_commit})`
      : "Repository identity not verified",
    "Repository analyzed",
    "Persistent orchestrator installed",
    `${report.specialists_installed} specialists installed`,
    ...report.specialist_warnings.map((warning) => `Specialist discovery: ${warning}`),
    `${report.procedures_installed} procedures installed`,
    `${report.validation_commands_verified} validation commands verified`,
    `GitHub issue intake ${report.github_issue_intake_enabled ? "enabled" : "disabled"}`,
    `Draft PR publication ${report.draft_pr_publication_enabled ? "enabled" : "disabled"}`,
    `Automatic knowledge refresh ${report.automatic_knowledge_refresh_enabled ? "enabled" : "disabled"}`,
    "Automatic application merge disabled",
  ];
  for (const blocker of report.blockers) {
    lines.push(`Blocker [${blocker.code}]: ${blocker.message} ${blocker.remediation}`);
  }
  if (report.disposition === "ready") {
    lines.push("Agentify is installed. Queue an authorized GitHub issue with the agentify:queue label.");
  }
  return lines;
}
