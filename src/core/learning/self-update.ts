import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TeamMemoryError } from "../memory/contracts.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import { sortedUniqueStrings } from "../memory/serialization.ts";
import { learningRepositoryRoot, readLearningHead } from "./git.ts";
import { isLearningManagedPath } from "./knowledge-paths.ts";
import {
  MAX_LEARNING_PUBLICATION_BYTES,
  MAX_LEARNING_PUBLICATION_LINES,
  MAX_LEARNING_PUBLICATION_PATHS,
} from "./contracts.ts";

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = 32 * 1024 * 1024,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    env,
    maxBuffer,
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

function pathsFromNameStatus(output: Buffer): string[] {
  const fields = output.toString("utf-8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      throw new TeamMemoryError("invalid_input", "learning diff contains an empty status");
    }
    const previousOrCurrent = fields[index++];
    if (!previousOrCurrent) {
      throw new TeamMemoryError("invalid_input", `learning diff ${status} path is missing`);
    }
    paths.push(previousOrCurrent);
    if (status.startsWith("R") || status.startsWith("C")) {
      const current = fields[index++];
      if (!current) {
        throw new TeamMemoryError("invalid_input", `learning diff ${status} destination is missing`);
      }
      paths.push(current);
    }
  }
  return paths;
}

function assertPathLimit(paths: string[]): string[] {
  const normalized = sortedUniqueStrings(paths.map((value) =>
    normalizeMemoryRepositoryPath(value, "learning changed path")
  ));
  if (normalized.length > MAX_LEARNING_PUBLICATION_PATHS) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `learning update changes more than ${MAX_LEARNING_PUBLICATION_PATHS} paths`,
    );
  }
  return normalized;
}

function changedPaths(cwd: string): { paths: string[]; untracked: string[] } {
  const tracked = pathsFromNameStatus(runGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    "--find-copies-harder",
    "HEAD",
    "--",
  ]));
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
  return {
    paths: assertPathLimit([...tracked, ...untracked]),
    untracked: assertPathLimit(untracked),
  };
}

function committedChangedPaths(cwd: string, base: string, head: string): string[] {
  return assertPathLimit(pathsFromNameStatus(runGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    "--find-copies-harder",
    base,
    head,
    "--",
  ])));
}

function changedLinesFromNumstat(output: Buffer): number {
  return output.toString("utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((total, row) => {
      const [added, deleted] = row.split("\t");
      const additions = added === "-" ? 0 : Number(added);
      const deletions = deleted === "-" ? 0 : Number(deleted);
      if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
        throw new TeamMemoryError("invalid_input", "git returned invalid learning diff statistics");
      }
      return total + additions + deletions;
    }, 0);
}

export interface LearningPublicationMetrics {
  path_count: number;
  patch_bytes: number;
  changed_lines: number;
}

function assertPublicationMetrics(metrics: LearningPublicationMetrics): void {
  if (metrics.patch_bytes > MAX_LEARNING_PUBLICATION_BYTES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `learning update exceeds the ${MAX_LEARNING_PUBLICATION_BYTES}-byte publication limit`,
    );
  }
  if (metrics.changed_lines > MAX_LEARNING_PUBLICATION_LINES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `learning update exceeds the ${MAX_LEARNING_PUBLICATION_LINES}-line publication limit`,
    );
  }
}

function workingPublicationMetrics(
  cwd: string,
  paths: ReadonlyArray<string>,
): LearningPublicationMetrics {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-learning-index-"));
  const temporaryIndex = path.join(temporaryRoot, "index");
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    runGit(cwd, ["read-tree", "HEAD"], undefined, env);
    runGit(cwd, ["add", "-A", "--"], undefined, env);
    const patch = runGit(
      cwd,
      ["diff", "--cached", "--binary", "--full-index", "HEAD", "--"],
      undefined,
      env,
    );
    const metrics = {
      path_count: paths.length,
      patch_bytes: patch.byteLength,
      changed_lines: changedLinesFromNumstat(runGit(
        cwd,
        ["diff", "--cached", "--numstat", "HEAD", "--"],
        undefined,
        env,
      )),
    };
    assertPublicationMetrics(metrics);
    return metrics;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function committedPublicationMetrics(
  cwd: string,
  base: string,
  head: string,
  pathCount: number,
): LearningPublicationMetrics {
  const patch = runGit(
    cwd,
    ["diff", "--binary", "--full-index", base, head, "--"],
  );
  const metrics = {
    path_count: pathCount,
    patch_bytes: patch.byteLength,
    changed_lines: changedLinesFromNumstat(runGit(cwd, ["diff", "--numstat", base, head, "--"])),
  };
  assertPublicationMetrics(metrics);
  return metrics;
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

function assertRegularTreeEntries(
  cwd: string,
  refs: ReadonlyArray<string>,
  relativePath: string,
): void {
  for (const ref of refs) {
    const records = runGit(cwd, ["ls-tree", "-z", ref, "--", relativePath])
      .toString("utf-8").split("\0").filter(Boolean);
    for (const record of records) {
      const mode = record.slice(0, record.indexOf(" "));
      if (mode !== "100644" && mode !== "100755") {
        throw new TeamMemoryError(
          "unsafe_path",
          `learning proposal path is not a regular Git file: ${relativePath} (${mode})`,
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
  metrics: LearningPublicationMetrics;
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
  const changed = changedPaths(cwd);
  const paths = changed.paths;
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
  return {
    expected_head: expectedHead,
    paths,
    metrics: workingPublicationMetrics(cwd, paths),
  };
}

export interface CommittedLearningDiffVerification {
  base_commit: string;
  head_commit: string;
  paths: string[];
  metrics: LearningPublicationMetrics;
}

export function verifyCommittedLearningDiff(
  cwdInput: string,
  baseCommit: string,
  headCommit: string,
): CommittedLearningDiffVerification {
  const cwd = learningRepositoryRoot(cwdInput);
  const paths = committedChangedPaths(cwd, baseCommit, headCommit);
  for (const relativePath of paths) {
    if (!isLearningManagedPath(relativePath)) {
      throw new TeamMemoryError(
        "policy_violation",
        `learning proposal cannot modify ${relativePath}`,
      );
    }
    assertRegularTreeEntries(cwd, [baseCommit, headCommit], relativePath);
  }
  return {
    base_commit: baseCommit,
    head_commit: headCommit,
    paths,
    metrics: committedPublicationMetrics(cwd, baseCommit, headCommit, paths.length),
  };
}
