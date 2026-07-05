import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { GitHubReadiness } from "./types.ts";

export interface InspectGitHubReadinessOptions {
  cwd: string;
  ghCliAvailable?: boolean;
}

function resolveGitDir(cwd: string): string | null {
  const dotGit = path.join(cwd, ".git");
  if (!fs.existsSync(dotGit)) return null;
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  const raw = fs.readFileSync(dotGit, "utf-8").trim();
  const match = raw.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;
  return path.resolve(cwd, match[1]!);
}

function readGitConfig(cwd: string): string {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return "";
  const configPath = path.join(gitDir, "config");
  if (!fs.existsSync(configPath)) return "";
  return fs.readFileSync(configPath, "utf-8");
}

function extractOriginUrl(config: string): string | null {
  const remoteSection = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/);
  if (!remoteSection) return null;
  const urlMatch = remoteSection[1]?.match(/^\s*url\s*=\s*(.+)$/m);
  return urlMatch?.[1]?.trim() ?? null;
}

function isGitHubRemote(url: string | null): boolean {
  if (!url) return false;
  return url.includes("github.com:") || url.includes("github.com/");
}

function detectGhCli(): boolean {
  const result = spawnSync("gh", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

export function inspectGitHubReadiness(
  options: InspectGitHubReadinessOptions,
): GitHubReadiness {
  const config = readGitConfig(options.cwd);
  const originUrl = extractOriginUrl(config);
  const hasGitDirectory = resolveGitDir(options.cwd) !== null;
  const hasGitHubRemote = isGitHubRemote(originUrl);
  const ghCliAvailable = options.ghCliAvailable ?? detectGhCli();

  const guidance: string[] = [];
  if (!hasGitDirectory) {
    guidance.push(
      "Initialize a git repository and push it to GitHub before relying on the GitHub inbox.",
    );
  } else if (!hasGitHubRemote) {
    guidance.push(
      "Add a GitHub `origin` remote so issues, comments, and PRs can become the async inbox.",
    );
  }
  if (!ghCliAvailable) {
    guidance.push(
      "Install GitHub CLI (`gh`) so you can run `bash .github/scripts/setup-agentify.sh` and validate repo setup.",
    );
  }
  if (guidance.length === 0) {
    guidance.push(
      "GitHub bootstrap looks ready. Review SETUP.md, run `bash .github/scripts/setup-agentify.sh`, then use GitHub issues/comments as the async inbox.",
    );
  }

  return {
    hasGitDirectory,
    hasGitHubRemote,
    originUrl,
    ghCliAvailable,
    guidance,
  };
}

export function formatGitHubReadiness(readiness: GitHubReadiness): string[] {
  const headline = readiness.hasGitDirectory && readiness.hasGitHubRemote && readiness.ghCliAvailable
    ? "agentify: GitHub bootstrap is ready."
    : "agentify: GitHub bootstrap needs attention.";
  return [headline, ...readiness.guidance.map((line) => `agentify: ${line}`)];
}
