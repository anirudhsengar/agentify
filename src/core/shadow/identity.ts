// Local identity collection for the supported local shadow runner. All values
// are derived from controlled local tools (git + gh CLI) executed via execFile
// so issue text can never influence a command line.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface CommandOptions {
  timeoutMs?: number;
}

export interface IssueIdentity {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  fetchedAt: string;
  repositoryFullName: string;
}

export interface RepositoryIdentity {
  commitSha: string;
  remoteUrl: string;
  githubFullName: string;
  nodeId: string;
  defaultBranch: string;
}

export type GitHubAuthenticationStatus = "authenticated" | "anonymous_read" | "unavailable";

export interface OperatorIdentity {
  githubOperatorLogin: string | null;
  localOperatorIdentity: string;
  githubAuthenticationStatus: GitHubAuthenticationStatus;
  invokedAt: string;
  localRunId: string;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function assertSafeId(value: string, label: string): void {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) throw new Error(`${label} contains unsafe characters`);
}

export function assertSafeRepo(value: string): void {
  if (!SAFE_REPO_RE.test(value)) throw new Error(`repository is not a safe owner/name pair`);
}

export function assertSafeSha(value: string, label: string): void {
  if (!SHA_RE.test(value)) throw new Error(`${label} is not a 40-char hex SHA`);
}

function timeout(options?: CommandOptions): number {
  const value = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("command deadline expired");
  return Math.max(1, Math.floor(value));
}

export async function git(args: ReadonlyArray<string>, cwd: string, options?: CommandOptions): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeout(options),
    killSignal: "SIGKILL",
  });
  return stdout.trim();
}

export async function ghJson<T>(args: ReadonlyArray<string>, options?: CommandOptions): Promise<T> {
  const { stdout } = await execFileAsync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeout(options),
    killSignal: "SIGKILL",
  });
  return JSON.parse(stdout) as T;
}

export async function ghText(args: ReadonlyArray<string>, options?: CommandOptions): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeout(options),
    killSignal: "SIGKILL",
  });
  return stdout.trim();
}

/** Normalize a supported GitHub origin to lowercase owner/name. */
export function normalizeOrigin(input: string): string {
  const value = input.trim();
  let owner: string;
  let repo: string;

  const scp = value.match(/^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (scp) {
    owner = scp[1]!;
    repo = scp[2]!;
  } else {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error("origin must be a supported GitHub URL"); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com") {
      throw new Error("origin must use github.com over https or ssh");
    }
    if (url.password || (url.protocol === "https:" && url.username)) throw new Error("origin must not contain credentials");
    if (url.port || url.search || url.hash) throw new Error("origin contains unsupported URL components");
    if (url.protocol === "ssh:" && url.username !== "git") throw new Error("SSH origin must use the git account");
    const pieces = url.pathname.split("/").filter(Boolean);
    if (pieces.length !== 2) throw new Error("origin must contain exactly owner/repository");
    owner = decodeURIComponent(pieces[0]!);
    repo = decodeURIComponent(pieces[1]!).replace(/\.git$/i, "");
  }

  const normalized = `${owner}/${repo}`;
  assertSafeRepo(normalized);
  return normalized.toLowerCase();
}

export async function collectRepositoryIdentity(
  sourceRoot: string,
  requestedRepo: string,
  options?: CommandOptions,
): Promise<RepositoryIdentity> {
  assertSafeRepo(requestedRepo);
  const commitSha = await git(["rev-parse", "HEAD"], sourceRoot, options);
  assertSafeSha(commitSha, "source repository commit");
  const remoteUrl = await git(["remote", "get-url", "origin"], sourceRoot, options);
  if (normalizeOrigin(remoteUrl) !== requestedRepo.toLowerCase()) {
    throw new Error(`source repository origin does not match requested repo`);
  }

  const data = await ghJson<{ id?: string; nameWithOwner?: string; defaultBranchRef?: { name?: string } }>([
    "repo", "view", requestedRepo, "--json", "id,nameWithOwner,defaultBranchRef",
  ], options);
  if (!data.id || !data.nameWithOwner || !data.defaultBranchRef?.name) {
    throw new Error("GitHub repository lookup returned incomplete identity");
  }
  if (data.nameWithOwner.toLowerCase() !== requestedRepo.toLowerCase()) {
    throw new Error(`GitHub repository identity does not match requested repo`);
  }
  return {
    commitSha,
    remoteUrl,
    githubFullName: data.nameWithOwner,
    nodeId: String(data.id),
    defaultBranch: data.defaultBranchRef.name,
  };
}

export interface GhIssueViewFields {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  repository?: { nameWithOwner?: string };
}

export async function collectIssueIdentity(
  requestedRepo: string,
  issueNumber: number,
  options?: CommandOptions,
): Promise<IssueIdentity> {
  assertSafeRepo(requestedRepo);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("issue number must be a positive integer");
  let view: GhIssueViewFields;
  try {
    view = await ghJson<GhIssueViewFields>([
      "issue", "view", String(issueNumber), "--repo", requestedRepo,
      "--json", "number,title,body,url,state,repository",
    ], options);
  } catch {
    throw new Error(`unable to read requested issue from GitHub`);
  }
  if (view.number !== issueNumber) throw new Error(`GitHub issue identity does not match requested issue`);
  const repoName = view.repository?.nameWithOwner;
  if (!repoName || repoName.toLowerCase() !== requestedRepo.toLowerCase()) {
    throw new Error(`GitHub issue repository does not match requested repo`);
  }
  if (!view.url || !view.url.startsWith(`https://github.com/${repoName}/issues/${issueNumber}`)) {
    throw new Error("GitHub issue URL does not match requested issue");
  }
  return {
    number: view.number,
    title: view.title ?? "",
    body: view.body ?? "",
    url: view.url,
    state: view.state ?? "unknown",
    repositoryFullName: repoName,
    fetchedAt: new Date().toISOString(),
  };
}

export async function collectOperatorIdentity(options?: CommandOptions): Promise<OperatorIdentity> {
  const invokedAt = new Date().toISOString();
  const localOperatorIdentity = process.env.USER || process.env.USERNAME || "unknown-local-operator";
  let githubOperatorLogin: string | null = null;
  let githubAuthenticationStatus: GitHubAuthenticationStatus = "unavailable";
  try {
    const who = await ghText(["api", "--method", "GET", "user", "--jq", ".login"], options);
    if (who) {
      githubOperatorLogin = who;
      githubAuthenticationStatus = "authenticated";
    } else {
      githubAuthenticationStatus = "anonymous_read";
    }
  } catch {
    try {
      await ghText(["--version"], options);
      githubAuthenticationStatus = "anonymous_read";
    } catch {
      githubAuthenticationStatus = "unavailable";
    }
  }
  return {
    githubOperatorLogin,
    localOperatorIdentity,
    githubAuthenticationStatus,
    invokedAt,
    localRunId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}
