import * as fs from "node:fs";
import * as path from "node:path";
import type { CodebaseMap } from "../audit/schema.ts";
import { buildProvenance } from "../build-provenance.ts";
import { isExecutableValidationCommandText } from "./agent-validation-discovery.ts";
import type {
  InstallationCanaryResult,
  InstallerBlocker,
  InstallerCommand,
  InstallerDisposition,
  RepositoryInstallationIdentity,
  RepositoryValidationApproval,
} from "./contracts.ts";

export const INSTALLATION_REPORT_RELATIVE_PATH = ".agentify/installation-report.json";

const MANAGED_MARKDOWN_MARKER = "<!-- agentify:managed -->";
const REMEDIATION_COMMAND = "agentify";

/**
 * One command execution in one phase. Baseline and staged-final-tree runs are
 * separate records: the same command can pass against the repository as it was
 * and fail against the tree Agentify produced, and a maintainer has to be able
 * to tell those apart and reproduce them.
 */
export interface InstallationReportExecution {
  phase: "baseline" | "staged_final_tree";
  command: string;
  kind: InstallerCommand["kind"];
  required: boolean;
  working_directory: string;
  assessment: InstallerCommand["assessment"] | null;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number | null;
  /** For a composite script, the inner script that actually failed. */
  failed_subcommand: string | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
}

export interface InstallationReportEnvironment {
  node_version: string;
  npm_version: string | null;
  lockfile: { path: string; sha256: string } | null;
}

export interface InstallationReportToolProvenance {
  agentify_version: string;
  source_commit: string | null;
  source_dirty: boolean | null;
}

export interface InstallationReportPortfolioSpecialist {
  specialist_id: string;
  domain: string;
  owned_paths: string[];
}

export interface InstallationReportPortfolio {
  specialists: InstallationReportPortfolioSpecialist[];
  procedures: string[];
  warnings: string[];
}

export interface InstallationReport {
  schema_version: "1";
  generated_at: string;
  agentify_version: string;
  repository: {
    repository_id: string;
    full_name: string;
    default_branch: string;
    current_commit: string;
    default_branch_policy: "protected" | "unprotected" | "unknown";
  } | null;
  disposition: InstallerDisposition;
  policy_configured: boolean;
  agentify_enabled: boolean;
  tool_provenance: InstallationReportToolProvenance;
  environment: InstallationReportEnvironment;
  validation: {
    approval: "current" | "stale" | "absent";
    executions: InstallationReportExecution[];
  };
  readiness_checks: {
    blockers: InstallerBlocker[];
    canaries: InstallationCanaryResult["checks"];
  };
  portfolio: InstallationReportPortfolio;
  remediation_command: string | null;
}

/**
 * Write the report, but leave an existing one untouched when the installation
 * it describes is unchanged. Only `generated_at` differs between two identical
 * reruns, and rewriting for that alone would churn the file and the integrity
 * root it participates in on every invocation.
 */
