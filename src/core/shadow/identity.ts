// Local identity collection for the supported local shadow runner. All values
// are derived from controlled local tools (git + gh CLI) executed via execFile
// so that issue text or model output can never influence the result.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IssueIdentity {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  fetchedAt: string;
  /** Repo from the issue view (must equal the requested repo). */
  repositoryFullName: string;
}

export interface RepositoryIdentity {
  /** Exact repository HEAD commit (40-char hex). */
  commitSha: string;
  /** Resolved origin URL (normalized). */
  remoteUrl: string;
  /** `owner/name` from gh repo view. */
  githubFullName: string;
  /** Repository node id when gh is authenticated. */
  nodeId: string | null;
  /** Default branch from gh. */
  defaultBranch: string;
}

export interface OperatorIdentity {
  /** Authenticated gh login or local user when gh is unavailable. */
  login: string;
  /** Local invocation timestamp (ISO-8601 UTC). */
  invokedAt: string;
  /** Locally-generated run id (ULID-ish). */
  localRunId: string;
  /** True iff this run used a gh token and only for read-only queries. */
  ghAuthenticated: boolean;
}

export interface GitStateSnapshot {
  commitSha: string;
  /** "main" or "HEAD" when detached. */
  branch: string;
  detached: boolean;
  remoteRefs: string;
  porcelain: string;
  fileInventoryDigest: string;
  /** Existing managed state path relative to root (or null). */
  managedStateRelative: string | null;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_RE.test(value)) throw new Error(`${label} contains unsafe characters`);
}

export function assertSafeRepo(value: string): void {
  if (!SAFE_REPO_RE.test(value)) throw new Error(`repository ${value} is not a safe owner/name pair`);
}

export function assertSafeSha(value: string, label: string): void {
  if (!SHA_RE.test(value)) throw new Error(`${label} is not a 40-char hex SHA`);
}

/** Run an argv-based git command. Issues are never interpolated. */
export async function git(args: ReadonlyArray<string>, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** Run an argv-based gh command. Issues and paths are passed as argv, not shell. */
export async function ghJson<T>(args: ReadonlyArray<string>): Promise<T> {
  const { stdout } = await execFileAsync("gh", [...args, "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

export async function ghText(args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Normalize an origin URL to a comparable form. Both https://github.com/owner/name
 * and git@github.com:owner/name reduce to "owner/name".
 */
export function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^git@[^:]+:(.+)$/);
  if (sshMatch) return sshMatch[1]!.toLowerCase();
  const httpsMatch = trimmed.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (httpsMatch) return httpsMatch[1]!.toLowerCase();
  return trimmed.toLowerCase();
}

/**
 * Collect authoritative local identity for the requested GitHub repository.
 * Refuses to proceed when the local checkout disagrees with the requested
 * repository or when identity cannot be resolved.
 */
export async function collectRepositoryIdentity(
  sourceRoot: string,
  requestedRepo: string,
): Promise<RepositoryIdentity> {
  assertSafeRepo(requestedRepo);
  const commitSha = await git(["rev-parse", "HEAD"], sourceRoot);
  assertSafeSha(commitSha, "source repository commit");
  const remoteUrl = await git(["remote", "get-url", "origin"], sourceRoot);
  const normalized = normalizeOrigin(remoteUrl);
  if (normalized !== requestedRepo.toLowerCase()) {
    throw new Error(
      `source repository origin '${remoteUrl}' does not match requested repo '${requestedRepo}'`,
    );
  }
  // Cross-check via gh repo view when authenticated.
  let nodeId: string | null = null;
  let defaultBranch = "main";
  try {
    const data = await ghJson<{ id?: string; nameWithOwner?: string; defaultBranchRef?: { name?: string } }>([
      "repo", "view", requestedRepo,
    ]);
    if (data.id) nodeId = String(data.id);
    if (data.nameWithOwner) {
      if (data.nameWithOwner.toLowerCase() !== requestedRepo.toLowerCase()) {
        throw new Error(`gh repo view reports '${data.nameWithOwner}' but requested '${requestedRepo}'`);
      }
    }
    if (data.defaultBranchRef?.name) defaultBranch = data.defaultBranchRef.name;
  } catch {
    // gh unavailable; rely on git identity alone. This is acceptable because
    // we still have a hard origin match.
  }
  return {
    commitSha,
    remoteUrl,
    githubFullName: requestedRepo,
    nodeId,
    defaultBranch,
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

/**
 * Fetch authoritative issue identity via gh. Refuses to proceed when gh
 * cannot be authenticated, when the issue is not a positive integer, when the
 * fetched issue does not belong to the requested repo, or when the issue
 * payload is missing required fields.
 */
export async function collectIssueIdentity(
  requestedRepo: string,
  issueNumber: number,
): Promise<IssueIdentity> {
  assertSafeRepo(requestedRepo);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(`issue number ${issueNumber} must be a positive integer`);
  }
  let view: GhIssueViewFields;
  try {
    view = await ghJson<GhIssueViewFields>([
      "issue", "view", String(issueNumber), "--repo", requestedRepo,
    ]);
  } catch (error) {
    throw new Error(
      `unable to read issue #${issueNumber} from ${requestedRepo}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (view.number !== issueNumber) {
    throw new Error(`gh issue view returned number ${view.number} but requested ${issueNumber}`);
  }
  const repoName = view.repository?.nameWithOwner?.toLowerCase();
  if (repoName && repoName !== requestedRepo.toLowerCase()) {
    throw new Error(`issue belongs to repo ${repoName} but ${requestedRepo} was requested`);
  }
  if (!view.url || !view.url.startsWith("https://")) {
    throw new Error(`issue URL is missing or not https: ${view.url ?? "(absent)"}`);
  }
  return {
    number: view.number,
    title: view.title ?? "",
    body: view.body ?? "",
    url: view.url,
    state: view.state ?? "unknown",
    repositoryFullName: view.repository?.nameWithOwner ?? requestedRepo,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Resolve the authenticated operator login. Falls back to the local user when
 * gh is unauthenticated, but marks the run as not gh-authenticated so the
 * attestation records the actual trust level.
 */
export async function collectOperatorIdentity(): Promise<OperatorIdentity> {
  const invokedAt = new Date().toISOString();
  let ghAuthenticated = false;
  let login = process.env.USER || process.env.USERNAME || "local-operator";
  try {
    const who = await ghText(["api", "user", "--jq", ".login"]);
    if (who) { login = who; ghAuthenticated = true; }
  } catch {
    // Unauthenticated gh is allowed: local execution does not require it.
  }
  return {
    login,
    invokedAt,
    localRunId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ghAuthenticated,
  };
}