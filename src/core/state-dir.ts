import * as fs from "node:fs";
import * as path from "node:path";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  assertStateLayoutUsable,
  classifyStateLayout,
  formatStateLayoutGuidance,
  type StateLayoutClassification,
} from "./state-layout.ts";
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
  /** Absolute directory used by compatibility reads and writes in this phase. */
  absoluteDir: string;
  /** @deprecated Use `layout.fallback`. Retained to avoid caller shape churn. */
  legacy: boolean;
  /** Existing compatibility source used for this command. */
  sourceRelativeDir: string;
  /** Provider-selected destination. Phase B owns migration to this path. */
  destinationRelativeDir: string;
  /** Side-effect-free layout classification captured at command entry. */
  layout: StateLayoutClassification;
  /** Deterministic user-facing guidance; emit at most once per command. */
  guidance: string[];
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

/**
 * Resolve provider selection and compatibility source without mutating state.
 *
 * Phase A keeps reads and writes at `sourceRelativeDir`. It does not invoke a
 * cross-directory state transaction. Phase B will migrate retained legacy
 * state to `destinationRelativeDir` with copy -> verify -> atomic install.
 */
export function resolveCanonicalStateDir(
  cwd: string,
  targets: ReadonlyArray<AgentifyTarget>,
  additionalAgents?: ReadonlyArray<string>,
): ResolvedCanonicalStateDir {
  const selected = resolveStateDir(targets, additionalAgents);
  const layout = classifyStateLayout(cwd, selected.relativeDir);
  assertStateLayoutUsable(layout);
  const sourceRelativeDir = layout.sourceRelativeDir;
  return {
    relativeDir: sourceRelativeDir,
    provider: selected.provider,
    absoluteDir: path.join(cwd, sourceRelativeDir),
    // The old flag drove a stale brownfield-only message. Phase A callers use
    // layout.fallback plus the command-scoped guidance instead.
    legacy: false,
    sourceRelativeDir,
    destinationRelativeDir: selected.relativeDir,
    layout,
    guidance: formatStateLayoutGuidance(layout),
  };
}

export function __test__resolveStateDirFromProvider(
  provider: StateDirProvider,
): ResolvedStateDir {
  return { relativeDir: stateDirRelative(provider), provider };
}
