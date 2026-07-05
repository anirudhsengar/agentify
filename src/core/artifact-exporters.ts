import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentifyTarget, ArtifactExportResult, ArtifactWrite } from "./types.ts";

const MD_MARKER = "<!-- agentify:managed -->";
const TOML_MARKER = "# agentify:managed";

const RESERVED_AGENT_FILES = new Set([
  "scout.md",
  "review.md",
  "implement.md",
  "test.md",
  "fix.md",
  "document.md",
]);

export interface ArtifactExporterOptions {
  cwd: string;
  packageRoot: string;
  targets: ReadonlyArray<AgentifyTarget>;
}

interface AgentFile {
  name: string;
  description: string;
  body: string;
  filename: string;
}

function writeManagedFile(filePath: string, content: string, marker: string): ArtifactWrite {
  const relative = filePath;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (!existing.includes(marker)) {
      return {
        path: relative,
        action: "conflict",
        reason: "existing file is not agentify-managed",
      };
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return { path: relative, action: "written" };
}

function addMarkdownMarker(raw: string, marker: string): string {
  if (raw.includes(marker)) return raw;
  const frontmatter = raw.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  if (!frontmatter) return `${marker}\n${raw}`;
  return `${frontmatter[1]}${marker}\n${frontmatter[2]}`;
}

export function addMarkdownManagedMarker(raw: string): string {
  return addMarkdownMarker(raw, MD_MARKER);
}

function copyManagedFile(source: string, destination: string, marker: string): ArtifactWrite {
  const raw = fs.readFileSync(source, "utf-8");
  const content = marker === MD_MARKER
    ? addMarkdownManagedMarker(raw)
    : raw.includes(marker) ? raw : `${marker}\n${raw}`;
  return writeManagedFile(destination, content, marker);
}

function listSkillDirs(packageRoot: string): string[] {
  const skillsDir = path.join(packageRoot, ".agents", "skills");
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
        writes.push(copyManagedFile(real, destination, MD_MARKER));
      }
    } else if (entry.isFile()) {
      writes.push(copyManagedFile(source, destination, MD_MARKER));
    }
  }
}

function exportSkills(
  packageRoot: string,
  destinationRoot: string,
  writes: ArtifactWrite[],
): void {
  for (const sourceDir of listSkillDirs(packageRoot)) {
    const name = path.basename(sourceDir);
    copyDirManaged(sourceDir, path.join(destinationRoot, name), writes);
  }
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
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .filter((entry) => !RESERVED_AGENT_FILES.has(entry.name))
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
    TOML_MARKER,
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
    MD_MARKER,
    "---",
    `name: ${agent.name}`,
    `description: ${agent.description}`,
    "---",
    "",
    agent.body,
    "",
  ].join("\n");
}

function exportCodex(cwd: string, packageRoot: string): ArtifactExportResult {
  const writes: ArtifactWrite[] = [];
  exportSkills(packageRoot, path.join(cwd, ".agents", "skills"), writes);
  for (const agent of listFeatureAgents(cwd)) {
    writes.push(writeManagedFile(
      path.join(cwd, ".codex", "agents", `${agent.name}.toml`),
      asTomlAgent(agent),
      TOML_MARKER,
    ));
  }
  return { target: "codex", writes };
}

function exportClaude(cwd: string, packageRoot: string): ArtifactExportResult {
  const writes: ArtifactWrite[] = [];
  const agentsMd = path.join(cwd, "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    const content = fs.readFileSync(agentsMd, "utf-8");
    if (!content.includes(MD_MARKER)) {
      writes.push({
        path: path.join(cwd, "CLAUDE.md"),
        action: "conflict",
        reason: "source AGENTS.md is not agentify-managed",
      });
    } else {
      writes.push(writeManagedFile(
        path.join(cwd, "CLAUDE.md"),
        content,
        MD_MARKER,
      ));
    }
  }
  exportSkills(packageRoot, path.join(cwd, ".claude", "skills"), writes);
  for (const agent of listFeatureAgents(cwd)) {
    writes.push(writeManagedFile(
      path.join(cwd, ".claude", "agents", `${agent.name}.md`),
      asClaudeAgent(agent),
      MD_MARKER,
    ));
  }
  return { target: "claude", writes };
}

function exportPi(cwd: string, packageRoot: string): ArtifactExportResult {
  const writes: ArtifactWrite[] = [];
  exportSkills(packageRoot, path.join(cwd, ".agents", "skills"), writes);
  return { target: "pi", writes };
}

export function exportAgenticSurface(options: ArtifactExporterOptions): ArtifactExportResult[] {
  return options.targets.map((target) => {
    switch (target) {
      case "codex":
        return exportCodex(options.cwd, options.packageRoot);
      case "claude":
        return exportClaude(options.cwd, options.packageRoot);
      case "pi":
        return exportPi(options.cwd, options.packageRoot);
    }
  });
}

export const AGENTIFY_MANAGED_MARKERS = {
  markdown: MD_MARKER,
  toml: TOML_MARKER,
} as const;
