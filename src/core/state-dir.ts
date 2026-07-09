// state-dir.ts — single source of truth for where the agentify audit
// writes its internal state and canonical scratch surface.
//
// Historical note: agentify originated as a Pi extension called
// "GreenField." Every internal path was therefore hardcoded under
// `.pi/agentify/...`. When the packaging changed (ADR 0008,
// accepted 2026-07-09) agentify became a standalone npm package —
// but the `.pi/` prefix was kept. Per ADR 0020, this module is the
// one and only place that decides the audit's state dir, derived
// from the user's selected coding-agent targets.
//
// Why it is provider-scoped: the audit produces both internal
// state (codebase_map, manifest, logs) and the canonical
// "feature-agent / expert / workflow / skill / extension" scratch
// surface that the exporters fan out to per-harness dotdirs. Both
// live under the same resolved state dir so a fresh run lands in
// the dotdir the user explicitly picked.
//
// The per-harness output dirs (`.claude/agents/`, `.codex/agents/`,
// `.pi/skills/`, `.agents/skills/`, `.claude/skills/`, …) are
// unchanged — they remain registry-driven fan-out destinations
// driven by `artifact-exporters.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentifyTarget } from "./types.ts";

/**
 * Which dotdir family owns the audit's state. Maps to the
 * `skillsDir` parent of each premium agent in
 * `src/core/agent-registry.ts`:
 *
 *   claude-code → `.claude/skills`  → parent `.claude`
 *   codex       → `.agents/skills`  → parent `.agents`
 *   pi          → `.pi/skills`      → parent `.pi`
 *   universal   → fallthrough for users who picked only non-premium
 *                 agents; uses `.agents/` (Codex / Cursor / OpenCode
 *                 / … convention).
 */
export type StateDirProvider = "codex" | "claude" | "pi" | "universal";

/**
 * Resolved state-dir metadata returned by `resolveStateDir`. The
 * `relativeDir` is posix-style (no trailing slash) and safe to use
 * as a key in manifest entries.
 */
export interface ResolvedStateDir {
  /** Posix-style relative path, e.g. `.claude/agentify`. */
  relativeDir: string;
  /** Provider whose dotdir owns the state. */
  provider: StateDirProvider;
}

/**
 * Legacy `.pi/agentify` location. Hardcoded across the codebase
 * before ADR 0020. Detected at run time so existing repos keep
 * working until the user moves them by hand.
 */
export const LEGACY_PI_STATE_RELATIVE_DIR = ".pi/agentify";

/**
 * Map a `StateDirProvider` to its relative `agentify/` subdir.
 * `universal` resolves to `.agents/agentify` (Codex's dir), the
 * convention shared by Codex / Cursor / OpenCode / Warp / …
 */
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

/**
 * Resolve the state-dir provider + relative path from the user's
 * selected targets.
 *
 * Precedence (matches the existing premium-exporter dispatch order
 * in `artifact-exporters.ts`):
 *
 *   claude in pick      → `.claude/agentify/`
 *   codex in pick       → `.agents/agentify/` (Codex's dotdir;
 *                          also shared by every universal agent)
 *   pi in pick          → `.pi/agentify/` (kept so picking Pi does
 *                          not silently switch the state dir)
 *   only non-premium    → `.agents/agentify/`
 *
 * The `additionalAgents` parameter is accepted for API symmetry
 * but does not currently influence the dispatch — the picker
 * classification of an ID as premium vs. non-premium is the
 * signal that matters here. Kept in the signature so a future
 * refinement (e.g., a "store under cursor's dotdir when only
 * cursor is picked") can layer on without churning callers.
 */
export function resolveStateDir(
  targets: ReadonlyArray<AgentifyTarget>,
  additionalAgents?: ReadonlyArray<string>,
): ResolvedStateDir {
  void additionalAgents; // intentionally unused; see JSDoc above
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
 * True iff a legacy `.pi/agentify` directory exists at the repo
 * root. Used by `resolveCanonicalStateDir` for the read-only
 * migration path.
 */
export function isLegacyPiState(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
}

/**
 * Resolve the absolute state-dir path the audit should write to.
 *
 * Rules:
 *
 *   1. If the *new* resolved dir already exists on disk, use it.
 *   2. Otherwise, if a legacy `.pi/agentify/` exists on disk,
 *      use that and return `legacy: true`. The audit logs one
 *      info line so the user knows to move files.
 *   3. Otherwise, use the new resolved dir (the audit creates it
 *      on first write) and return `legacy: false`.
 *
 * The audit calls this once at the top of `runBrownfieldAudit` /
 * `runGreenfield` and threads `absoluteDir` through every writer.
 */
export function resolveCanonicalStateDir(
  cwd: string,
  targets: ReadonlyArray<AgentifyTarget>,
  additionalAgents?: ReadonlyArray<string>,
): ResolvedStateDir & { absoluteDir: string; legacy: boolean } {
  const resolved = resolveStateDir(targets, additionalAgents);
  const newDir = path.join(cwd, resolved.relativeDir);
  if (fs.existsSync(newDir)) {
    return { ...resolved, absoluteDir: newDir, legacy: false };
  }
  if (isLegacyPiState(cwd)) {
    const legacyDir = path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR);
    return { ...resolved, absoluteDir: legacyDir, legacy: true };
  }
  return { ...resolved, absoluteDir: newDir, legacy: false };
}

/**
 * Test-only bypass: return a `ResolvedStateDir` for a known
 * provider without going through `resolveStateDir` / the picker.
 *
 * Production code MUST use `resolveCanonicalStateDir` so the
 * legacy fallback is honored. This helper exists for tests that
 * want to assert behavior under a specific state-dir provider
 * without re-implementing the dispatch.
 *
 * @internal
 */
export function __test__resolveStateDirFromProvider(
  provider: StateDirProvider,
): ResolvedStateDir {
  return { relativeDir: stateDirRelative(provider), provider };
}
