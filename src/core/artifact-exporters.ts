import * as fs from "node:fs";
import * as path from "node:path";
import { alongsidePathFor } from "./apply-policy.ts";
import { getAgentById, type AgentId } from "./agent-registry.ts";
import type { AgentifyTarget, ArtifactExportResult, ArtifactWrite } from "./types.ts";
import { shippedSkillsSourceDir } from "./shipped-paths.ts";
import { isFeatureAgentFilename } from "./artifacts/agent-file-conventions.ts";
import {
  AGENTIFY_MANAGED_MARKERS,
  MARKDOWN_MANAGED_MARKER,
  TOML_MANAGED_MARKER,
  addMarkdownManagedMarker,
} from "./artifacts/managed-markers.ts";

export interface ArtifactExporterOptions {
  cwd: string;
  packageRoot: string;
  /** Premium harness targets with full exporters (Codex / Claude / Pi). */
  targets: ReadonlyArray<AgentifyTarget>;
  /**
   * Non-premium agent IDs from the registry (Cursor / OpenCode /
   * Windsurf / etc.). Each gets only the generic skill-pack writer —
   * no feature-agent exports, no `CLAUDE.md`. The skillsDir for each
   * is looked up in the agent registry; universal agents (sharing
   * `.agents/skills` with Codex) are deduplicated against the premium
   * exporters.
   */
  additionalAgents?: ReadonlyArray<string>;
  /**
   * Skill names that may be written to the target repo. Names in
   * `packaged/skills/` not in this set are skipped. When omitted,
   * every packaged skill ships (the pre-curation behavior).
   *
   * Computed upstream by `skillsForClassification` from the project
   * classifier + tier frontmatter. See `src/core/skill-curation.ts`.
   */
  allowedSkills?: ReadonlySet<string>;
  /**
   * Set when the target repo already had an unmanaged AGENTS.md
   * before this run started. The Claude exporter uses this to skip
   * emitting a CLAUDE.md: deriving CLAUDE.md from a user-owned
   * AGENTS.md would silently overwrite the user's intent (the
   * apply step will also abort on the AGENTS.md required conflict
   * and report it through the orchestrator). See
   * `run-agentify.ts` `userOwnedAgentsMd` wiring.
   */
  userOwnedAgentsMd?: boolean;
}

interface AgentFile {
  name: string;
  description: string;
  body: string;
  filename: string;
}

function writeManagedFile(filePath: string, content: string, marker: string): ArtifactWrite {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (!existing.includes(marker)) {
      // User-owned file at the destination. Save agentify's
      // version alongside (`<basename>.agentify<ext>`) and
      // leave the user's file untouched.
      const alongside = alongsidePathFor(filePath);
      fs.mkdirSync(path.dirname(alongside), { recursive: true });
      fs.writeFileSync(alongside, content, { mode: 0o644 });
      return {
        path: filePath,
        action: "alongside",
        reason: "user file preserved; agentify's version saved alongside",
        alongsidePath: alongside,
      };
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return { path: filePath, action: "written" };
}

function copyManagedFile(source: string, destination: string, marker: string): ArtifactWrite {
  const raw = fs.readFileSync(source, "utf-8");
  const content = marker === MARKDOWN_MANAGED_MARKER
    ? addMarkdownManagedMarker(raw)
    : raw.includes(marker) ? raw : `${marker}\n${raw}`;
  return writeManagedFile(destination, content, marker);
}

function listSkillDirs(packageRoot: string): string[] {
  const skillsDir = shippedSkillsSourceDir(packageRoot);
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(skillsDir, entry.name));
}

function copyDirManaged(sourceDir: string, destinationDir: string, writes: ArtifactWrite[]): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copyDirManaged(source, destination, writes);
    } else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(source);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        copyDirManaged(real, destination, writes);
      } else {
        writes.push(copyManagedFile(real, destination, MARKDOWN_MANAGED_MARKER));
      }
    } else if (entry.isFile()) {
      writes.push(copyManagedFile(source, destination, MARKDOWN_MANAGED_MARKER));
    }
  }
}

