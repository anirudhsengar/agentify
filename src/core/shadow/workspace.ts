// Private execution workspace for the supported local shadow runner. The
// workspace is a detached worktree-like directory beneath the pilot root that
// holds the supported shadow evidence. The source repository remains
// untouched; the workspace is the only place the runner ever writes.

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
  /** Absolute path to the private clone of the source repository. */
  cloneRoot: string;
}

export interface WorkspaceInputs {
  pilotRoot: string;
  repoSlug: string;
  githubFullName: string;
  sourceRepoRoot: string;
  sourceCommitSha: string;
}

function canonicalRoot(input: string, label: string): string {
  const resolved = path.resolve(input);
  if (resolved !== path.resolve("/") && resolved.includes("\0")) {
    throw new Error(`${label} contains an illegal null byte`);
  }
  return resolved;
}

function ensureDir(target: string, mode = 0o700): string {
  fs.mkdirSync(target, { recursive: true, mode });
  return target;
}

/**
 * Resolve the workspace directories beneath the pilot root. Two workspaces
 * whose evidence roots overlap are rejected up front so concurrent pilots
 * cannot collide.
 */
export function resolveWorkspacePaths(inputs: WorkspaceInputs): WorkspacePaths {
  const pilotRoot = canonicalRoot(inputs.pilotRoot, "pilot-root");
  if (!fs.existsSync(pilotRoot)) {
    throw new Error(`pilot-root does not exist: ${pilotRoot}`);
  }
  if (!fs.statSync(pilotRoot).isDirectory()) {
    throw new Error(`pilot-root is not a directory: ${pilotRoot}`);
  }
  const repoSlug = inputs.repoSlug
    .replace(/\.\.+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!repoSlug) throw new Error(`repository slug is empty after sanitization`);
  const workspaceRoot = canonicalRoot(path.join(pilotRoot, "workspaces", repoSlug), "workspace-root");
  const shadowEvidenceRoot = canonicalRoot(path.join(workspaceRoot, "shadow"), "shadow-evidence-root");
  const managedStateRoot = canonicalRoot(path.join(workspaceRoot, "managed-state"), "managed-state-root");
  const lockRoot = canonicalRoot(path.join(workspaceRoot, "locks"), "lock-root");
  const cloneRoot = canonicalRoot(path.join(workspaceRoot, "clone"), "clone-root");
  const evidenceRoot = canonicalRoot(path.join(workspaceRoot, "evidence"), "evidence-root");
  return {
    pilotRoot,
    repoSlug,
    workspaceRoot,
    evidenceRoot,
    shadowEvidenceRoot,
    managedStateRoot,
    lockRoot,
    cloneRoot,
  };
}

/**
 * Materialize (or reuse) a private clone of the source repository pinned to
 * the exact source commit. The clone is a bare working tree without any
 * remote so the runner cannot accidentally push from it.
 */
export function preparePrivateClone(paths: WorkspacePaths, sourceCommitSha: string): void {
  ensureDir(paths.workspaceRoot);
  ensureDir(paths.shadowEvidenceRoot);
  ensureDir(paths.managedStateRoot);
  ensureDir(paths.lockRoot);
  ensureDir(paths.evidenceRoot);

  // Ensure symlink escapes in the chain are rejected up front.
  for (const candidate of [paths.workspaceRoot, paths.cloneRoot]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error(`workspace path is a symlink: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (!fs.existsSync(path.join(paths.cloneRoot, ".git"))) {
    ensureDir(paths.cloneRoot);
    // Local clone (no remote). This keeps the workspace disconnected from the
    // source remote so accidental pushes are impossible.
    execFileSync("git", ["clone", "--no-local", "--no-tags", "--shared=false", "--", paths.cloneRoot, paths.cloneRoot], {
      stdio: "ignore",
    });
  }
  // Detach to the exact source commit; we never carry local changes forward.
  execFileSync("git", ["-C", paths.cloneRoot, "checkout", "--quiet", "--detach", sourceCommitSha], { stdio: "ignore" });
}

/**
 * Refuse to write to any path that is not the managed state root, the
 * private evidence root, or the shadow evidence root.
 */
export function assertManagedWrite(target: string, paths: WorkspacePaths): string {
  const resolved = path.resolve(target);
  const allowed: ReadonlyArray<string> = [paths.managedStateRoot, paths.evidenceRoot, paths.shadowEvidenceRoot];
  for (const root of allowed) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
  }
  throw new Error(`write rejected: ${resolved} is outside the managed private workspace`);
}