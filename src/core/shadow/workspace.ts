// Private execution workspace for the supported local shadow runner. The source
// repository is read-only; all persistent writes stay beneath the pilot root.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspacePaths {
  pilotRoot: string;
  repoSlug: string;
  workspaceRoot: string;
  evidenceRoot: string;
  shadowEvidenceRoot: string;
  managedStateRoot: string;
  lockRoot: string;
  cloneRoot: string;
  sourceRepoRoot: string;
  githubFullName: string;
}

export interface WorkspaceInputs {
  pilotRoot: string;
  repoSlug: string;
  githubFullName: string;
  sourceRepoRoot: string;
  sourceCommitSha: string;
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertNoSymlinkAncestors(target: string, stopAt?: string): void {
  let current = path.resolve(target);
  const stop = stopAt ? path.resolve(stopAt) : path.parse(current).root;
  while (isInside(current, stop)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`workspace path is a symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === stop) break;
    current = path.dirname(current);
  }
}

function ensureDir(target: string, pilotRoot: string, mode = 0o700): string {
  assertNoSymlinkAncestors(path.dirname(target), pilotRoot);
  fs.mkdirSync(target, { recursive: true, mode });
  assertNoSymlinkAncestors(target, pilotRoot);
  return target;
}

export function resolveWorkspacePaths(inputs: WorkspaceInputs): WorkspacePaths {
  if (!path.isAbsolute(inputs.pilotRoot)) throw new Error("pilot-root must be absolute");
  if (!path.isAbsolute(inputs.sourceRepoRoot)) throw new Error("source repository path must be absolute");
  const pilotInput = path.resolve(inputs.pilotRoot);
  if (!fs.existsSync(pilotInput)) throw new Error(`pilot-root does not exist`);
  const pilotRoot = fs.realpathSync(pilotInput);
  const sourceInput = path.resolve(inputs.sourceRepoRoot);
  const sourceRepoRoot = fs.existsSync(sourceInput) ? fs.realpathSync(sourceInput) : sourceInput;
  if (pilotRoot === path.parse(pilotRoot).root) throw new Error("pilot-root cannot be the filesystem root");
  if (!fs.existsSync(pilotRoot)) throw new Error(`pilot-root does not exist`);
  if (!fs.statSync(pilotRoot).isDirectory()) throw new Error("pilot-root is not a directory");
  assertNoSymlinkAncestors(pilotRoot);
  if (isInside(pilotRoot, sourceRepoRoot) || isInside(sourceRepoRoot, pilotRoot)) {
    throw new Error("pilot-root and source repository must not overlap");
  }

  const repoSlug = inputs.repoSlug
    .replace(/\.\.+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!repoSlug) throw new Error("repository slug is empty after sanitization");
  const workspaceRoot = path.join(pilotRoot, "workspaces", repoSlug);
  return {
    pilotRoot,
    repoSlug,
    workspaceRoot,
    evidenceRoot: path.join(workspaceRoot, "evidence"),
    shadowEvidenceRoot: path.join(workspaceRoot, "shadow"),
    managedStateRoot: path.join(workspaceRoot, "managed-state"),
    lockRoot: path.join(workspaceRoot, "locks"),
    cloneRoot: path.join(workspaceRoot, "clone"),
    sourceRepoRoot,
    githubFullName: inputs.githubFullName,
  };
}

function git(args: string[], timeoutMs: number): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(timeoutMs)),
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Create once, then fail closed if a reused private clone has drifted. */
export function preparePrivateClone(paths: WorkspacePaths, sourceCommitSha: string, timeoutMs = 30_000): void {
  ensureDir(paths.workspaceRoot, paths.pilotRoot);
  ensureDir(paths.shadowEvidenceRoot, paths.pilotRoot);
  ensureDir(paths.managedStateRoot, paths.pilotRoot);
  ensureDir(paths.lockRoot, paths.pilotRoot);
  ensureDir(paths.evidenceRoot, paths.pilotRoot);
  assertNoSymlinkAncestors(paths.cloneRoot, paths.pilotRoot);

  const metadataPath = path.join(paths.workspaceRoot, "workspace-identity.json");
  const gitDir = path.join(paths.cloneRoot, ".git");
  if (fs.existsSync(metadataPath)) {
    const metadataStat = fs.lstatSync(metadataPath);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) throw new Error("workspace identity metadata is not a regular file");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { schema_version?: string; github_repository?: string };
    if (metadata.schema_version !== "1" || metadata.github_repository?.toLowerCase() !== paths.githubFullName.toLowerCase()) {
      throw new Error("private workspace belongs to a different repository");
    }
  } else if (fs.existsSync(gitDir)) {
    throw new Error("private clone lacks repository identity metadata; inspect and recreate it explicitly");
  }

  if (!fs.existsSync(gitDir)) {
    if (fs.existsSync(paths.cloneRoot) && fs.readdirSync(paths.cloneRoot).length > 0) {
      throw new Error("private clone path exists but is not a Git checkout");
    }
    if (fs.existsSync(paths.cloneRoot)) fs.rmdirSync(paths.cloneRoot);
    try {
      git(["clone", "--no-local", "--no-hardlinks", "--no-tags", "--", paths.sourceRepoRoot, paths.cloneRoot], timeoutMs);
      git(["-C", paths.cloneRoot, "remote", "remove", "origin"], timeoutMs);
      git(["-C", paths.cloneRoot, "checkout", "--quiet", "--detach", sourceCommitSha], timeoutMs);
      fs.writeFileSync(metadataPath, `${JSON.stringify({ schema_version: "1", github_repository: paths.githubFullName }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      fs.rmSync(paths.cloneRoot, { recursive: true, force: true });
      fs.rmSync(metadataPath, { force: true });
      throw error;
    }
  }

  assertNoSymlinkAncestors(paths.cloneRoot, paths.pilotRoot);
  if (!fs.statSync(gitDir).isDirectory()) throw new Error("private clone has an invalid .git entry");
  const head = git(["-C", paths.cloneRoot, "rev-parse", "HEAD"], timeoutMs);
  const branch = git(["-C", paths.cloneRoot, "rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
  const status = git(["-C", paths.cloneRoot, "status", "--porcelain=v1", "--untracked-files=all"], timeoutMs);
  const remotes = git(["-C", paths.cloneRoot, "remote"], timeoutMs);
  if (head !== sourceCommitSha || branch !== "HEAD" || status || remotes) {
    throw new Error("private clone state does not match the requested immutable checkout; inspect and recreate it explicitly");
  }
}

export function assertManagedWrite(target: string, paths: WorkspacePaths): string {
  const resolved = path.resolve(target);
  const allowed = [paths.managedStateRoot, paths.evidenceRoot, paths.shadowEvidenceRoot];
  const root = allowed.find((candidate) => isInside(resolved, candidate));
  if (!root) throw new Error("write rejected: target is outside the managed private workspace");
  assertNoSymlinkAncestors(path.dirname(resolved), paths.pilotRoot);
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error("write rejected: target is a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}
