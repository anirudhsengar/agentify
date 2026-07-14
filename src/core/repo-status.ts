import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  codebaseMapRelativePath,
  type ManagedManifestFile,
  REQUIRED_GREENFIELD_FILES,
  markerForPath,
  requiredBrownfieldFiles,
} from "./manifest.ts";
import { verifyManifestAt } from "./manifest-verification.ts";

export type AgentifyRepoMode = "brownfield" | "greenfield" | "unknown";
export type AgentifyRepoStatus = "uninitialized" | "partial" | "ready";

export interface AgentifyRepoState {
  stateDir: string;
  mode: AgentifyRepoMode;
  status: AgentifyRepoStatus;
  featureAgentCount: number;
  workflowCount: number;
  expertCount: number;
  skillCount: number;
  missing: string[];
  found: string[];
  latestLogPath: string | null;
}

const BROWNFIELD_EXPECTED_ROOT = [
  "AGENTS.md",
  "specs/README.md",
  "ai_docs/README.md",
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

function countFeatureAgents(cwd: string, stateDir: string): number {
  const agentsDir = path.join(cwd, stateDir, "agents");
  if (!fs.existsSync(agentsDir)) return 0;
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .filter((entry) => !["scout.md", "review.md", "implement.md", "test.md", "fix.md", "document.md"].includes(entry.name))
    .length;
}

function countProjectWorkflows(cwd: string, stateDir: string): number {
  const workflowsDir = path.join(cwd, stateDir, "workflows");
  if (!fs.existsSync(workflowsDir)) return 0;
  return fs.readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .length;
}

function countExperts(cwd: string, stateDir: string): number {
  const expertsDir = path.join(cwd, stateDir, "prompts", "experts");
  if (!fs.existsSync(expertsDir)) return 0;
  return fs.readdirSync(expertsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(expertsDir, entry.name, "expertise.yaml")))
    .length;
}

function countSkillCandidates(cwd: string, stateDir: string): number {
  const skillsDir = path.join(cwd, stateDir, "skills");
  if (!fs.existsSync(skillsDir)) return 0;
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
    .length;
}

function manifestFileCarriesMarker(cwd: string, file: ManagedManifestFile): boolean {
  const filePath = path.join(cwd, file.path);
  if (!fs.existsSync(filePath)) return false;
  if (file.marker === "sha256") return true;
  return fs.readFileSync(filePath, "utf-8").includes(file.marker);
}

function countFeatureAgentsFromManifest(cwd: string, files: ManagedManifestFile[]): number {
  return files
    .filter((file) => file.path.startsWith(".pi/agents/") && file.path.endsWith(".md"))
    .filter((file) => manifestFileCarriesMarker(cwd, file))
    .filter((file) => {
      const name = path.basename(file.path);
      return !["scout.md", "review.md", "implement.md", "test.md", "fix.md", "document.md"].includes(name);
    })
    .length;
}

function countWorkflowsFromManifest(cwd: string, files: ManagedManifestFile[]): number {
  return files
    .filter((file) => file.kind === "workflow" && file.path.startsWith(".pi/workflows/") && file.path.endsWith(".json"))
    .filter((file) => manifestFileCarriesMarker(cwd, file))
    .length;
}

function countExpertsFromManifest(cwd: string, files: ManagedManifestFile[]): number {
  const domains = new Set<string>();
  for (const file of files) {
    if (file.kind !== "expert" || !file.path.endsWith("/expertise.yaml")) continue;
    if (!manifestFileCarriesMarker(cwd, file)) continue;
    const match = /^\.pi\/prompts\/experts\/([^/]+)\/expertise\.yaml$/.exec(file.path);
    if (match) domains.add(match[1]!);
  }
  return domains.size;
}

function countSkillsFromManifest(cwd: string, files: ManagedManifestFile[]): number {
  const skills = new Set<string>();
  for (const file of files) {
    if (file.kind !== "skill" || !file.path.endsWith("/SKILL.md")) continue;
    if (!manifestFileCarriesMarker(cwd, file)) continue;
    const match = /^\.pi\/skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (match) skills.add(match[1]!);
  }
  return skills.size;
}

function inspectManifestSurfaceCounts(
  cwd: string,
  files: ManagedManifestFile[],
): Pick<AgentifyRepoState, "featureAgentCount" | "workflowCount" | "expertCount" | "skillCount"> {
  return {
    featureAgentCount: countFeatureAgentsFromManifest(cwd, files),
    workflowCount: countWorkflowsFromManifest(cwd, files),
    expertCount: countExpertsFromManifest(cwd, files),
    skillCount: countSkillsFromManifest(cwd, files),
  };
}

