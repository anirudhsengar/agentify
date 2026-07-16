export const GENERATED_SURFACE_PATHS = [
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "specs/README.md",
  "ai_docs/README.md",
  "conditional_docs.md",
  ".pi/conditional_docs.md",
  "SETUP.md",
  ".pi/agents",
  ".pi/prompts",
  ".pi/workflows",
  ".pi/extensions",
  ".pi/skills",
  ".agents",
  ".claude",
  ".codex",
  ".github/actions",
  ".github/agent-prompts",
  ".github/scripts",
  ".github/workflows",
  "app_docs",
  "app_review",
  "app_fix_reports",
] as const;

/** Normalize repository-relative artifact paths without resolving them. */
export function normalizeArtifactPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}
