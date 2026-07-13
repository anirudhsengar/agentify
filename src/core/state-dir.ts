import * as fs from "node:fs";
import * as path from "node:path";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  StateLayoutError,
  assertStateLayoutUsable,
  classifyStateLayout,
  formatStateLayoutGuidance,
  inspectStateTree,
  type StateLayoutClassification,
} from "./state-layout.ts";
import {
  migrateRetainedState,
  recoverInterruptedStateTransactions,
} from "./state-transaction.ts";
import type { AgentifyTarget } from "./types.ts";

export {
  KNOWN_STATE_RELATIVE_DIRS,
  LEGACY_PI_STATE_RELATIVE_DIR,
  StateLayoutError,
  assertStateLayoutUsable,
  classifyStateLayout,
  discoverExistingStateDir,
  formatStateLayoutGuidance,
  inspectStateTree,
} from "./state-layout.ts";
export type {
  DiscoveredStateDir,
  StateLayoutClassification,
  StateLayoutKind,
  StateTreeInspection,
  StateTreeStatus,
} from "./state-layout.ts";

export type StateDirProvider = "codex" | "claude" | "pi" | "universal";

export interface ResolvedStateDir {
  /** Posix-style active state path for this operation. */
  relativeDir: string;
  /** Provider whose dotdir owns the selected destination. */
  provider: StateDirProvider;
}

export interface ResolvedCanonicalStateDir extends ResolvedStateDir {
  /** Absolute provider-scoped canonical directory. */
  absoluteDir: string;
  /** @deprecated Use `layout.fallback`. Retained to avoid caller shape churn. */
  legacy: boolean;
  /** State tree used by this command after recovery/migration. */
  sourceRelativeDir: string;
  /** Provider-selected canonical destination. */
  destinationRelativeDir: string;
  /** Side-effect-free post-recovery layout classification. */
  layout: StateLayoutClassification;
  /** Deterministic user-facing guidance; emit at most once per command. */
  guidance: string[];
  /** Interrupted transaction IDs recovered before layout classification. */
  recoveredTransactions: string[];
  /** Migration transaction ID when legacy state was installed canonically. */
  migrationRunId: string | null;
}


export interface ResolveCanonicalStateDirOptions {
  /** Explicit user approval for a provider-to-provider retained-source migration. */
  allowProviderSwitchMigration?: boolean;
}

export function stateDirRelative(provider: StateDirProvider): string {
  switch (provider) {
    case "claude":
      return ".claude/agentify";
    case "codex":
      return ".agents/agentify";
    case "pi":
      return LEGACY_PI_STATE_RELATIVE_DIR;
    case "universal":
      return ".agents/agentify";
  }
}

export function resolveStateDir(
  targets: ReadonlyArray<AgentifyTarget>,
  additionalAgents?: ReadonlyArray<string>,
): ResolvedStateDir {
  void additionalAgents;
  if (targets.includes("claude")) {
    return { relativeDir: stateDirRelative("claude"), provider: "claude" };
  }
  if (targets.includes("codex")) {
    return { relativeDir: stateDirRelative("codex"), provider: "codex" };
  }
  if (targets.includes("pi")) {
    return { relativeDir: stateDirRelative("pi"), provider: "pi" };
  }
  return { relativeDir: stateDirRelative("universal"), provider: "universal" };
}

/**
 * @deprecated Existence-only compatibility probe. New production code must use
 * `classifyStateLayout` or `resolveCanonicalStateDir`.
 */
export function isLegacyPiState(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
}

function assertMigrationDecisionIsUnambiguous(layout: StateLayoutClassification): void {
  if (
    layout.kind === "empty" &&
    layout.otherProviderStateDirs.length > 0
  ) {
    throw new StateLayoutError(
      "multiple_state_dirs",
      `selected state directory ${layout.selectedRelativeDir} is empty while existing provider state is present at ${layout.otherProviderStateDirs.join(", ")}; no files were changed. Select the owning provider or move/archive the other tree before switching providers.`,
    );
  }
  if (layout.kind === "partial" && layout.fallback) {
    throw new StateLayoutError(
      "partial",
      `legacy state at ${LEGACY_PI_STATE_RELATIVE_DIR} is partial and cannot be migrated safely to ${layout.selectedRelativeDir}; no files were changed. Repair or archive the legacy tree before retrying.`,
    );
  }
}

