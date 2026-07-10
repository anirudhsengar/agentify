// isolation.ts — per-AIW worktree + branch + port allocation.
//
// the AIW runtime isolation has three layers (per
// `principles/06-aiws-and-afk.md` § "Worktree Isolation"):
//
//   1. Filesystem — `trees/<aiw_id>/` (a git worktree, separate dir)
//   2. Branch — `aiw/<aiw_id>` (own branch off the project's base)
//   3. Ports — deterministic 15-slot pool, derived from aiw_id hash
//
// The deterministic port formula mirrors the lesson:
//   index = parseInt(aiw_id[:8].base36()) % 15
//   ports = { backend: 9100 + index, frontend: 9200 + index }
//
// The 15-slot pool caps concurrent AIWs at 15. Beyond that, two AIWs
// with similar ids would collide. We document the ceiling; v1.1 adds
// a Redis-backed allocator when needed.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface IsolationParams {
  workingDir: string;        // absolute path to the project root
  aiwId: string;             // 16 hex chars
}

export interface IsolationResult {
  worktreePath: string;
  branchName: string;
  backendPort: number;
  frontendPort: number;
  /** Whether the worktree was created on disk (false in --no-worktree). */
  created: boolean;
}

const PORT_POOL_SIZE = 15;
const BACKEND_PORT_BASE = 9100;
const FRONTEND_PORT_BASE = 9200;

/**
 * Allocate deterministic ports for an AIW.
 */
export function getPortsForAiw(aiwId: string): { backend: number; frontend: number } {
  const head = (aiwId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "aaaaaaaa").toLowerCase();
  // parseInt with base 36; clamp to 0..PORT_POOL_SIZE-1.
  let index: number;
  try {
    index = parseInt(head, 36) % PORT_POOL_SIZE;
  } catch {
    index = 0;
  }
  if (!Number.isFinite(index) || index < 0) index = 0;
  return {
    backend: BACKEND_PORT_BASE + index,
    frontend: FRONTEND_PORT_BASE + index,
  };
}

/**
 * Compute the deterministic branch name for an AIW.
 */
export function getBranchNameForAiw(aiwId: string): string {
  return `aiw/${aiwId}`;
}

/**
 * Compute the deterministic worktree path for an AIW.
 */
export function getWorktreePathForAiw(workingDir: string, aiwId: string): string {
  return path.join(workingDir, "trees", aiwId);
}

/**
 * Detect whether the working directory is a git repository. We use
 * this to decide whether worktree isolation is possible at all.
 */
export function isGitRepo(workingDir: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return !!out.trim();
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for the AIW. Idempotent: if the worktree
 * already exists (after a crash mid-run), reuses it.
 *
 * Uses `execFile` (no shell) to avoid injection. Returns the
 * worktree path, which is the input path.
 *
 * Requires `workingDir` to be a git repo. Throws otherwise.
 */
export function createWorktree(workingDir: string, aiwId: string): string {
  const branch = getBranchNameForAiw(aiwId);
  const worktreePath = getWorktreePathForAiw(workingDir, aiwId);

  // Idempotency: if the worktree already exists at the expected path
  // and the branch exists, reuse it.
  if (fs.existsSync(worktreePath)) {
    const exists = worktreeExists(workingDir, worktreePath);
    if (exists) return worktreePath;
    // Path exists but is not a worktree — refuse to clobber.
    throw new Error(
      `path ${worktreePath} exists but is not a git worktree; refusing to overwrite.`,
    );
  }

  // Ensure the trees/ parent exists.
  const treesRoot = path.dirname(worktreePath);
  fs.mkdirSync(treesRoot, { recursive: true });

  // Determine the base branch: HEAD if available, else the repo's
  // default branch via symbolic-ref, else just HEAD.
  let baseRef: string;
  try {
    baseRef = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "HEAD";
  } catch {
    baseRef = "HEAD";
  }

  // `git worktree add -b <branch> <path>` creates a new branch and
  // worktree in one step. Falls back to `git worktree add <path>
  // <existing-branch>` if the branch was already created in a prior
  // crash (the path may not exist but the branch may).
  try {
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, baseRef], {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/already exists/i.test(msg)) {
      // Branch already exists from a prior crashed run; reuse it.
      try {
        execFileSync("git", ["worktree", "add", worktreePath, branch], {
          cwd: workingDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err2) {
        throw new Error(
          `worktree recovery failed for ${worktreePath}: ${(err2 as Error).message}`,
        );
      }
    } else {
      throw new Error(`worktree creation failed for ${worktreePath}: ${msg}`);
    }
  }

  return worktreePath;
}

function worktreeExists(repoRoot: string, worktreePath: string): boolean {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").some((line) => line.startsWith("worktree ") && line.slice("worktree ".length).trim() === worktreePath);
  } catch {
    return false;
  }
}

/**
 * Remove the AIW's worktree and (optionally) its branch. Idempotent;
 * no-ops if either is already gone.
 */
export function removeWorktree(workingDir: string, aiwId: string, opts?: { deleteBranch?: boolean }): void {
  const branch = getBranchNameForAiw(aiwId);
  const worktreePath = getWorktreePathForAiw(workingDir, aiwId);

  // First, remove the worktree.
  try {
    if (fs.existsSync(worktreePath) && worktreeExists(workingDir, worktreePath)) {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: workingDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch (err) {
    // If worktree remove fails, try a directory cleanup as a fallback.
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // Best effort.
    }
    throw new Error(`worktree remove failed: ${(err as Error).message}`);
  }

  // Then delete the branch if requested.
  if (opts?.deleteBranch) {
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: workingDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Branch may already be gone; ignore.
    }
  }
}

/**
 * Resolve isolation params for an AIW run. If `noWorktree` is true
 * (or the working dir is not a git repo), returns the working dir as
 * its own worktree (no actual worktree creation) — single-tenant
 * mode for ephemeral projects.
 */
export function resolveIsolation(
  workingDir: string,
  aiwId: string,
  opts?: { noWorktree?: boolean },
): IsolationResult {
  const branchName = getBranchNameForAiw(aiwId);
  const ports = getPortsForAiw(aiwId);

  if (opts?.noWorktree || !isGitRepo(workingDir)) {
    return {
      worktreePath: workingDir,
      branchName,
      backendPort: ports.backend,
      frontendPort: ports.frontend,
      created: false,
    };
  }

  const worktreePath = createWorktree(workingDir, aiwId);
  return {
    worktreePath,
    branchName,
    backendPort: ports.backend,
    frontendPort: ports.frontend,
    created: true,
  };
}