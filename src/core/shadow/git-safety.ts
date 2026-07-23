// Git state capture and verification for the supported local shadow runner.
// Captures a snapshot of HEAD, branch, refs, working tree status, and a
// digest of the file inventory outside the Agentify managed state root.
// Verification re-runs the snapshot and refuses to record evidence when
// anything outside the managed state has changed or when HEAD/branch/refs
// have shifted.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { git } from "./identity.ts";

const KNOWN_MANAGED_RELATIVE_DIRS = [
  ".agents/agentify",
  ".claude/agentify",
  ".pi/agentify",
] as const;

export interface GitSnapshot {
  commitSha: string;
  branch: string;
  detached: boolean;
  remoteRefs: string;
  porcelain: string;
  /** Stable digest of files outside the managed state root. */
  inventoryDigest: string;
  /** Resolved managed state relative directory (or null). */
  managedStateRelative: string | null;
}

function realpathSafe(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(candidate);
    throw error;
  }
}

export function resolveManagedStateRelative(root: string): string | null {
  const rootResolved = realpathSafe(root);
  for (const candidate of KNOWN_MANAGED_RELATIVE_DIRS) {
    const target = path.resolve(rootResolved, candidate);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`managed state path is a symlink: ${target}`);
      if (stat.isDirectory()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

function listInventory(root: string, managedRelative: string | null): string {
  const rootResolved = realpathSafe(root);
  const args = ["-C", rootResolved, "ls-files", "-z"];
  const raw = execFileSync("git", args, { encoding: "buffer" });
  // ls-files -z splits with NUL. Each entry is "mode hash stage\tpath".
  const entries: string[] = [];
  let buffer = "";
  for (const byte of raw) {
    if (byte === 0) { if (buffer) entries.push(buffer); buffer = ""; continue; }
    buffer += String.fromCharCode(byte);
  }
  if (buffer) entries.push(buffer);
  const managedPrefix = managedRelative ? `${managedRelative}/` : null;
  const paths = entries
    .map((entry) => entry.split("\t").pop() ?? "")
    .filter(Boolean)
    .filter((p) => !managedPrefix || p !== managedRelative || p.startsWith(managedPrefix) === false ? true : false)
    .sort();
  return paths.join("\n");
}

export async function captureGitSnapshot(root: string): Promise<GitSnapshot> {
  const rootResolved = realpathSafe(root);
  const commitSha = await git(["rev-parse", "HEAD"], rootResolved);
  const porcelain = await git(["status", "--porcelain=v1", "--untracked-files=all"], rootResolved);
  const remoteRefs = await git(["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"], rootResolved);
  let branch = "HEAD";
  let detached = true;
  try {
    branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], rootResolved);
    detached = branch === "HEAD";
  } catch {
    detached = true;
  }
  const managedRelative = resolveManagedStateRelative(rootResolved);
  const inventory = listInventory(rootResolved, managedRelative);
  const inventoryDigest = `sha256:${createHash("sha256").update(inventory).digest("hex")}`;
  return { commitSha, branch, detached, remoteRefs, porcelain, inventoryDigest, managedStateRelative: managedRelative };
}

export interface SafetyResult {
  ok: boolean;
  failures: string[];
  before: GitSnapshot;
  after: GitSnapshot;
}

export async function verifyGitSafety(before: GitSnapshot, root: string): Promise<SafetyResult> {
  const after = await captureGitSnapshot(root);
  const failures: string[] = [];
  if (before.commitSha !== after.commitSha) failures.push(`HEAD changed from ${before.commitSha} to ${after.commitSha}`);
  if (before.branch !== after.branch) failures.push(`branch changed from ${before.branch} to ${after.branch}`);
  if (before.detached !== after.detached) failures.push(`detached state changed from ${before.detached} to ${after.detached}`);
  if (before.remoteRefs !== after.remoteRefs) failures.push(`remote refs changed`);
  if (before.inventoryDigest !== after.inventoryDigest) failures.push(`file inventory digest changed`);
  return { ok: failures.length === 0, failures, before, after };
}

/**
 * Validate that the changed set since the snapshot only touches files under
 * the managed Agentify state root. Used to confirm that mid-run writes (such
 * as the shadow packet itself) did not bleed into source.
 */
export function findUnsafeChanges(snapshot: GitSnapshot, currentPorcelain: string): string[] {
  const before = new Set(snapshot.porcelain.split("\n").filter(Boolean).map((line) => line.slice(3)));
  const after = new Set(currentPorcelain.split("\n").filter(Boolean).map((line) => line.slice(3)));
  const managed = snapshot.managedStateRelative;
  const introduced: string[] = [];
  for (const file of after) if (!before.has(file)) {
    if (managed && (file === managed || file.startsWith(`${managed}/`))) continue;
    introduced.push(file);
  }
  return introduced.sort();
}

/**
 * Reject any attempt to write to a path that escapes the managed state root
 * or the private pilot workspace. Returns the canonical absolute path when
 * accepted.
 */
export function assertInsideRoot(target: string, root: string, label: string): string {
  const rootResolved = realpathSafe(root);
  const targetResolved = path.resolve(target);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`${label} escapes root ${root}`);
  }
  const relative = path.relative(rootResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside root ${root}`);
  }
  return targetResolved;
}

export { KNOWN_MANAGED_RELATIVE_DIRS };