export function writeInstallationReport(cwd: string, report: InstallationReport): void {
  const target = path.join(cwd, ...INSTALLATION_REPORT_RELATIVE_PATH.split("/"));
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (fs.existsSync(target)) {
    try {
      const existing = JSON.parse(fs.readFileSync(target, "utf-8")) as InstallationReport;
      // Only wall-clock measurements differ between two identical reruns.
      const comparable = (value: InstallationReport): string => JSON.stringify({
        ...value,
        generated_at: null,
        validation: {
          ...value.validation,
          executions: value.validation.executions.map((execution) => ({
            ...execution,
            duration_ms: null,
          })),
        },
      });
      if (comparable(existing) === comparable(report)) return;
    } catch {
      // An unreadable report is replaced.
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered, "utf-8");
}

export interface BuildInstallationReportInput {
  agentifyVersion: string;
  generatedAt: string;
  identity: RepositoryInstallationIdentity | null;
  disposition: InstallerDisposition;
  ready: boolean;
  validationApproval: RepositoryValidationApproval | null;
  /** Whether the recorded approval still matches the current manifest, lockfile, and commands. */
  validationApprovalCurrent: boolean;
  commands: ReadonlyArray<InstallerCommand>;
  stagedExecutions: ReadonlyArray<InstallationReportExecution>;
  environment: InstallationReportEnvironment;
  blockers: ReadonlyArray<InstallerBlocker>;
  canaries: InstallationCanaryResult["checks"];
  portfolio: {
    specialists: ReadonlyArray<{
      specialist_id: string;
      domain: string;
      owned_paths: ReadonlyArray<string>;
    }>;
    procedures: ReadonlyArray<{ procedure_id: string }>;
    warnings: ReadonlyArray<string>;
  } | null;
}

/**
 * Build the durable installation record. It is written whether or not the
 * installation activated, so a refused installation still leaves the exact
 * failed readiness checks, validation results, consent state, and a single
 * deterministic remediation command in the repository.
 */
/** Blockers that a rerun cannot clear without a change outside Agentify. */
const RERUN_CANNOT_CLEAR: ReadonlySet<InstallerBlocker["code"]> = new Set([
  "validation_failed",
  "unsupported_contribution_branch",
  "user_owned_workflow_conflict",
  "incomplete_specialist_ownership",
]);

function rerunCanHelp(blockers: ReadonlyArray<InstallerBlocker>): boolean {
  return blockers.length > 0 && blockers.every((blocker) => !RERUN_CANNOT_CLEAR.has(blocker.code));
}

export function buildInstallationReport(
  input: BuildInstallationReportInput,
): InstallationReport {
  const approval: InstallationReport["validation"]["approval"] = input.validationApproval === null
    ? "absent"
    : input.validationApprovalCurrent
      ? "current"
      : "stale";
  return {
    schema_version: "1",
    generated_at: input.generatedAt,
    agentify_version: input.agentifyVersion,
    repository: input.identity
      ? {
        repository_id: input.identity.repository_id,
        full_name: input.identity.full_name,
        default_branch: input.identity.default_branch,
        current_commit: input.identity.current_commit,
        default_branch_policy: input.identity.default_branch_policy,
      }
      : null,
    disposition: input.disposition,
    policy_configured: input.ready,
    agentify_enabled: input.ready,
    tool_provenance: {
      agentify_version: input.agentifyVersion,
      ...buildProvenance(),
    },
    environment: input.environment,
    validation: {
      approval,
      executions: [
        ...input.commands.map((command): InstallationReportExecution => ({
          phase: "baseline",
          command: command.argv.join(" "),
          kind: command.kind,
          required: command.required,
          working_directory: command.cwd,
          assessment: command.assessment,
          exit_code: command.exit_code,
          timed_out: false,
          duration_ms: null,
          failed_subcommand: null,
          stdout_tail: null,
          stderr_tail: null,
        })),
        ...input.stagedExecutions.map((execution) => ({ ...execution })),
      ],
    },
    readiness_checks: {
      blockers: input.blockers.map((blocker) => ({ ...blocker })),
      canaries: input.canaries.map((check) => ({ ...check })),
    },
    portfolio: {
      specialists: (input.portfolio?.specialists ?? []).map((specialist) => ({
        specialist_id: specialist.specialist_id,
        domain: specialist.domain,
        owned_paths: [...specialist.owned_paths],
      })),
      procedures: (input.portfolio?.procedures ?? []).map((procedure) => procedure.procedure_id),
      warnings: [...(input.portfolio?.warnings ?? [])],
    },
    // Rerunning the installer only helps when the blockers are things a rerun
    // can change. Re-running it against the same source and the same generated
    // assets is repetition, not remediation.
    remediation_command: input.ready || !rerunCanHelp(input.blockers)
      ? null
      : REMEDIATION_COMMAND,
  };
}

export interface InstallationDocumentContext {
  agentifyVersion: string;
  identity: RepositoryInstallationIdentity | null;
  configured: boolean;
  issueIntakeEnabled: boolean;
  validationCommands: ReadonlyArray<string>;
  map: CodebaseMap | null;
}

function usable(value: string | null | undefined): value is string {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0
    && normalized !== "unknown"
    && normalized !== "none"
    && normalized !== "n/a"
    && !normalized.startsWith("(none");
}

function executableCommands(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.filter(isExecutableValidationCommandText))]
    .sort((left, right) => left.localeCompare(right));
}

function scopeExamplePath(map: CodebaseMap | null): string {
  const entryPoint = map?.skeleton.entry_points[0]?.path;
  return usable(entryPoint) ? entryPoint : "src/";
}

function changeTypeLines(map: CodebaseMap | null): string[] {
  if (!map) return [];
  const perChangeType: Record<string, { mandatory: string[] }> = {
    chore: map.validation_surface.per_change_type.chore,
    bug: map.validation_surface.per_change_type.bug,
    feature: map.validation_surface.per_change_type.feature,
    ...(map.validation_surface.per_change_type.refactor
      ? { refactor: map.validation_surface.per_change_type.refactor } : {}),
    ...(map.validation_surface.per_change_type.security
      ? { security: map.validation_surface.per_change_type.security } : {}),
  };
  return Object.entries(perChangeType)
    .map(([changeType, rule]) => {
      const mandatory = executableCommands(rule.mandatory);
      return mandatory.length > 0
        ? `- **${changeType}**: ${mandatory.map((command) => `\`${command}\``).join(", ")}`
        : null;
    })
    .filter((line): line is string => line !== null);
}

function conventionLines(map: CodebaseMap | null): string[] {
  if (!map) return [];
  return map.conventions.patterns
    .slice(0, 5)
    .map((pattern) => `- **${pattern.name}** (${pattern.where}): ${pattern.description}`);
}

function branchProtectionWarning(identity: RepositoryInstallationIdentity | null): string | null {
  if (!identity || identity.default_branch_policy === "protected") return null;
  return [
    `> **Trust-root risk:** the default branch \`${identity.default_branch}\` is not recorded as`,
    "protected. Agentify treats the checked-out default-branch tree as trusted runtime code,",
    "so an unprotected default branch lets any writer alter that runtime directly. Enable",
    "branch protection (required reviews, no force-push) before relying on issue execution.",
  ].join("\n");
}