function inspectSurfaceCounts(cwd: string, stateDir: string): Pick<
  AgentifyRepoState,
  "featureAgentCount" | "workflowCount" | "expertCount" | "skillCount"
> {
  return {
    featureAgentCount: countFeatureAgents(cwd, stateDir),
    workflowCount: countProjectWorkflows(cwd, stateDir),
    expertCount: countExperts(cwd, stateDir),
    skillCount: countSkillCandidates(cwd, stateDir),
  };
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

/**
 * Inspect repository readiness using one explicit state directory.
 *
 * The state directory is resolved by the command owner and is never inferred here.
 */
export function inspectAgentifyRepoState(
  cwd: string,
  configDir: string,
  stateDir: string,
): AgentifyRepoState {
  const manifestVerification = verifyManifestAt(cwd, stateDir);
  if (manifestVerification.manifest) {
    const counts = inspectManifestSurfaceCounts(cwd, manifestVerification.manifest.files);
    const latestLogPath = findLatestLogPath(cwd, configDir);
    const expectedSurface = manifestVerification.mode === "brownfield"
      ? [...requiredBrownfieldFiles(stateDir), ...SCAFFOLD_EXPECTED]
      : [...REQUIRED_GREENFIELD_FILES, ...SCAFFOLD_EXPECTED];
    const manifestUnmanaged = new Set(manifestVerification.unmanaged);
    const unmanagedExpected = collectUnmanaged(cwd, expectedSurface)
      .filter((entry) => !manifestUnmanaged.has(entry));
    const missing = [
      ...manifestVerification.missing,
      ...manifestVerification.unmanaged.map((entry) => `${entry} (unmanaged)`),
      ...unmanagedExpected.map((entry) => `${entry} (unmanaged)`),
      ...manifestVerification.mismatched.map((entry) => `${entry} (hash mismatch)`),
    ];
    return {
      stateDir,
      mode: manifestVerification.mode,
      status: manifestVerification.valid && unmanagedExpected.length === 0 ? "ready" : "partial",
      ...counts,
      missing,
      found: manifestVerification.found,
      latestLogPath,
    };
  }

  const brownfieldFound = collectFound(cwd, BROWNFIELD_EXPECTED_ROOT).concat(
    collectFound(cwd, [codebaseMapRelativePath(stateDir)]),
  );
  const scaffoldFound = collectFound(cwd, SCAFFOLD_EXPECTED);
  const greenfieldFound = collectFound(cwd, GREENFIELD_SIGNALS);

  const found = [...brownfieldFound, ...greenfieldFound, ...scaffoldFound];
  const counts = inspectSurfaceCounts(cwd, stateDir);
  const latestLogPath = findLatestLogPath(cwd, configDir);

  if (brownfieldFound.length > 0) {
    const expected = [...requiredBrownfieldFiles(stateDir)];
    const missing = expected.filter((relativePath) => !hasPath(cwd, relativePath));
    const unmanaged = collectUnmanaged(cwd, expected);
    return {
      stateDir,
      mode: "brownfield",
      status: missing.length === 0 && unmanaged.length === 0 ? "ready" : "partial",
      ...counts,
      missing: [...missing, ...unmanaged.map((entry) => `${entry} (unmanaged)`) ],
      found,
      latestLogPath,
    };
  }

  if (greenfieldFound.length > 0) {
    const expected = [...REQUIRED_GREENFIELD_FILES];
    const missing = expected.filter((relativePath) => !hasPath(cwd, relativePath));
    const unmanaged = collectUnmanaged(cwd, expected);
    return {
      stateDir,
      mode: "greenfield",
      status: missing.length === 0 && unmanaged.length === 0 ? "ready" : "partial",
      ...counts,
      missing: [...missing, ...unmanaged.map((entry) => `${entry} (unmanaged)`) ],
      found,
      latestLogPath,
    };
  }

  if (scaffoldFound.length > 0) {
    const expected = [...BROWNFIELD_EXPECTED_ROOT, codebaseMapRelativePath(stateDir), ...SCAFFOLD_EXPECTED];
    const missing = expected.filter((relativePath) => !hasPath(cwd, relativePath));
    return {
      stateDir,
      mode: "unknown",
      status: "partial",
      ...counts,
      missing,
      found,
      latestLogPath,
    };
  }

  return {
    stateDir,
    mode: "unknown",
    status: "uninitialized",
    ...counts,
    missing: [],
    found: [],
    latestLogPath,
  };
}
