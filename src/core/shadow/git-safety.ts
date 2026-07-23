// Git state capture and verification for the supported local shadow runner.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { git, type CommandOptions } from "./identity.ts";

const KNOWN_MANAGED_RELATIVE_DIRS = [".agents/agentify", ".claude/agentify", ".pi/agentify"] as const;

export interface GitSnapshot {
  commitSha: string;
  branch: string;
  detached: boolean;
  localRefs: string;
  remoteRefs: string;
  remotes: string;
  porcelain: string;
  inventoryDigest: string;
  ignoredTopologyDigest: string;
  managedStateRelative: string | null;
}

function realpathSafe(candidate: string): string {
  try { return fs.realpathSync(candidate); }
  catch (error) {
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

function gitBuffer(root: string, args: string[], timeoutMs: number): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer", timeout: Math.max(1, Math.floor(timeoutMs)), killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function nulEntries(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean).sort();
}

function inventoryDigests(root: string, managedRelative: string | null, timeoutMs: number): { inventoryDigest: string; ignoredTopologyDigest: string } {
  const managedPrefix = managedRelative ? `${managedRelative}/` : null;
  const keep = (entry: string) => {
    const file = entry.includes("\t") ? entry.slice(entry.indexOf("\t") + 1) : entry;
    return !managedRelative || (file !== managedRelative && !file.startsWith(managedPrefix!));
  };
  const tracked = nulEntries(gitBuffer(root, ["ls-files", "-s", "-z"], timeoutMs)).filter(keep);
  const untracked = nulEntries(gitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs)).filter(keep);
  const ignored = nulEntries(gitBuffer(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], timeoutMs)).filter(keep);
  const topology = ignored.map((file) => {
    const target = path.join(root, file);
    try {
      const stat = fs.lstatSync(target);
      return `${file}:${stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(target)}` : stat.isDirectory() ? "directory" : `file:${stat.mode & 0o777}`}`;
    } catch { return `${file}:missing`; }
  });
  return {
    inventoryDigest: `sha256:${createHash("sha256").update([...tracked, ...untracked.map((x) => `? ${x}`)].join("\n")).digest("hex")}`,
    ignoredTopologyDigest: `sha256:${createHash("sha256").update(topology.join("\n")).digest("hex")}`,
  };
}

export async function captureGitSnapshot(root: string, options?: CommandOptions): Promise<GitSnapshot> {
  const rootResolved = realpathSafe(root);
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const commitSha = await git(["rev-parse", "HEAD"], rootResolved, options);
  const porcelain = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], rootResolved, options);
  const localRefs = await git(["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads", "refs/tags"], rootResolved, options);
  const remoteRefs = await git(["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"], rootResolved, options);
  const remotes = await git(["remote", "-v"], rootResolved, options);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], rootResolved, options);
  const detached = branch === "HEAD";
  const managedStateRelative = resolveManagedStateRelative(rootResolved);
  const digests = inventoryDigests(rootResolved, managedStateRelative, timeoutMs);
  return { commitSha, branch, detached, localRefs, remoteRefs, remotes, porcelain, ...digests, managedStateRelative };
}

export interface SafetyResult { ok: boolean; failures: string[]; before: GitSnapshot; after: GitSnapshot }

export async function verifyGitSafety(before: GitSnapshot, root: string, options?: CommandOptions): Promise<SafetyResult> {
  const after = await captureGitSnapshot(root, options);
  const failures: string[] = [];
  if (before.commitSha !== after.commitSha) failures.push("HEAD changed");
  if (before.branch !== after.branch || before.detached !== after.detached) failures.push("branch or detached state changed");
  if (before.localRefs !== after.localRefs) failures.push("local refs changed");
  if (before.remoteRefs !== after.remoteRefs) failures.push("remote refs changed");
  if (before.remotes !== after.remotes) failures.push("remote configuration changed");
  if (before.inventoryDigest !== after.inventoryDigest) failures.push("tracked or untracked inventory changed");
  if (before.ignoredTopologyDigest !== after.ignoredTopologyDigest) failures.push("ignored-file topology changed");
  if (before.porcelain !== after.porcelain) failures.push("working tree or index changed");
  return { ok: failures.length === 0, failures, before, after };
}

function porcelainPaths(value: string): string[] {
  const records = (value.includes("\0") ? value.split("\0") : value.split("\n")).filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    paths.push(record.slice(3));
    if (record[0] === "R" || record[1] === "R" || record[0] === "C" || record[1] === "C") i += 1;
  }
  return paths;
}

export function findUnsafeChanges(snapshot: GitSnapshot, currentPorcelain: string): string[] {
  const before = new Set(porcelainPaths(snapshot.porcelain));
  const managed = snapshot.managedStateRelative;
  return porcelainPaths(currentPorcelain)
    .filter((file) => !before.has(file))
    .filter((file) => !managed || (file !== managed && !file.startsWith(`${managed}/`)))
    .sort();
}

export function assertInsideRoot(target: string, root: string, label: string): string {
  const rootResolved = realpathSafe(root);
  const targetResolved = path.resolve(target);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}${path.sep}`)) throw new Error(`${label} escapes root`);
  return targetResolved;
}

export { KNOWN_MANAGED_RELATIVE_DIRS };
