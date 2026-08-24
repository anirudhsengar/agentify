import * as fs from "node:fs";
import * as path from "node:path";
import { markerForArtifactPath } from "../artifacts/managed-markers.ts";

/**
 * Managed installation paths whose prior Agentify ownership must be recognized
 * before the activation transaction restages them. Without this recognition a
 * byte-compared artifact (`sha256` marker) written by an earlier Agentify
 * version would be misread as a user-owned file and preserved alongside.
 */
const FOCUSED_RUNTIME_PATHS = [
  "AGENTS.md",
  "SETUP.md",
  ".github/agentify-task-policy.json",
  ".github/agentify/validation-smoke.mjs",
  ".github/agentify/runtime-inventory.json",
  ".github/scripts/complete-accepted-task-merge.mjs",
  ".github/scripts/task-state-github.mjs",
  ".github/workflows/agentify-issue.yml",
  ".github/workflows/agentify-learn.yml",
  ".github/agentify/task-runtime.mjs",
  ".github/agentify/learning-runtime.mjs",
] as const;

function recognizedManagedFile(cwd: string, relativePath: string): boolean {
  const filePath = path.join(cwd, ...relativePath.split("/"));
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const marker = markerForArtifactPath(relativePath);
    return marker === "sha256" || fs.readFileSync(filePath, "utf-8").includes(marker);
  } catch {
    return false;
  }
}

/**
 * Paths of the focused installation that are already recognizably Agentify-owned.
 * Staging uses this to restage its own prior output in place instead of
 * preserving it as a user-owned conflict.
 */
export function recognizedManagedInstallationPaths(cwd: string): Set<string> {
  return new Set(
    FOCUSED_RUNTIME_PATHS.filter((relativePath) => recognizedManagedFile(cwd, relativePath)),
  );
}
