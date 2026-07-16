import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { resolveApplyPolicy } from "../agentifyrc.ts";
import { normalizeArtifactPath } from "../artifacts/generated-surface.ts";
import { readPackageVersion } from "../package-version.ts";
import { persistRunArtifacts } from "../revert.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import { installScaffoldRuntime } from "../scaffold-installer.ts";
import { inspectAgentifyRepoState } from "../repo-status.ts";
import {
  readManifestAt,
  type ManagedManifestFile,
} from "../manifest.ts";
import { resolveCanonicalStateDir } from "../state-dir.ts";
import {
  getOrCreateSessionId,
  setAgentifySessionActive,
  setThinkingLevel,
} from "../audit/state.ts";
import {
  validateGreenfieldArtifacts,
  writeGreenfieldStateAt,
} from "../greenfield-state.ts";
import {
  readGreenfieldFormationAt,
  renderGreenfieldArtifacts,
} from "../greenfield-artifacts.ts";
import { applyStagedBundle } from "../generation/apply-bundle.ts";
import { formatApplyReport } from "../generation/apply-report.ts";
import { collectAuditArtifactSnapshot } from "../generation/artifact-snapshot.ts";
import {
  addWriteMetadata,
  makeStagingRoot,
  writeRenderedArtifactsToStaging,
} from "../generation/staging-bundle.ts";
import { startSpinner, type SpinnerHandle } from "../ui/spinner.ts";
import { persistProjectState, reportGitHubReadiness } from "./project-state-reporter.ts";
import type { RunArtifactSnapshot, RunContext } from "./run-context.ts";

function toRel(cwd: string, filePath: string): string {
  return normalizeArtifactPath(path.relative(cwd, filePath));
}