function exportSkills(
  packageRoot: string,
  destinationRoot: string,
  writes: ArtifactWrite[],
  allowed?: ReadonlySet<string>,
): void {
  for (const sourceDir of listSkillDirs(packageRoot)) {
    const name = path.basename(sourceDir);
    if (allowed && !allowed.has(name)) continue; // Tier-excluded: skip silently.
    copyDirManaged(sourceDir, path.join(destinationRoot, name), writes);
  }
}

/**
 * Generic skill-pack writer: copies `packaged/skills/<name>` into
 * `<cwd>/<skillsDir>/<name>` for any registry entry. Used for all
 * non-premium agents and for any additional skillsDirs the user
 * selected via the picker. Does not write feature-agent files or
 * `CLAUDE.md` — only the skill pack itself.
 */
function exportSkillPackToDir(
  cwd: string,
  packageRoot: string,
  skillsDir: string,
  writes: ArtifactWrite[],
  allowed?: ReadonlySet<string>,
): void {
  exportSkills(packageRoot, path.join(cwd, skillsDir), writes, allowed);
}

function parseFrontmatter(content: string, fallbackName: string): AgentFile {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const body = match?.[2] ?? content;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? fallbackName;
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    ?? `Agentify specialist for ${name}`;
  return { name, description, body: body.trim(), filename: `${fallbackName}.md` };
}