function branchModelLines(context: InstallationDocumentContext): string[] {
  const lines: string[] = [];
  const defaultBranch = context.identity?.default_branch ?? null;
  if (defaultBranch) {
    lines.push(
      `Agentify executes on and targets the repository default branch \`${defaultBranch}\`.`,
      "Draft pull requests open against that branch; a human retains merge authority.",
    );
  }
  const auditedBranch = context.map?.operational_surface.git_workflow.main_branch;
  if (usable(auditedBranch) && auditedBranch !== defaultBranch) {
    lines.push(
      "",
      `The audit recorded \`${auditedBranch}\` as the documented contribution branch.`,
      "Agentify does not execute application work while the contribution branch differs",
      "from the execution base; align repository policy or the default branch first.",
    );
  }
  const branchNaming = context.map?.operational_surface.git_workflow.branch_naming;
  if (usable(branchNaming)) {
    lines.push("", `Branch naming convention: ${branchNaming}`);
  }
  return lines;
}

function statusLines(context: InstallationDocumentContext): string[] {
  const active = context.configured && context.issueIntakeEnabled;
  const lines = active
    ? [
      "Activation state: **active**. The repository policy is configured and the",
      "`AGENTIFY_ENABLED` repository variable is `true`, so the issue and learning",
      "workflows run.",
    ]
    : [
      "Activation state: **disabled**. The task policy is not configured or",
      "`AGENTIFY_ENABLED` is not `true`; the workflows refuse to run.",
      `Resolve the blockers in \`${INSTALLATION_REPORT_RELATIVE_PATH}\` and rerun`,
      `\`${REMEDIATION_COMMAND}\`.`,
    ];
  lines.push(
    "",
    `The authoritative record of readiness checks, validation results, and consent`,
    `state is the committed installation report at \`${INSTALLATION_REPORT_RELATIVE_PATH}\`.`,
  );
  return lines;
}

function validationSection(context: InstallationDocumentContext): string[] {
  const lines = ["## Validation", ""];
  if (context.validationCommands.length === 0) {
    lines.push("No repository validation command was verified during installation.");
    return lines;
  }
  lines.push(
    "These repository validation commands were verified against the final installed",
    "tree and are attested in the repository task policy:",
    "",
    ...context.validationCommands.map((command) => `- \`${command}\``),
  );
  const changeTypes = changeTypeLines(context.map);
  if (changeTypes.length > 0) {
    lines.push("", "The audit recorded per-change-type mandatory validation:", "", ...changeTypes);
  }
  return lines;
}