export async function runGreenfield(context: RunContext): Promise<void> {
  const options = context;
  const config = context.config;
  options.ui.status("agentify: starting greenfield chat");
  const stateResolution = resolveCanonicalStateDir(
    options.cwd, options.targets, options.additionalAgents,
  );
  const stateDir = stateResolution.relativeDir;
  const artifactSnapshot: RunArtifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
  setThinkingLevel(config.thinkingLevel ?? "high");
  const sessionId = getOrCreateSessionId();
  setAgentifySessionActive(sessionId, true);
  const spinner: SpinnerHandle = startSpinner("starting greenfield chat…");
  let spinnerStopped = false;
  let result: Awaited<ReturnType<typeof options.runtime.runGreenfield>>;
  try {
    result = await options.runtime.runGreenfield({
      cwd: options.cwd,
      configDir: defaultConfigDir(),
      config,
      stateDir,
      signal: options.signal,
    });
    spinner.stop(
      result.aborted ? "greenfield session aborted" : "greenfield session complete",
      result.aborted ? "warn" : "success",
    );
    spinnerStopped = true;
  } finally {
    if (!spinnerStopped) {
      spinner.stop("greenfield session failed", "error");
      spinnerStopped = true;
    }
    setAgentifySessionActive(sessionId, false);
  }
  let scaffoldInstalled = 0;
  let scaffoldConflicts = 0;
  let artifactsValid = false;
  let validationReported = false;
  if (!result.aborted) {
    const formation = readGreenfieldFormationAt(options.cwd, stateDir);
    if (!formation) {
      options.ui.error(
        "agentify: greenfield session did not submit structured artifacts with write_greenfield_artifacts; scaffold was not installed.",
      );
    } else {
      const renderResult = renderGreenfieldArtifacts(formation);
      if (renderResult.errors.length > 0) {
        options.ui.error("agentify: greenfield structured artifacts failed deterministic rendering; scaffold was not installed.");
        for (const reason of renderResult.errors.slice(0, 8)) {
          options.ui.error(`agentify:   - ${reason}`);
        }
      } else {
        const stagingRoot = makeStagingRoot();
        options.ui.info(`agentify: staging greenfield bundle at ${stagingRoot}`);
        try {
          const metadata = new Map<string, ManagedManifestFile>();
          writeRenderedArtifactsToStaging(stagingRoot, renderResult.artifacts, metadata, "greenfield", stateDir);
          const stagedValidation = validateGreenfieldArtifacts(stagingRoot);
          if (!stagedValidation.ok) {
            options.ui.error(
              "agentify: greenfield artifacts did not pass the substance gate; scaffold was not installed.",
            );
            for (const reason of stagedValidation.reasons.slice(0, 8)) {
              options.ui.error(`agentify:   - ${reason}`);
            }
            validationReported = true;
          } else {
            const scaffoldWrites = installScaffoldRuntime({
              cwd: stagingRoot,
              packageRoot: packageRoot(),
            });
            addWriteMetadata(stagingRoot, scaffoldWrites, "scaffold-installer", metadata, "greenfield", stateDir);
            const runId = crypto.randomUUID();
            const previousManifest = readManifestAt(options.cwd, stateDir);
            persistRunArtifacts({
              cwd: options.cwd,
              stateDir,
              runId,
              snapshot: artifactSnapshot,
              previousManifest,
            });
            const applyResult = applyStagedBundle({
              cwd: options.cwd,
              stagingRoot,
              snapshot: artifactSnapshot,
              metadata,
              agentifyVersion: readPackageVersion(packageRoot()),
              mode: "greenfield",
              policy: resolveApplyPolicy(options.cwd, stateDir),
              runId,
              stateDir,
              manifestStateDir: stateResolution.layout.fallback ? null : stateDir,
            });
            const conflicts = applyResult.writes.filter((write) => write.action === "conflict");
            scaffoldInstalled = applyResult.writes
              .filter((write) => write.action === "written")
              .filter((write) => {
                const rel = toRel(options.cwd, write.path);
                return rel === "SETUP.md" || rel.startsWith(".github/");
              })
              .length;
            scaffoldConflicts = conflicts.length;
            for (const line of formatApplyReport(applyResult.writes, options.cwd)) {
              options.ui.info(line);
            }
            if (applyResult.requiredConflictCount > 0) {
              options.ui.error(
                "agentify: required greenfield generated file conflict(s) blocked apply; no bundle files were written.",
              );
              for (const conflict of conflicts.slice(0, 8)) {
                options.ui.error(`agentify:   - ${toRel(options.cwd, conflict.path)}: ${conflict.reason ?? "conflict"}`);
              }
            } else {
              const greenfieldState = writeGreenfieldStateAt(options.cwd, {
                turns: result.turns,
                costUsd: result.costUsd,
                aborted: result.aborted,
              }, stateDir);
              artifactsValid = greenfieldState.artifact_validation.ok;
              if (!artifactsValid) {
                options.ui.error(
                  "agentify: greenfield artifacts did not pass the substance gate after apply; scaffold readiness was blocked.",
                );
                for (const reason of greenfieldState.artifact_validation.reasons.slice(0, 8)) {
                  options.ui.error(`agentify:   - ${reason}`);
                }
                validationReported = true;
              }
            }
          }
        } finally {
          fs.rmSync(stagingRoot, { recursive: true, force: true });
          options.ui.info(`agentify: cleaned greenfield staging bundle at ${stagingRoot}`);
        }
      }
    }
    if (!artifactsValid) {
      const greenfieldState = writeGreenfieldStateAt(options.cwd, {
        turns: result.turns,
        costUsd: result.costUsd,
        aborted: result.aborted,
      }, stateDir);
      if (!validationReported && !greenfieldState.artifact_validation.ok) {
        options.ui.error("agentify: greenfield artifacts did not pass the substance gate; scaffold was not installed.");
        for (const reason of greenfieldState.artifact_validation.reasons.slice(0, 8)) {
          options.ui.error(`agentify:   - ${reason}`);
        }
      }
    }
  }
  const scaffoldSummary = result.aborted
    ? ")"
    : artifactsValid
      ? `, ${scaffoldInstalled} scaffold file(s) installed, ${scaffoldConflicts} conflict(s))`
      : ", scaffold not installed: artifact substance gate failed)";
  options.ui.info(
    `agentify: greenfield session complete (${result.turns} turn(s)` +
      `${result.costUsd === null ? "" : `, $${result.costUsd.toFixed(4)}`}` +
      `${scaffoldSummary}.`,
  );
  if (!result.aborted && artifactsValid) {
    reportGitHubReadiness(options);
    const repoState = inspectAgentifyRepoState(options.cwd, defaultConfigDir(), stateDir);
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "success",
      repoMode: "greenfield",
      repoStatus: repoState.status,
      featureAgentCount: repoState.featureAgentCount,
      latestLogPath: null,
    });
  } else if (!result.aborted) {
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "partial",
      repoMode: "greenfield",
      repoStatus: "partial",
      featureAgentCount: 0,
      latestLogPath: null,
    });
  } else {
    persistProjectState(options, {
      projectKind: "greenfield",
      runStatus: "aborted",
      repoMode: "greenfield",
      repoStatus: "partial",
      featureAgentCount: 0,
      latestLogPath: null,
    });
  }
}
