import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitHubReadiness, ProjectKind } from "./types.ts";
import type { AgentifyRepoMode, AgentifyRepoStatus } from "./repo-status.ts";

export interface AgentifyProjectState {
  cwd: string;
  lastRunAt: string;
  projectKind: Exclude<ProjectKind, "ambiguous"> | "unknown";
  runStatus: "success" | "partial" | "aborted" | "error";
  repoMode: AgentifyRepoMode;
  repoStatus: AgentifyRepoStatus;
  featureAgentCount: number;
  latestLogPath: string | null;
  github: Pick<GitHubReadiness, "hasGitDirectory" | "hasGitHubRemote" | "ghCliAvailable" | "originUrl">;
}

function hashCwd(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex");
}

export function projectStatePath(configDir: string, cwd: string): string {
  return path.join(configDir, "projects", `${hashCwd(cwd)}.json`);
}

function writeJson0600(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
}

export function writeProjectState(configDir: string, state: AgentifyProjectState): void {
  writeJson0600(projectStatePath(configDir, state.cwd), state);
}

export function readProjectState(configDir: string, cwd: string): AgentifyProjectState | null {
  const filePath = projectStatePath(configDir, cwd);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentifyProjectState;
  } catch {
    return null;
  }
}
