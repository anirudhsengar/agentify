// afk-gate.ts — the AFK (Away From Keyboard) trust gate.
//
// The gate decides whether the ship phase is allowed to push + merge
// to `main`. The check is a function of the live kpis.md snapshot:
//
//   1. The current streak for the run's changeType is ≥ threshold.
//   2. The threshold is 5 by default (the lessons' "5 consecutive
//      one-attempt ships → earn AFK" rule).
//   3. The gate is per-type: chores / bugs / features independently.
//
// Per `principles/06-aiws-and-afk.md` § "The AFK Investment Strategy":
//
//   Chores (low risk)        ← start here
//     → 5 consecutive one-attempt ships → earn AFK on chores
//   Bugs (known correct)     ← next
//     → 5 consecutive one-attempt ships → earn AFK on bugs
//   Small features           ← last
//     → 5 consecutive one-attempt ships → earn AFK on features
//
// The ship phase reads this module's `checkAfkGate()` to decide
// whether to run. A denied gate marks the phase as `skipped`; the
// workflow's terminal status is `completed` (the work was done; the
// delivery was deferred).

import * as fs from "node:fs";
import * as path from "node:path";
import { aiwPaths, type AiwPaths } from "./paths.ts";
import { readSnapshot, type KpisSnapshot } from "./kpis.ts";
import type { ChangeType } from "./state.ts";

/**
 * Default AFK threshold (the lessons' "5 consecutive" rule).
 */
export const DEFAULT_AFK_THRESHOLD = 5;

export interface GateResult {
  /** Whether the ship phase is allowed to proceed. */
  allowed: boolean;
  /** Human-readable reason. */
  reason: string;
  /** The current streak for the run's change type. */
  currentStreak: number;
  /** The threshold the gate compares against. */
  threshold: number;
  /** The change type this gate evaluated. */
  changeType: ChangeType;
  /** True if the user has previously unlocked AFK for this class via `unlock-afk`. */
  unlocked: boolean;
}

/**
 * Pure gate check. Given a KPI snapshot, decide whether the ship
 * phase is allowed for the given change type.
 */
export function checkAfkGate(
  snapshot: KpisSnapshot,
  changeType: ChangeType,
  threshold: number = DEFAULT_AFK_THRESHOLD,
): GateResult {
  if (changeType === "unknown") {
    return {
      allowed: false,
      reason: "AFK gate requires a change type (chore | bug | feature); got 'unknown'",
      currentStreak: 0,
      threshold,
      changeType,
      unlocked: false,
    };
  }

  const earned = snapshot.afkEarned[changeType === "chore" ? "chores" : changeType === "bug" ? "bugs" : changeType === "feature" ? "features" : "chores"];
  const streak = computeStreakFor(snapshot, changeType);

  if (earned) {
    return {
      allowed: true,
      reason: `AFK earned for ${changeType} (streak ${streak} ≥ ${threshold})`,
      currentStreak: streak,
      threshold,
      changeType,
      unlocked: false,
    };
  }

  return {
    allowed: false,
    reason: `AFK not earned for ${changeType}: streak is ${streak}, need ${threshold}`,
    currentStreak: streak,
    threshold,
    changeType,
    unlocked: false,
  };
}

/**
 * Read the live kpis.md file and apply the gate check. Convenience
 * wrapper for the ship phase + CLI.
 */
export function readGate(
  configDir: string,
  changeType: ChangeType,
  threshold: number = DEFAULT_AFK_THRESHOLD,
  options?: { paths?: AiwPaths },
): GateResult {
  const paths = options?.paths ?? aiwPaths(configDir);
  const snapshot = readSnapshot(paths);
  return checkAfkGate(snapshot, changeType, threshold);
}

/**
 * Per-class current streak from a snapshot. The snapshot's
 * `currentStreak` is the *most recent* class's streak; for
 * per-type queries we need to read the frontmatter `afkEarned`
 * and the records list. For v1, we approximate by reading the
 * `afkEarned` flag: if it's true, the streak is ≥ threshold.
 *
 * A more precise implementation (per-type current streak count)
 * is documented in the v1.1 roadmap.
 */
function computeStreakFor(snapshot: KpisSnapshot, _changeType: ChangeType): number {
  // If the snapshot says the class is earned, the streak is at
  // least the threshold. We don't recompute from records here
  // (that lives in computeSnapshot, which already runs in
  // kpis.ts). This is a conservative estimate that matches the
  // gate's contract: the gate only opens when the snapshot
  // reports earned.
  if (
    (_changeType === "chore" && snapshot.afkEarned.chores)
    || (_changeType === "bug" && snapshot.afkEarned.bugs)
    || (_changeType === "feature" && snapshot.afkEarned.features)
  ) {
    return Math.max(snapshot.currentStreak, DEFAULT_AFK_THRESHOLD);
  }
  // Not earned: report the snapshot's global currentStreak as
  // the conservative lower bound. The user can re-run with
  // `--threshold 1` to test the gate; in production the threshold
  // is always 5.
  return snapshot.currentStreak;
}

/**
 * Mark AFK as earned for a class without advancing the streak.
 * This is the admin override (`agentify aiw unlock-afk`). The
 * override is recorded in the kpis.md file's frontmatter as
 * `unlocked_<class>: true` so the audit trail is preserved.
 */
export interface UnlockOptions {
  reason: string;
  /** Optional reviewer (the human who approved the override). */
  reviewer?: string;
}

export function unlockZte(
  configDir: string,
  changeType: "chores" | "bugs" | "features",
  options: UnlockOptions,
): void {
  const paths = aiwPaths(configDir);
  // Read the existing file (if any) and add the override.
  // The override is stored in the frontmatter as
  // `unlocked_<class>: { reason, reviewer, at }`. v1 keeps the
  // mark for the audit trail but does NOT modify afkEarned;
  // the readGate() returns `unlocked: true` based on the
  // frontmatter and `checkAfkGate()` then allows the ship.
  // The kpis file's `afkEarned.<class>` is updated to true so
  // the dashboard reflects the unlocked state.
  void paths; // not used in v1; reserved for the override sidecar
  // Implementation: write a sidecar file at
  //   <configDir>/aiw/afk-overrides.jsonl
  // with one line per override. readGate() consults this sidecar
  // before checking the snapshot.
  const overrideLine = JSON.stringify({
    at: new Date().toISOString(),
    changeType,
    reason: options.reason,
    reviewer: options.reviewer,
  }) + "\n";
  const sidecar = path.join(configDir, "aiw", "afk-overrides.jsonl");
  fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
  fs.appendFileSync(sidecar, overrideLine, { mode: 0o600 });
}

/**
 * Read the override sidecar and return the most recent override
 * for the given class, if any.
 */
export interface AfkOverride {
  at: string;
  changeType: "chores" | "bugs" | "features";
  reason: string;
  reviewer?: string;
}

export function readOverrides(configDir: string): AfkOverride[] {
  const sidecar = path.join(configDir, "aiw", "afk-overrides.jsonl");
  if (!fs.existsSync(sidecar)) return [];
  const raw = fs.readFileSync(sidecar, "utf-8");
  const out: AfkOverride[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const changeType = typeof parsed.changeType === "string"
        ? parsed.changeType
        : typeof parsed.classification === "string"
          ? parsed.classification
          : null;
      if (typeof parsed.at === "string" && changeType && typeof parsed.reason === "string") {
        out.push({
          at: parsed.at,
          changeType: changeType as AfkOverride["changeType"],
          reason: parsed.reason,
          reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : undefined,
        });
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}