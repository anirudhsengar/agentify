import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type AgentifyRepoMode = "brownfield" | "greenfield" | "unknown";
export type AgentifyRepoStatus = "uninitialized" | "partial" | "ready";

export interface AgentifyRepoState {
  mode: AgentifyRepoMode;
  status: AgentifyRepoStatus;
  featureAgentCount: number;
  missing: string[];
  found: string[];
  latestLogPath: string | null;
}

const BROWNFIELD_EXPECTED = [
  "AGENTS.md",
  "specs/README.md",
  "ai_docs/README.md",
] as const;

const SCAFFOLD_EXPECTED = [
  "SETUP.md",
  ".github/workflows/agent-implement.yml",
] as const;

const GREENFIELD_SIGNALS = [
  "GOALS.md",
  "CONTEXT.md",
  "docs/prds",
  "docs/plans",
  "docs/issues",
  "specs",
] as const;

function hasPath(cwd: string, relativePath: string): boolean {
  return fs.existsSync(path.join(cwd, relativePath));
}

function hashCwd(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 6);
}

function countFeatureAgents(cwd: string): number {
  const agentsDir = path.join(cwd, ".pi", "agents");
  if (!fs.existsSync(agentsDir)) return 0;
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .filter((entry) => !["scout.md", "review.md", "implement.md", "test.md", "fix.md", "document.md"].includes(entry.name))
    .length;
}

function findLatestLogPath(cwd: string, configDir: string): string | null {
  const logDir = path.join(configDir, "logs", "agentify");
  if (!fs.existsSync(logDir)) return null;
  const suffix = `-${hashCwd(cwd)}-`;
  const matches = fs.readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl") && name.includes(suffix))
    .sort();
  const latest = matches.at(-1);
  return latest ? path.join(logDir, latest) : null;
}

function collectFound(cwd: string, relatives: readonly string[]): string[] {
  return relatives.filter((relativePath) => hasPath(cwd, relativePath));
}

export function inspectAgentifyRepoState(cwd: string, configDir: string): AgentifyRepoState {
  const brownfieldFound = collectFound(cwd, BROWNFIELD_EXPECTED);
  const scaffoldFound = collectFound(cwd, SCAFFOLD_EXPECTED);
  const greenfieldFound = collectFound(cwd, GREENFIELD_SIGNALS);

  const found = [...brownfieldFound, ...greenfieldFound, ...scaffoldFound];
  const featureAgentCount = countFeatureAgents(cwd);
  const latestLogPath = findLatestLogPath(cwd, configDir);

  if (brownfieldFound.length > 0) {
    const missing = [...BROWNFIELD_EXPECTED, ...SCAFFOLD_EXPECTED]
      .filter((relativePath) => !hasPath(cwd, relativePath));
    return {
      mode: "brownfield",
      status: missing.length === 0 ? "ready" : "partial",
      featureAgentCount,
      missing,
      found,
      latestLogPath,
    };
  }

  if (greenfieldFound.length > 0) {
    const missing = [...SCAFFOLD_EXPECTED]
      .filter((relativePath) => !hasPath(cwd, relativePath));
    return {
      mode: "greenfield",
      status: missing.length === 0 ? "ready" : "partial",
      featureAgentCount,
      missing,
      found,
      latestLogPath,
    };
  }

  if (scaffoldFound.length > 0) {
    const missing = [...BROWNFIELD_EXPECTED, ...SCAFFOLD_EXPECTED]
      .filter((relativePath) => !hasPath(cwd, relativePath));
    return {
      mode: "unknown",
      status: "partial",
      featureAgentCount,
      missing,
      found,
      latestLogPath,
    };
  }

  return {
    mode: "unknown",
    status: "uninitialized",
    featureAgentCount,
    missing: [],
    found: [],
    latestLogPath,
  };
}