export function renderSetupDocument(context: InstallationDocumentContext): string {
  const protectionWarning = branchProtectionWarning(context.identity);
  const conventions = conventionLines(context.map);
  const sections = [
    `# Agentify installation\n\n${MANAGED_MARKDOWN_MARKER}\n\nAgentify ${context.agentifyVersion} is installed once for this repository. Authorized GitHub issues are the normal work interface; do not rerun the CLI for ordinary tasks.`,
    `## Activation state\n\n${statusLines(context).join("\n")}`,
    [
      "## Queue work",
      "",
      "Create an issue with explicit acceptance criteria and add the",
      "`agentify:queue` label. Candidate paths are authority, so the issue must include",
      "an explicit `## Scope` section. Use this minimum structure:",
      "",
      "```markdown",
      "## Goal",
      "Describe the requested outcome.",
      "",
      "## Acceptance criteria",
      "- State one testable result per item.",
      "",
      "## Scope",
      `- \`${scopeExamplePath(context.map)}\``,
      "",
      "## Out of scope",
      "- `.github/`",
      "- `package.json`",
      "```",
      "",
      "Trusted maintainers may use these exact comments:",
      "",
      "- `/agent approve`",
      "- `/agent stop`",
      "- `/agent retry`",
      "- `/agent replan`",
      "- `/agent explain`",
      "",
      "The trusted runtime checks authorization and the configured repository policy,",
      "plans with a read-only planner and read-only specialists, grants exactly one",
      "builder bounded source write authority, runs approved repository validation,",
      "obtains a role-separated automated read-only review, and opens an unmerged",
      "draft pull request. A human retains merge authority.",
    ].join("\n"),
    validationSection(context).join("\n"),
    `## Branch model\n\n${branchModelLines(context).join("\n")}`,
    ...(protectionWarning !== null ? [`## Default-branch protection\n\n${protectionWarning}`] : []),
    ...(conventions.length > 0
      ? [`## Recorded conventions\n\n${conventions.join("\n")}`]
      : []),
    [
      "## Credentials",
      "",
      "`PI_API_KEY` is the only provider secret used by the workflows. The installer",
      "copies a resolved local provider key through `gh secret set` stdin when one is",
      "already present; otherwise configure it through GitHub's secret UI or",
      "`gh secret set PI_API_KEY` with the value supplied through stdin. Never place it",
      "in a command argument or repository file.",
      "",
      "`AGENT_PAT` is an optional dedicated GitHub automation token used only to push",
      "the task branch and publish its draft pull request. It is recommended because",
      "GitHub suppresses workflow events created with the built-in workflow token.",
      "Issue authorization, labels, comments, and task state continue to use the",
      "repository-scoped workflow token. The dedicated token must have access to this",
      "repository; otherwise draft publication fails closed. It remains confined to",
      "trusted workflow code and is never exposed to model processes. A fine-grained",
      "token needs access to this repository with **Contents: read and write** and",
      "**Pull requests: read and write**.",
      "",
      "The installer owns these repository variables:",
      "",
      "- `AGENTIFY_ENABLED`",
      "- `PI_PROVIDER`",
      "- `PI_MODEL`",
      "- `PI_THINKING`",
      "- `AGENTIFY_VERSION`",
    ].join("\n"),
    [
      "## Installed trust boundary",
      "",
      "- `.github/workflows/agentify-issue.yml` handles authorized issue work.",
      "- `.github/workflows/agentify-learn.yml` handles accepted-merge learning.",
      "- `.github/agentify-task-policy.json` is repository-identity-bound and fails",
      "  closed when incomplete.",
      "- `.github/agentify/*.mjs` are trusted bundled runtimes.",
      "- `.github/agentify/runtime-inventory.json` records the exact byte sizes and",
      "  SHA-256 digests of the installed runtimes.",
      `- \`${INSTALLATION_REPORT_RELATIVE_PATH}\` records readiness, validation, and`,
      "  consent state for this installation.",
      "- `.agentify/` is versioned external memory plus ignored operational state.",
      "",
      "Agentify never merges application changes, enables auto-merge, deploys,",
      "force-pushes an application branch, or lets learned output modify application",
      "source, dependencies, workflow permissions, policy, or executable runtime code.",
    ].join("\n"),
  ];
  return `${sections.filter((section) => section.trim().length > 0).join("\n\n")}\n`;
}

export function renderAgentsDocument(context: InstallationDocumentContext): string {
  const protectionWarning = branchProtectionWarning(context.identity);
  const defaultBranch = context.identity?.default_branch ?? null;
  const lines = [
    MANAGED_MARKDOWN_MARKER,
    "# Agentify repository team",
    "",
    context.identity
      ? `This repository (${context.identity.full_name}) is served by an installed Agentify engineering team.`
      : "This repository is served by an installed Agentify engineering team.",
    "",
    "Use GitHub issues with the `agentify:queue` label to request implementation.",
    "Agentify plans with a read-only planner and repository-specific read-only",
    "specialists, grants exactly one builder bounded write authority, validates",
    "deterministically, obtains a role-separated automated read-only review, and",
    "stops at an unmerged draft pull request.",
    "",
  ];
  if (context.validationCommands.length > 0) {
    lines.push(
      "Every change must pass the attested repository validation surface:",
      "",
      ...context.validationCommands.map((command) => `- \`${command}\``),
      "",
    );
  }
  if (defaultBranch) {
    lines.push(`Work executes on and targets the default branch \`${defaultBranch}\`.`, "");
  }
  if (protectionWarning !== null) {
    lines.push(protectionWarning, "");
  }
  lines.push(
    "Do not weaken `.github/agentify-task-policy.json`. Learned output is restricted",
    "to Agentify-owned knowledge paths and may not modify application source,",
    "dependencies, workflows, policy, or executable runtime code.",
    "",
    `Installation readiness, validation results, and consent state are recorded in`,
    `\`${INSTALLATION_REPORT_RELATIVE_PATH}\`.`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderInstallationDocuments(
  context: InstallationDocumentContext,
): Record<"AGENTS.md" | "SETUP.md", string> {
  return {
    "AGENTS.md": renderAgentsDocument(context),
    "SETUP.md": renderSetupDocument(context),
  };
}
