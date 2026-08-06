import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TeamMemoryError } from "../memory/contracts.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import { sortedUniqueStrings } from "../memory/serialization.ts";
import { learningRepositoryRoot, readLearningHead } from "./git.ts";
import { isLearningManagedPath } from "./knowledge-paths.ts";

const MAX_SELF_UPDATE_PATHS = 512;

function runGit(cwd: string, args: ReadonlyArray<string>): Buffer {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new TeamMemoryError(
      "persistence_failed",
      `cannot execute git while verifying learning diff: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const message = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf-8").trim().replace(/\s+/g, " ").slice(0, 240)
      : "";
    throw new TeamMemoryError(
      "invalid_input",
      `cannot inspect learning diff: ${message || `git exited ${result.status ?? "unknown"}`}`,
    );
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function changedPaths(cwd: string): string[] {
  const fields = runGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    "--find-copies-harder",
    "HEAD",
    "--",
  ]).toString("utf-8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const tracked: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      throw new TeamMemoryError("invalid_input", "learning diff contains an empty status");
    }
    const previousOrCurrent = fields[index++];
    if (!previousOrCurrent) {
      throw new TeamMemoryError("invalid_input", `learning diff ${status} path is missing`);
    }
    tracked.push(previousOrCurrent);
    if (status.startsWith("R") || status.startsWith("C")) {
      const current = fields[index++];
      if (!current) {
        throw new TeamMemoryError("invalid_input", `learning diff ${status} destination is missing`);
      }
      tracked.push(current);
    }
  }
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
  const paths = sortedUniqueStrings([...tracked, ...untracked].map((value) =>
    normalizeMemoryRepositoryPath(value, "learning changed path")
  ));
  if (paths.length > MAX_SELF_UPDATE_PATHS) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `learning update changes more than ${MAX_SELF_UPDATE_PATHS} paths`,
    );
  }
  return paths;
}

function assertRegularGitEntries(cwd: string, relativePath: string): void {
  for (const args of [
    ["ls-tree", "-z", "HEAD", "--", relativePath],
    ["ls-files", "--stage", "-z", "--", relativePath],
  ]) {
    const records = runGit(cwd, args).toString("utf-8").split("\0").filter(Boolean);
    for (const record of records) {
      const mode = record.slice(0, record.indexOf(" "));
      if (mode !== "100644" && mode !== "100755") {
        throw new TeamMemoryError(
          "unsafe_path",
          `learning self-update path is not a regular Git file: ${relativePath} (${mode})`,
        );
      }
    }
  }
}

function assertNoSymlinkAncestors(cwd: string, relativePath: string): void {
  const segments = relativePath.split("/");
  let current = cwd;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new TeamMemoryError(
          "unsafe_path",
          `learning self-update path has a symlink ancestor: ${relativePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export interface LearningDiffVerification {
  expected_head: string;
  paths: string[];
}

export function verifyLearningSelfUpdateDiff(
  cwdInput: string,
  expectedHead: string,
): LearningDiffVerification {
  const cwd = learningRepositoryRoot(cwdInput);
  const currentHead = readLearningHead(cwd);
  if (currentHead !== expectedHead) {
    throw new TeamMemoryError(
      "revision_conflict",
      `learning self-update expected HEAD ${expectedHead}, found ${currentHead}`,
    );
  }
  const paths = changedPaths(cwd);
  for (const relativePath of paths) {
    if (
      relativePath.startsWith(".agentify/runtime/")
      || relativePath.startsWith(".agentify/state-transactions/")
    ) {
      throw new TeamMemoryError(
        "policy_violation",
        `operational learning state cannot be committed: ${relativePath}`,
      );
    }
    if (!isLearningManagedPath(relativePath)) {
      throw new TeamMemoryError(
        "policy_violation",
        `learning self-update cannot modify ${relativePath}`,
      );
    }
    assertNoSymlinkAncestors(cwd, relativePath);
    assertRegularGitEntries(cwd, relativePath);
    const absolute = path.join(cwd, ...relativePath.split("/"));
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new TeamMemoryError(
          "unsafe_path",
          `learning self-update path is a symlink: ${relativePath}`,
        );
      }
      if (!stat.isFile()) {
        throw new TeamMemoryError(
          "unsafe_path",
          `learning self-update path is not a regular file: ${relativePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return { expected_head: expectedHead, paths };
}
