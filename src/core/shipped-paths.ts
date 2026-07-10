import * as path from "node:path";

/**
 * Path to the shipped skill pack relative to the package root.
 *
 * Single source of truth for the skill-pack location. Both
 * `artifact-exporters` (copying skills into a target repo) and
 * `pi-sdk-runtime` (registering `additionalSkillPaths` for in-process
 * greenfield / AIW sessions) derive their source directory from this
 * constant.
 *
 * Why `packaged/skills/` and not `.agents/skills/` at the repo root:
 * the maintainer package deliberately does not carry the skill pack in
 * any dotfolder that coding harnesses (Claude Code, Codex, ...) auto-
 * scan. Otherwise every session the maintainer opens the agentify repo
 * would auto-load every shipped skill into context — the shipped
 * build chain is meant for end users of `agentify`, not for the
 * maintainer of `agentify`. The installer still writes the dual
 * `.agents/skills/` + `.claude/skills/` layout into each *target*
 * repo, unchanged; see `src/core/artifact-exporters.ts::exportClaude`.
 */
export const SHIPPED_SKILLS_SUBDIR = path.join("packaged", "skills");

export function shippedSkillsSourceDir(packageRoot: string): string {
  return path.join(packageRoot, SHIPPED_SKILLS_SUBDIR);
}