/**
 * Resolve provider selection, recover interrupted transactions, and migrate a
 * complete non-Pi legacy tree with copy -> verify -> atomic install.
 *
 * `.pi/agentify` remains canonical when Pi is selected. For Claude, Codex, and
 * universal selections, legacy-only state is copied to the selected canonical
 * path while the original legacy tree remains unchanged.
 */
export function resolveCanonicalStateDir(
  cwd: string,
  targets: ReadonlyArray<AgentifyTarget>,
  additionalAgents?: ReadonlyArray<string>,
  options: ResolveCanonicalStateDirOptions = {},
): ResolvedCanonicalStateDir {
  const recoveredTransactions = recoverInterruptedStateTransactions(cwd);
  const selected = resolveStateDir(targets, additionalAgents);
  let layout = classifyStateLayout(cwd, selected.relativeDir);
  assertStateLayoutUsable(layout);
  if (!options.allowProviderSwitchMigration) {
    assertMigrationDecisionIsUnambiguous(layout);
  }

  const guidance = recoveredTransactions.map(
    (runId) => `agentify: recovered interrupted state transaction ${runId}.`,
  );
  let migrationRunId: string | null = null;

  const automaticLegacyMigration = layout.kind === "legacy_only"
    && selected.relativeDir !== LEGACY_PI_STATE_RELATIVE_DIR;
  let providerSwitchSource: string | null = null;
  if (
    !automaticLegacyMigration
    && options.allowProviderSwitchMigration
    && layout.kind === "empty"
    && layout.otherProviderStateDirs.length === 1
  ) {
    const candidateSource = layout.otherProviderStateDirs[0]!;
    const inspection = inspectStateTree(cwd, candidateSource);
    if (
      inspection.status !== "valid"
      || inspection.manifestStateDir !== candidateSource
    ) {
      throw new StateLayoutError(
        "multiple_state_dirs",
        `provider-switch source ${candidateSource} is not an explicit valid canonical state tree; no files were changed`,
      );
    }
    providerSwitchSource = candidateSource;
  }

  if (automaticLegacyMigration || providerSwitchSource !== null) {
    const migrationSource = providerSwitchSource ?? LEGACY_PI_STATE_RELATIVE_DIR;
    const rewriteManifestStateDir = providerSwitchSource !== null
      || layout.legacy.ownershipEvidence.includes("manifest.json");
    const migration = migrateRetainedState({
      cwd,
      sourceRelativeDir: migrationSource,
      destinationRelativeDir: selected.relativeDir,
      rewriteManifestStateDir,
    });
    migrationRunId = migration.runId;
    guidance.push(
      providerSwitchSource === null
        ? `agentify: migrating retained legacy state ${LEGACY_PI_STATE_RELATIVE_DIR} -> ${selected.relativeDir} (transaction ${migration.runId}).`
        : `agentify: migrating retained provider state ${migrationSource} -> ${selected.relativeDir} (transaction ${migration.runId}).`,
      providerSwitchSource === null
        ? `agentify: state migration committed at ${selected.relativeDir}; legacy state remains at ${LEGACY_PI_STATE_RELATIVE_DIR}.`
        : `agentify: provider-switch migration committed at ${selected.relativeDir}; prior state remains at ${migrationSource}.`,
    );
    layout = classifyStateLayout(cwd, selected.relativeDir);
    assertStateLayoutUsable(layout);
    const expectedLayout = rewriteManifestStateDir ? "canonical_only" : "dual_identical";
    if (layout.kind !== expectedLayout) {
      throw new StateLayoutError(
        layout.kind,
        `state migration ${migration.runId} completed but canonical authority was not established at ${selected.relativeDir}; no further repository writes were attempted`,
      );
    }
  } else {
    assertMigrationDecisionIsUnambiguous(layout);
    guidance.push(...formatStateLayoutGuidance(layout));
  }

  const sourceRelativeDir = selected.relativeDir;
  return {
    relativeDir: selected.relativeDir,
    provider: selected.provider,
    absoluteDir: path.join(cwd, selected.relativeDir),
    legacy: false,
    sourceRelativeDir,
    destinationRelativeDir: selected.relativeDir,
    layout,
    guidance,
    recoveredTransactions,
    migrationRunId,
  };
}

export function __test__resolveStateDirFromProvider(
  provider: StateDirProvider,
): ResolvedStateDir {
  return { relativeDir: stateDirRelative(provider), provider };
}