function listFeatureAgents(cwd: string): AgentFile[] {
  const agentsDir = path.join(cwd, ".pi", "agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isFeatureAgentFilename(entry.name))
    .map((entry) => {
      const filePath = path.join(agentsDir, entry.name);
      return parseFrontmatter(fs.readFileSync(filePath, "utf-8"), path.basename(entry.name, ".md"));
    });
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function asTomlAgent(agent: AgentFile): string {
  return [
    TOML_MANAGED_MARKER,
    `name = "${escapeTomlBasicString(agent.name)}"`,
    `description = "${escapeTomlBasicString(agent.description)}"`,
    'developer_instructions = """',
    agent.body.replace(/"""/g, '\\"\\"\\"'),
    '"""',
    "",
  ].join("\n");
}

function asClaudeAgent(agent: AgentFile): string {
  return [
    MARKDOWN_MANAGED_MARKER,
    "---",
    `name: ${agent.name}`,
    `description: ${agent.description}`,
    "---",
    "",
    agent.body,
    "",
  ].join("\n");
}

function exportCodex(cwd: string, packageRoot: string, allowed?: ReadonlySet<string>): ArtifactExportResult {
  const writes: ArtifactWrite[] = [];
  exportSkills(packageRoot, path.join(cwd, ".agents", "skills"), writes, allowed);
  for (const agent of listFeatureAgents(cwd)) {
    writes.push(writeManagedFile(
      path.join(cwd, ".codex", "agents", `${agent.name}.toml`),
      asTomlAgent(agent),
      TOML_MANAGED_MARKER,
    ));
  }
  return { target: "codex", writes };
}

function exportClaude(cwd: string, packageRoot: string, allowed?: ReadonlySet<string>): ArtifactExportResult {
  const writes: ArtifactWrite[] = [];
  const agentsMd = path.join(cwd, "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    const content = fs.readFileSync(agentsMd, "utf-8");
    if (!content.includes(MARKDOWN_MANAGED_MARKER)) {
      // Source AGENTS.md is user-owned. Rather than fail the
      // entire Claude export, save the derived CLAUDE.md
      // alongside (`CLAUDE.agentify.md`) and let the apply
      // step decide what to do based on the user's policy.
      const claudeMd = path.join(cwd, "CLAUDE.md");
      const alongside = alongsidePathFor(claudeMd);
      fs.mkdirSync(path.dirname(alongside), { recursive: true });
      fs.writeFileSync(alongside, content, { mode: 0o644 });
      writes.push({
        path: claudeMd,
        action: "alongside",
        reason: "source AGENTS.md is not agentify-managed; derived CLAUDE.md saved alongside",
        alongsidePath: alongside,
      });
    } else {
      writes.push(writeManagedFile(
        path.join(cwd, "CLAUDE.md"),
        content,
        MARKDOWN_MANAGED_MARKER,
      ));
    }
  }
  exportSkills(packageRoot, path.join(cwd, ".claude", "skills"), writes, allowed);
  for (const agent of listFeatureAgents(cwd)) {
    writes.push(writeManagedFile(
      path.join(cwd, ".claude", "agents", `${agent.name}.md`),
      asClaudeAgent(agent),
      MARKDOWN_MANAGED_MARKER,
    ));
  }
  return { target: "claude", writes };
}

function exportPi(cwd: string, packageRoot: string, allowed?: ReadonlySet<string>): ArtifactExportResult {
  const writes: ArtifactWrite[] = [];
  // Pi's skillsDir per `AGENT_REGISTRY` (src/core/agent-registry.ts)
  // is `.pi/skills`. Earlier versions wrote to `.agents/skills`,
  // which silently matched Codex's universal dir but skipped the
  // per-harness location the registry documents. Writes now land at
  // `.pi/skills`; the dispatcher's `writtenDirs.add(".pi/skills")`
  // in `exportAgenticSurface` is then consistent with what's
  // actually on disk (bug fix).
  exportSkills(packageRoot, path.join(cwd, ".pi", "skills"), writes, allowed);
  return { target: "pi", writes };
}

/**
 * Drives the premium exporters (Codex / Claude / Pi) and the generic
 * skill-pack writer (for non-premium agents and any dedup'd skillsDirs).
 *
 * Tracks which project-relative skillsDirs the premium exporters have
 * already written to so the generic writer doesn't double-copy. Claude
 * Code's `.claude/skills` and Pi's `.pi/skills` are agent-specific and
 * never collide with other agents; Codex's `.agents/skills` collides
 * with every universal agent (Cursor / OpenCode / etc.) — only one
 * copy is written per run.
 */
export function exportAgenticSurface(options: ArtifactExporterOptions): ArtifactExportResult[] {
  const results: ArtifactExportResult[] = [];
  const writtenDirs = new Set<string>();
  const allowed = options.allowedSkills;

  // Premium exporters — each knows its own skillsDir.
  const userOwnedAgentsMd = options.userOwnedAgentsMd ?? false;
  for (const target of options.targets) {
    switch (target) {
      case "codex":
        results.push(exportCodex(options.cwd, options.packageRoot, allowed));
        writtenDirs.add(".agents/skills");
        break;
      case "claude":
        // When the user already owns AGENTS.md, the apply step
        // will abort on the required AGENTS.md conflict and the
        // orchestrator surfaces that as a "required generated file
        // conflict" error. Deriving a CLAUDE.md in that state would
        // be contradictory, so the Claude exporter skips both
        // CLAUDE.md and per-harness feature-agent files (which
        // are also derived from AGENTS.md ownership).
        if (userOwnedAgentsMd) {
          results.push({ target: "claude", writes: [] });
        } else {
          results.push(exportClaude(options.cwd, options.packageRoot, allowed));
        }
        writtenDirs.add(".claude/skills");
        break;
      case "pi":
        results.push(exportPi(options.cwd, options.packageRoot, allowed));
        writtenDirs.add(".pi/skills");
        break;
    }
  }

  // Non-premium agents via the generic writer. We iterate the registry
  // so every supported AgentId is handled; only the agents the user
  // picked (via `additionalAgents`) actually write.
  const additional = options.additionalAgents ?? [];
  if (additional.length > 0) {
    for (const id of additional) {
      const agent = getAgentById(id as AgentId);
      if (!agent) continue; // Unknown IDs are silently skipped.
      if (writtenDirs.has(agent.skillsDir)) continue; // Already written.
      const writes: ArtifactWrite[] = [];
      exportSkillPackToDir(options.cwd, options.packageRoot, agent.skillsDir, writes, allowed);
      writtenDirs.add(agent.skillsDir);
      results.push({ target: id, writes });
    }
  }

  return results;
}

export { AGENTIFY_MANAGED_MARKERS, addMarkdownManagedMarker };
