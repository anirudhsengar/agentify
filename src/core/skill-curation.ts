import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectClassification } from "./project-classifier.ts";
import { shippedSkillsSourceDir } from "./shipped-paths.ts";

/**
 * Skill tier as recorded in `packaged/skills/<name>/SKILL.md`
 * frontmatter (`tier: core | opt-in`).
 *
 * - `core` — ships by default to every target repo. The descriptions of
 *   model-invoked core skills sit in the agent's system prompt; user-invoked
 *   core skills are reachable by name.
 * - `opt-in` — does not ship by default. The installer pulls an opt-in
 *   only when the project classifier recommends it for the project's
 *   classification. Some opt-ins are *manual* (never auto-shipped) and
 *   must be copied from `packaged/skills/` by hand.
 */
export type SkillTier = "core" | "opt-in";

/** Default tier when a skill's frontmatter omits `tier:`. */
export const DEFAULT_SKILL_TIER: SkillTier = "core";

/** Parsed shape of a `SKILL.md` frontmatter block (body not included). */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Defaults to `DEFAULT_SKILL_TIER` when the field is absent. */
  tier: SkillTier;
  /** True when the skill has `disable-model-invocation: true`. */
  disableModelInvocation: boolean;
}

/**
 * Opt-in skills that the classifier auto-installs based on project kind
 * and confidence:
 *
 * - `greenfield` → `prototype` (recommended for design exploration)
 * - `brownfield` → the maintenance + AFK runtime skills
 * - `ambiguous`  → none (stays at core)
 *
 * Confidence-gated: opt-ins auto-install only on `high` confidence. A
 * `medium` or `low` confidence result keeps the repo at core only —
 * better to under-install than to push skills onto a repo that doesn't
 * match the recommendation.
 */
const OPT_IN_BY_KIND: Readonly<Record<ProjectClassification["kind"], ReadonlyArray<string>>> = {
  greenfield: ["prototype"],
  brownfield: ["scaffold-ci", "refresh-surface", "improve-codebase-architecture", "scout-then-plan"],
  ambiguous: [],
};

/** Opt-ins that never auto-install — manual-copy only. */
export const MANUAL_OPT_IN: ReadonlyArray<string> = [
  "handoff",
  "writing-great-skills",
];

/**
 * Parse the YAML frontmatter at the top of a `SKILL.md` file. Tolerates
 * a missing `tier:` field (defaults to `core`) and an absent
 * `disable-model-invocation:` (defaults to `false`). Throws when the
 * file has no frontmatter block at all — every skill must have one.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    throw new Error("SKILL.md is missing a YAML frontmatter block");
  }
  const fm = match[1];

  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] ?? "").trim();
  if (!name) {
    throw new Error("SKILL.md frontmatter is missing required `name:` field");
  }
  const description = (fm.match(/^description:\s*(.+)$/m)?.[1] ?? "").trim();
  if (!description) {
    throw new Error(`SKILL.md frontmatter for "${name}" is missing required \`description:\` field`);
  }
  const tierRaw = fm.match(/^tier:\s*(\S+)\s*$/m)?.[1];
  let tier: SkillTier;
  if (tierRaw === undefined || tierRaw === "") {
    tier = DEFAULT_SKILL_TIER;
  } else if (tierRaw === "core" || tierRaw === "opt-in") {
    tier = tierRaw;
  } else {
    throw new Error(
      `SKILL.md for "${name}" has invalid \`tier:\` value "${tierRaw}" — must be "core" or "opt-in"`,
    );
  }
  const disableModelInvocation = /^disable-model-invocation:\s*true\s*$/m.test(fm);

  return { name, description, tier, disableModelInvocation };
}

/**
 * Read a single skill's frontmatter from disk. Convenience wrapper
 * around `parseSkillFrontmatter` for callers that have the path.
 */
export function readSkillFrontmatter(skillFilePath: string): SkillFrontmatter {
  return parseSkillFrontmatter(fs.readFileSync(skillFilePath, "utf-8"));
}

/**
 * List every skill directory under `packaged/skills/`. Returns just the
 * basenames — the caller decides what to do with them.
 */
export function listPackagedSkillNames(packageRoot: string): string[] {
  const dir = shippedSkillsSourceDir(packageRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read every packaged skill's tier into a map. Skills that can't be
 * read (missing file, malformed frontmatter) default to `core` —
 * matching the pre-tier "everything ships" behavior. A malformed skill
 * shouldn't disable itself by being unreadable; the export step will
 * surface the parse error separately.
 */
export function readPackagedSkillTiers(packageRoot: string): Map<string, SkillTier> {
  const tiers = new Map<string, SkillTier>();
  for (const name of listPackagedSkillNames(packageRoot)) {
    const skillPath = path.join(shippedSkillsSourceDir(packageRoot), name, "SKILL.md");
    let tier: SkillTier = DEFAULT_SKILL_TIER;
    try {
      tier = readSkillFrontmatter(skillPath).tier;
    } catch {
      // Default to core; the export step will fail loudly if the
      // SKILL.md itself is malformed.
    }
    tiers.set(name, tier);
  }
  return tiers;
}

/**
 * Decide which skills ship to a target repo given its project
 * classification and the pre-read tier map.
 *
 * Rules:
 * - Every `core` skill ships.
 * - `opt-in` skills ship only when the classifier recommends them, and
 *   only on `high` confidence.
 * - Skills present in `packagedSkillTiers` are partitioned into core /
 *   opt-in. Any name not in the map is silently ignored — protects
 *   against stale callsites and typos in the recommendation table.
 *
 * Returns three sets so callers can render diagnostics (e.g. "you got
 * `prototype` because this is a greenfield repo").
 */
export function skillsForClassification(
  classification: ProjectClassification,
  packagedSkillTiers: ReadonlyMap<string, SkillTier>,
): { core: Set<string>; optIn: Set<string>; shipped: Set<string> } {
  const core = new Set<string>();
  const optIn = new Set<string>();

  for (const [name, tier] of packagedSkillTiers) {
    if (tier === "core") core.add(name);
    else optIn.add(name);
  }

  const recommended = OPT_IN_BY_KIND[classification.kind] ?? [];
  const isHighConfidence = classification.confidence === "high";
  const optInShipped = isHighConfidence
    ? new Set(recommended.filter((name) => optIn.has(name)))
    : new Set<string>();

  const shipped = new Set<string>([...core, ...optInShipped]);

  return { core, optIn: optInShipped, shipped };
}