import * as path from "node:path";

/**
 * What to do when a staged file would clobber an unmanaged
 * pre-existing file at the canonical destination.
 *
 * - `"alongside"`: copy the agentify-owned content to a
 *   sibling path (`<basename>.agentify<ext>`) next to the user's
 *   file, leave the user's file untouched. Default.
 * - `"keep"`: leave the user's file, do not save agentify's
 *   version anywhere. The manifest records `preservedSha256` so
 *   `revert` knows the file was deliberately preserved.
 * - `"abort"`: record the conflict in the report; do not write
 *   anything. Only reachable when the user sets
 *   `requiredAction: "abort"` (or a per-path override) in
 *   `.agentifyrc`. The next run will see the same conflict
 *   unless the user resolves it.
 */
export type ConflictAction = "alongside" | "keep" | "abort";

export interface ApplyPolicyPathOverride {
  /** Glob pattern. `*` matches one path segment; `**` matches
   *  recursively. Literal paths match exactly. First match wins. */
  pattern: string;
  action: ConflictAction;
}

/**
 * Per-run apply policy. Resolved at the top of every audit from
 * the CLI defaults merged with `.agentifyrc` (see
 * `agentifyrc.ts`). The default is "alongside for all tiers" —
 * agentify never silently clobbers user files.
 */
export interface ApplyPolicy {
  /** Action for non-required conflicts with no per-path override. */
  defaultAction: ConflictAction;
  /** Per-path overrides, in priority order. First match wins. */
  paths: ReadonlyArray<ApplyPolicyPathOverride>;
  /** Action for *required* conflicts with no per-path override.
   *  Defaults to "alongside" — same as non-required — so a
   *  user's `AGENTS.md` is preserved and agentify's version is
   *  saved next to it. Set to "abort" in `.agentifyrc` to get
   *  the old loud-failure behavior back. */
  requiredAction: ConflictAction;
}

export const DEFAULT_APPLY_POLICY: ApplyPolicy = {
  defaultAction: "alongside",
  paths: [],
  requiredAction: "alongside",
};

/**
 * Compute the alongside path for a given canonical path. The
 * alongside file is placed in the same directory, with a
 * `.agentify<ext>` suffix on the basename. Examples:
 *
 * - `AGENTS.md`              -> `AGENTS.agentify.md`
 * - `specs/README.md`        -> `specs/README.agentify.md`
 * - `SETUP.md`               -> `SETUP.agentify.md`
 * - `Dockerfile`             -> `Dockerfile.agentify`
 * - `.env`                   -> `.env.agentify`
 *
 * The function is pure and deterministic — it does not touch
 * the filesystem. Callers (writers in `artifact-exporters.ts`
 * and `scaffold-installer.ts`, and the apply step in
 * `run-agentify.ts`) decide what to do with the result.
 */
export function alongsidePathFor(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const ext = path.extname(normalized);
  const base = path.basename(normalized, ext);
  const dir = path.dirname(normalized);
  const newBase = ext ? `${base}.agentify${ext}` : `${base}.agentify`;
  return dir === "." || dir === "" ? newBase : `${dir}/${newBase}`;
}

/**
 * Resolve the action for a given canonical path under a policy.
 * `isRequired` wins over per-path overrides (a required file
 * always consults `requiredAction`), which lets `.agentifyrc`
 * express "abort on AGENTS.md conflict" without listing every
 * required path explicitly.
 */
export function resolveActionForPath(
  policy: ApplyPolicy,
  relativePath: string,
  isRequired: boolean,
): ConflictAction {
  if (isRequired) return policy.requiredAction;
  for (const entry of policy.paths) {
    if (matchPattern(entry.pattern, relativePath)) return entry.action;
  }
  return policy.defaultAction;
}

/**
 * Match a relative path against a tiny glob pattern. Supports:
 *
 * - `*`  matches one path segment (no slashes)
 * - `**` matches zero or more segments (including slashes)
 * - literal text matches itself
 *
 * Examples (the `**` token below is the double-star glob):
 *
 * - matchPattern("AGENTS.md", "AGENTS.md")            -> true
 * - matchPattern("STAR-STAR/*.md", "specs/README.md") -> true
 * - matchPattern("specs/*.md", "specs/README.md")     -> true
 * - matchPattern("specs/*.md", "specs/sub/R.md")      -> false
 * - matchPattern("STAR-STAR", "x/y/z.txt")             -> true
 * - matchPattern("AGENTS.md", "SETUP.md")             -> false
 *
 * The matcher is intentionally minimal — it does not implement
 * brace expansion, character classes, or extglob syntax. If
 * `.agentifyrc` later needs those, swap in a real globber
 * (minimatch is already a transitive dep).
 */
export function matchPattern(pattern: string, value: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  const v = value.replace(/\\/g, "/");
  if (p === "**") return true;
  if (!p.includes("*")) return p === v;
  // Translate the glob into a regex. We do it in a single pass
  // to avoid the ordering bug where replacing `**` with `.*` first
  // and then `*` with `[^/]*` would corrupt the `.*` produced by
  // the first step. The `**/` -> `(?:.*/)?` rewrite handles the
  // common "recursive prefix" pattern (zero or more segments
  // followed by a slash); the `**` -> `.*` rewrite handles bare
  // recursive globs.
  const regexSource = p
    .replace(/[.+^${}()|[\]?\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (match) => {
      if (match === "**/") return "(?:.*/)?";
      if (match === "**") return ".*";
      return "[^/]*";
    });
  return new RegExp(`^${regexSource}$`).test(v);
}
