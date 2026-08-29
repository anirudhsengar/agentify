// CLI entry for `agentify`.

import { stdin as input, stdout as output, stderr as errOutput } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { packageRoot, PiSdkRuntime } from "./core/pi-sdk-runtime.ts";
import { readPackageVersion } from "./core/package-version.ts";
import { runAgentifyApp } from "./core/agentify-app.ts";
import {
  authPath,
  defaultConfigDir,
  loadAgentifyConfig,
} from "./core/agentify-config.ts";
import {
  dispatchSubcommand,
  type SubcommandContext,
} from "./core/cli-commands.ts";
import { parseCliArgs } from "./core/cli-parser.ts";
import { printPublicSubcommandHelp } from "./core/public-cli-contract.ts";
import { recoverTeamMemoryStore } from "./core/memory/index.ts";
import {
  finalizeOneTimeInstallation,
  formatOneTimeInstallationReport,
  inspectRepositoryForInstallation,
  prepareOneTimeInstallationState,
  repairInstalledRuntime,
  createRepositoryValidationApproval,
  readRepositoryTaskPolicyConfiguration,
  repositoryTaskPolicySchemaStatus,
  repositoryValidationApprovalCurrent,
  type GitHubConfigurationInput,
  type InstallerBlocker,
  type RepositoryInstallationPreflight,
  type RepositoryValidationApproval,
} from "./core/installer/index.ts";
import {
  beginPendingInstallation,
  rollbackPendingInstallation,
} from "./core/installer/installation-transaction.ts";
import { ClackUi, printBanner } from "./core/ui/index.ts";
import { getProviderEnvValue, isAgentifyProvider } from "./core/provider-auth.ts";
import { selectModelForRole } from "./core/models/resolver.ts";
import { AgentifyCredentialStore, createAgentifyModelRuntime } from "./core/pi-credential-store.ts";
import { registerBundledOAuthFlows } from "./core/register-bundled-oauth-flows.ts";

registerBundledOAuthFlows();

function printHelp(): void {
  output.write(`agentify ${readPackageVersion()}

Usage:
  agentify [options]
  agentify <subcommand> [subcommand-options]

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print the version and exit.

Install Agentify once in an existing GitHub repository. Agentify audits the
codebase, creates a persistent orchestrator and evidence-backed read-only
specialists, installs the controlled GitHub runtime, and verifies readiness.

After installation, authorized GitHub issues are the normal work interface.
Agentify plans with the orchestrator and specialists, gives exactly one builder
write authority on an isolated task branch, validates the change, obtains a
role-separated automated read-only review, and opens an unmerged draft pull request. A human
retains application merge authority.

Agentify-owned knowledge, procedures, lessons, specialist expertise, routing,
and derived views are designed to refresh after accepted repository changes
without another local CLI run. Learned output may update only the validated
Agentify knowledge allowlist; it cannot rewrite application source, executable
Agentify runtime code, dependencies, or policy.

`);
  printPublicSubcommandHelp(output);
}

function shouldPrintBanner(): boolean {
  return Boolean(input.isTTY);
}

