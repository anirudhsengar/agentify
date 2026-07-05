import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CODEBASE_MAP_RELATIVE_PATH,
  REQUIRED_BROWNFIELD_FILES,
  REQUIRED_GREENFIELD_FILES,
  markerForPath,
  verifyManifest,
} from "./manifest.ts";

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
  CODEBASE_MAP_RELATIVE_PATH,
] as const;

const SCAFFOLD_EXPECTED = [
  "SETUP.md",
  ".github/workflows/agent-implement.yml",
  ".github/actions/run-pi/action.yml",
  ".github/scripts/setup-agentify.sh",
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

function fileCarriesExpectedMarker(cwd: string, relativePath: string): boolean {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) return false;
  const marker = markerForPath(relativePath);
  if (marker === "sha256") return true;
  return fs.readFileSync(filePath, "utf-8").includes(marker);
}

function collectUnmanaged(cwd: string, relatives: readonly string[]): string[] {
  return relatives
    .filter((relativePath) => hasPath(cwd, relativePath))
    .filter((relativePath) => !fileCarriesExpectedMarker(cwd, relativePath));
}

export function inspectAgentifyRepoState(cwd: string, configDir: string): AgentifyRepoState {
  const manifestVerification = verifyManifest(cwd);
  if (manifestVerification.manifest) {
    const featureAgentCount = countFeatureAgents(cwd);
    const latestLogPath = findLatestLogPath(cwd, configDir);
    const missing = [
      ...manifestVerification.missing,
      ...manifestVerification.unmanaged.map((entry) => `${entry} (unmanaged)`),
      ...manifestVerification.mismatched.map((entry) => `${entry} (hash mismatch)`),
    ];
    return {
      mode: manifestVerification.mode,
      status: manifestVerification.valid ? "ready" : "partial",
      featureAgentCount,
      missing,
      found: manifestVerification.found,
      latestLogPath,
    };
  }

  const brownfieldFound = collectFound(cwd, BROWNFIELD_EXPECTED);
  const scaffoldFound = collectFound(cwd, SCAFFOLD_EXPECTED);
  const greenfieldFound = collectFound(cwd, GREENFIELD_SIGNALS);

  const found = [...brownfieldFound, ...greenfieldFound, ...scaffoldFound];
  const featureAgentCount = countFeatureAgents(cwd);
  const latestLogPath = findLatestLogPath(cwd, configDir);

  if (brownfieldFound.length > 0) {
    const expected = [...REQUIRED_BROWNFIELD_FILES];
    const missing = expected
      .filter((relativePath) => !hasPath(cwd, relativePath));
    const unmanaged = collectUnmanaged(cwd, expected);
    return {
      mode: "brownfield",
      status: missing.length === 0 && unmanaged.length === 0 ? "ready" : "partial",
      featureAgentCount,
      missing: [...missing, ...unmanaged.map((entry) => `${entry} (unmanaged)`)],
      found,
      latestLogPath,
    };
  }

  if (greenfieldFound.length > 0) {
    const expected = [...REQUIRED_GREENFIELD_FILES];
    const missing = expected
      .filter((relativePath) => !hasPath(cwd, relativePath));
    const unmanaged = collectUnmanaged(cwd, expected);
    return {
      mode: "greenfield",
      status: missing.length === 0 && unmanaged.length === 0 ? "ready" : "partial",
      featureAgentCount,
      missing: [...missing, ...unmanaged.map((entry) => `${entry} (unmanaged)`)],
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