function validationBlocked(
  preflight: RepositoryInstallationPreflight,
  code: Extract<InstallerBlocker["code"], "validation_consent_required" | "validation_policy_stale">,
  message: string,
): RepositoryInstallationPreflight {
  return {
    ...preflight,
    disposition: "analyzable-only",
    blockers: [
      ...preflight.blockers.filter((blocker) => (
        blocker.code !== "validation_consent_required" && blocker.code !== "validation_policy_stale"
      )),
      {
        code,
        message,
        remediation: "Rerun `agentify` in this repository so it can record installer attestation for the current screened validation commands.",
      },
    ],
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = parseCliArgs(argv);
  if (command.kind === "version") {
    // Preserves the one-line, machine-readable contract that shell
    // dotfiles and CI scripts depend on.
    output.write(`${readPackageVersion()}\n`);
    return;
  }
  if (shouldPrintBanner()) {
    printBanner(readPackageVersion());
  }
  if (command.kind === "help") {
    printHelp();
    return;
  }

  const ui = new ClackUi();
  if (command.kind === "subcommand") {
    const subcommandCtx: SubcommandContext = {
      cwd: process.cwd(),
      configDir: defaultConfigDir(),
      ui,
      out: output,
      err: errOutput,
    };
    await dispatchSubcommand(command.argv, subcommandCtx);
    return;
  }

  let installerPreflight = inspectRepositoryForInstallation({
    cwd: process.cwd(),
    runValidation: false,
  });
  if (!installerPreflight.analysis_allowed) {
    for (const blocker of installerPreflight.blockers) {
      ui.error(`agentify: blocker [${blocker.code}]: ${blocker.message} ${blocker.remediation}`);
    }
    throw new Error("repository is not safe to analyze or install; no Agentify files were changed");
  }
  const memoryRecovery = recoverTeamMemoryStore(process.cwd());
  if (memoryRecovery.status === "recovered") {
    ui.info(
      `agentify: recovered persistent agent memory (${memoryRecovery.repaired.join(", ")}).`,
    );
  }
  let validationApproval: RepositoryValidationApproval | null = null;
  const existingPolicy = readRepositoryTaskPolicyConfiguration(process.cwd());
  if (repositoryValidationApprovalCurrent({
    cwd: process.cwd(),
    preflight: installerPreflight,
    approval: existingPolicy?.validation_approval,
  })) {
    validationApproval = existingPolicy!.validation_approval;
  }

  if (installerPreflight.blockers.length === 0 && validationApproval === null) {
    validationApproval = createRepositoryValidationApproval({
      cwd: process.cwd(),
      preflight: installerPreflight,
      approvedBy: installerPreflight.identity?.actor_login ?? "maintainer",
    });
  }

  if (validationApproval !== null) {
    if (!repositoryValidationApprovalCurrent({ cwd: process.cwd(), preflight: installerPreflight, approval: validationApproval })) {
      validationApproval = null;
      installerPreflight = validationBlocked(
        installerPreflight,
        "validation_policy_stale",
        "The previously attested package manifest, lockfile, or validation command set has changed.",
      );
    } else {
      installerPreflight = inspectRepositoryForInstallation({ cwd: process.cwd(), runValidation: true });
      if (!repositoryValidationApprovalCurrent({ cwd: process.cwd(), preflight: installerPreflight, approval: validationApproval })) {
        validationApproval = null;
        installerPreflight = validationBlocked(
          installerPreflight,
          "validation_policy_stale",
          "The attested validation inputs changed while validation readiness was being established.",
        );
      }
    }
  } else if (installerPreflight.blockers.length === 0) {
    const legacy = repositoryTaskPolicySchemaStatus(process.cwd()) === "legacy";
    installerPreflight = validationBlocked(
      installerPreflight,
      legacy ? "validation_policy_stale" : "validation_consent_required",
      legacy
        ? "The schema-v1 task policy cannot establish validation consent and is not executable."
        : "Installer attestation for the repository-owned validation commands has not been recorded.",
    );
  }

  let repairedPaths: string[] = [];
  beginPendingInstallation(process.cwd());
  try {
    const repair = repairInstalledRuntime({
      cwd: process.cwd(),
      packageRoot: packageRoot(),
      agentifyVersion: readPackageVersion(),
      preflight: installerPreflight,
      validationApproval: validationApproval ?? undefined,
    });
    repairedPaths = repair.repaired_paths;
    if (repair.conflicts.length > 0) {
      installerPreflight = {
        ...installerPreflight,
        disposition: "analyzable-only",
        blockers: [
          ...installerPreflight.blockers,
          {
            code: "user_owned_workflow_conflict",
            message: `User-owned files conflict with ${repair.conflicts.length} required Agentify runtime path(s).`,
            remediation: "Review the preserved *.agentify.* files and explicitly resolve each workflow conflict.",
          },
        ],
      };
    }

    prepareOneTimeInstallationState(process.cwd(), installerPreflight);
  } catch (error) {
    rollbackPendingInstallation(process.cwd());
    throw error;
  }

  const validationConsentBlocked = installerPreflight.blockers.some((blocker) => (
    blocker.code === "validation_consent_required" || blocker.code === "validation_policy_stale"
  ));
  if (validationConsentBlocked) {
    ui.info("agentify: repository audit and issue intake remain disabled until installer attestation for the current validation commands is recorded.");
  } else {
    await runAgentifyApp({
      args: [],
      cwd: process.cwd(),
      ui,
      runtime: new PiSdkRuntime(),
      repositoryPreflight: installerPreflight,
    });
  }

  {
    const configDir = defaultConfigDir();
    const config = loadAgentifyConfig(configDir);
    let resolvedProvider: string | null = null;
    let resolvedModel: string | null = null;
    let providerVerified = false;
    let localApiKey: string | undefined;
    if (!validationConsentBlocked) {
      try {
        const environmentKey = config.provider
          ? getProviderEnvValue(config.provider)
          : undefined;
        localApiKey = environmentKey;
        const { modelRegistry: registry } = await createAgentifyModelRuntime({
          authFile: authPath(configDir),
          modelsFile: path.join(configDir, "models.json"),
          ...(config.provider && environmentKey
            ? { runtimeApiKey: { provider: config.provider, key: environmentKey } }
            : {}),
        });
        const resolved = selectModelForRole(registry, config, "primary");
        if (resolved) {
          resolvedProvider = resolved.model.provider;
          resolvedModel = resolved.model.id;
          providerVerified = true;
          if (!localApiKey && isAgentifyProvider(resolvedProvider)) {
            localApiKey = getProviderEnvValue(resolvedProvider);
          }
          if (!localApiKey) {
            const stored = new AgentifyCredentialStore(authPath(configDir));
            const cred = await stored.read(resolvedProvider);
            if (cred && cred.type === "api_key" && cred.key) {
              localApiKey = cred.key;
            }
          }
        }
      } catch (error) {
        ui.error(`agentify: provider/model readiness failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let providerSecret: GitHubConfigurationInput["providerSecret"];
    let credentialSecret: GitHubConfigurationInput["credentialSecret"];
    let automationSecret: GitHubConfigurationInput["automationSecret"];
    const credentialStore = new AgentifyCredentialStore(authPath(configDir));
    const storedCredentials = resolvedProvider ? await credentialStore.list() : [];
    if (storedCredentials.length > 0) {
      if (input.isTTY) {
        const kinds = [...new Set(storedCredentials.map((entry) => entry.type === "oauth" ? "OAuth subscription" : "API key"))].join(" and ");
        const choice = await ui.promptSelect(
          `Set the stored ${kinds} credential(s) as the PI_AUTH_JSON GitHub Actions secret now? This carries subscription sign-ins and API keys to the workflow; the payload is sent to GitHub only through stdin and is never logged or stored in the repository.`,
          [
            { label: "Skip — show secure setup guidance", value: "skip" },
            { label: "Set PI_AUTH_JSON with explicit consent", value: "set" },
          ],
        );
        if (choice === "set") {
          const raw = fs.readFileSync(authPath(configDir), "utf8");
          if (raw.trim()) credentialSecret = { name: "PI_AUTH_JSON", value: raw, explicitConsent: true };
        }
      }
    } else if (resolvedProvider && localApiKey) {
      providerSecret = { name: "PI_API_KEY", value: localApiKey, explicitConsent: true };
    } else if (input.isTTY && resolvedProvider) {
      const choice = await ui.promptSelect(
        "Set the provider API key as the PI_API_KEY GitHub Actions secret now? The value is sent to GitHub only through stdin and is never logged or stored in the repository.",
        [
          { label: "Skip — show secure setup guidance", value: "skip" },
          { label: "Set PI_API_KEY with explicit consent", value: "set" },
        ],
      );
      if (choice === "set") {
        const value = await ui.promptSecret("Provider API key for the PI_API_KEY Actions secret");
        if (value) providerSecret = { name: "PI_API_KEY", value, explicitConsent: true };
      }
    }
    if (input.isTTY) {
      const choice = await ui.promptSelect(
        "Set a dedicated GitHub automation token so Agentify-created pull requests trigger the repository's normal pull-request workflows and rotated OAuth credentials can be written back to PI_AUTH_JSON? The token is sent to GitHub only through stdin and is never logged or stored in the repository.",
        [
          { label: "Skip — use the built-in workflow token (PR-triggered workflows and OAuth token write-back may not run)", value: "skip" },
          { label: "Set AGENT_PAT (Contents + Pull requests + Secrets write)", value: "set" },
        ],
      );
      if (choice === "set") {
        const value = process.env.AGENT_PAT
          ?? await ui.promptSecret("GitHub automation token for the AGENT_PAT Actions secret");
        if (value) automationSecret = { name: "AGENT_PAT", value, explicitConsent: true };
      }
    }
    const report = finalizeOneTimeInstallation({
      cwd: process.cwd(),
      preflight: installerPreflight,
      agentifyVersion: readPackageVersion(),
      provider: resolvedProvider,
      model: resolvedModel,
      providerVerified,
      validationApproval: validationApproval ?? undefined,
      providerSecret,
      credentialSecret,
      automationSecret,
      repairedPaths,
    });
    for (const line of formatOneTimeInstallationReport(report)) {
      if (line.startsWith("Blocker")) ui.error(`agentify: ${line}`);
      else ui.info(`agentify: ${line}`);
    }
    if (!credentialSecret && !providerSecret && resolvedProvider) {
      if (storedCredentials.length > 0) {
        ui.info("agentify: carry the stored credentials to Actions with `gh secret set PI_AUTH_JSON < ~/.agentify/auth.json`; enter the value through stdin, never as a command argument.");
      } else {
        ui.info("agentify: configure the PI_API_KEY Actions secret with `gh secret set PI_API_KEY`; enter the value through stdin, never as a command argument.");
      }
    }
    if (!automationSecret) {
      ui.info("agentify: optional but recommended: configure AGENT_PAT with target-repository Contents, Pull requests, and Secrets read/write so Agentify-created pull requests trigger normal checks and rotated OAuth credentials persist; enter the token through stdin.");
    }
    if (report.disposition !== "ready") {
      throw new Error(`installation completed with readiness status ${report.disposition}`);
    }
    return;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agentify: ${message}\n`);
    process.exitCode = 1;
  });
}
