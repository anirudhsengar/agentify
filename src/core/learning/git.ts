import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TeamMemoryError } from "../memory/contracts.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import type { EvidenceReference } from "../memory/schema.ts";
import { digestCanonical, sortedUniqueStrings } from "../memory/serialization.ts";
import { buildSpecialistEvidenceReference } from "../specialists/evidence.ts";
import type {
  AcceptedMergeChange,
  AcceptedMergeEvent,
  LearningPolicy,
  MergeChangeStatus,
} from "./contracts.ts";
import { MAX_LEARNING_INSPECTED_FILES } from "./contracts.ts";

const GIT_OBJECT = /^[0-9a-f]{40,64}$/;
const GIT_BUFFER_LIMIT = 32 * 1024 * 1024;

interface GitResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function learningRepositoryRoot(cwd: string): string {
  try {
    return fs.realpathSync.native(path.resolve(cwd));
  } catch (error) {
    throw new TeamMemoryError("unsafe_path", `cannot resolve learning repository root ${cwd}`, {
      cause: error,
    });
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = GIT_BUFFER_LIMIT,
): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) {
    throw new TeamMemoryError(
      "persistence_failed",
      `cannot execute git for merge learning: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
  };
}

function gitError(result: GitResult): string {
  return result.stderr.toString("utf-8").trim().replace(/\s+/g, " ").slice(0, 240)
    || `git exited with status ${result.status ?? "unknown"}`;
}

export function resolveLearningCommit(cwdInput: string, commit: string): string {
  const cwd = learningRepositoryRoot(cwdInput);
  const result = runGit(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (result.status !== 0) {
    throw new TeamMemoryError("invalid_input", `unknown accepted commit ${commit}`);
  }
  const resolved = result.stdout.toString("utf-8").trim();
  if (!GIT_OBJECT.test(resolved)) {
    throw new TeamMemoryError("invalid_input", `git returned an invalid commit for ${commit}`);
  }
  return resolved;
}

export function readLearningHead(cwdInput: string): string {
  return resolveLearningCommit(cwdInput, "HEAD");
}

export function assertCommitReachableFromHead(cwdInput: string, commit: string): void {
  const cwd = learningRepositoryRoot(cwdInput);
  const resolved = resolveLearningCommit(cwd, commit);
  const result = runGit(cwd, ["merge-base", "--is-ancestor", resolved, "HEAD"]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `accepted commit ${resolved} is not reachable from repository HEAD`,
    );
  }
}

export function readFirstParent(cwdInput: string, commit: string): string {
  const cwd = learningRepositoryRoot(cwdInput);
  const resolved = resolveLearningCommit(cwd, commit);
  const result = runGit(cwd, ["rev-parse", "--verify", `${resolved}^1`]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `accepted commit ${resolved} has no first parent: ${gitError(result)}`,
    );
  }
  const parent = result.stdout.toString("utf-8").trim();
  if (!GIT_OBJECT.test(parent)) {
    throw new TeamMemoryError("invalid_input", `git returned an invalid first parent for ${resolved}`);
  }
  return parent;
}

function statusFromToken(token: string): MergeChangeStatus {
  switch (token[0]) {
    case "A": return "added";
    case "M":
    case "T": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    default:
      throw new TeamMemoryError("invalid_input", `unsupported accepted diff status ${token}`);
  }
}

function parseChangedFiles(output: Buffer, maximum: number): AcceptedMergeChange[] {
  const fields = output.toString("utf-8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: AcceptedMergeChange[] = [];
  for (let index = 0; index < fields.length;) {
    const token = fields[index++];
    if (!token) throw new TeamMemoryError("invalid_input", "accepted diff contains an empty status");
    const status = statusFromToken(token);
    if (status === "renamed" || status === "copied") {
      const previous = fields[index++];
      const current = fields[index++];
      if (!previous || !current) {
        throw new TeamMemoryError("invalid_input", `accepted diff ${token} entry is incomplete`);
      }
      changes.push({
        status,
        path: normalizeMemoryRepositoryPath(current, "accepted changed path"),
        previous_path: normalizeMemoryRepositoryPath(previous, "accepted previous path"),
      });
    } else {
      const current = fields[index++];
      if (!current) throw new TeamMemoryError("invalid_input", `accepted diff ${token} path is missing`);
      changes.push({
        status,
        path: normalizeMemoryRepositoryPath(current, "accepted changed path"),
        previous_path: null,
      });
    }
    if (changes.length > maximum) {
      throw new TeamMemoryError(
        "capacity_exceeded",
        `accepted change contains more than ${maximum} changed files`,
      );
    }
  }
  return changes.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) return byPath;
    const byStatus = left.status.localeCompare(right.status);
    if (byStatus !== 0) return byStatus;
    return (left.previous_path ?? "").localeCompare(right.previous_path ?? "");
  });
}

export function inspectAcceptedMerge(
  cwdInput: string,
  event: AcceptedMergeEvent,
  policy: LearningPolicy,
): AcceptedMergeChange[] {
  const cwd = learningRepositoryRoot(cwdInput);
  const head = readLearningHead(cwd);
  if (head !== event.expected_repository_head) {
    throw new TeamMemoryError(
      "revision_conflict",
      `learning expected repository head ${event.expected_repository_head}, found ${head}`,
    );
  }
  const accepted = resolveLearningCommit(cwd, event.accepted_commit);
  assertCommitReachableFromHead(cwd, accepted);
  const parent = readFirstParent(cwd, accepted);
  if (parent !== event.first_parent_commit) {
    throw new TeamMemoryError(
      "invalid_input",
      `accepted commit first parent mismatch: expected ${event.first_parent_commit}, found ${parent}`,
    );
  }
  const result = runGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    parent,
    accepted,
    "--",
  ]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot inspect final accepted diff: ${gitError(result)}`,
    );
  }
  return parseChangedFiles(
    result.stdout,
    Math.max(policy.max_changed_files, MAX_LEARNING_INSPECTED_FILES),
  );
}

function externalDiffEvidence(
  event: AcceptedMergeEvent,
  change: AcceptedMergeChange,
): EvidenceReference {
  const value = {
    accepted_commit: event.accepted_commit,
    first_parent_commit: event.first_parent_commit,
    status: change.status,
    path: change.path,
    previous_path: change.previous_path,
  };
  return {
    evidence_id: `evidence-${digestCanonical(value).slice(0, 24)}`,
    source_type: "merged_code",
    repository_path: null,
    commit_sha: event.accepted_commit,
    sha256: null,
    line_start: null,
    line_end: null,
    external_ref: `git-diff:${event.first_parent_commit}..${event.accepted_commit}:${change.status}:${change.path}`,
    description: `Accepted Git diff evidence for ${change.status} path ${change.path}`,
    observed_at: event.accepted_at,
    actor: event.actor,
  };
}

export function buildAcceptedMergeEvidence(
  cwd: string,
  event: AcceptedMergeEvent,
  changes: ReadonlyArray<AcceptedMergeChange>,
  maximum = 128,
): EvidenceReference[] {
  const evidence: EvidenceReference[] = [];
  for (const change of changes.slice(0, maximum)) {
    if (change.status === "deleted") {
      evidence.push(externalDiffEvidence(event, change));
      continue;
    }
    try {
      evidence.push(buildSpecialistEvidenceReference({
        cwd,
        supportingCommit: event.accepted_commit,
        repositoryPath: change.path,
        sourceType: "merged_code",
        observedAt: event.accepted_at,
        actor: event.actor,
      }));
    } catch (error) {
      if (error instanceof TeamMemoryError && error.code === "invalid_input") {
        evidence.push(externalDiffEvidence(event, change));
        continue;
      }
      throw error;
    }
  }
  if (evidence.length === 0) {
    evidence.push({
      evidence_id: `evidence-${digestCanonical({ event, kind: "empty-diff" }).slice(0, 24)}`,
      source_type: "merged_code",
      repository_path: null,
      commit_sha: event.accepted_commit,
      sha256: null,
      line_start: null,
      line_end: null,
      external_ref: event.pull_request_url ?? `git-commit:${event.accepted_commit}`,
      description: "Accepted commit contained no application file changes.",
      observed_at: event.accepted_at,
      actor: event.actor,
    });
  }
  return evidence.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

export function acceptedChangedPaths(changes: ReadonlyArray<AcceptedMergeChange>): string[] {
  return sortedUniqueStrings(changes.flatMap((change) =>
    change.previous_path === null ? [change.path] : [change.previous_path, change.path]
  ));
}

export function listRecentFirstParentCommits(
  cwdInput: string,
  maximum: number,
): string[] {
  const cwd = learningRepositoryRoot(cwdInput);
  const result = runGit(cwd, [
    "rev-list",
    "--first-parent",
    `--max-count=${maximum}`,
    "HEAD",
  ]);
  if (result.status !== 0) {
    throw new TeamMemoryError("invalid_input", `cannot list reconciliation commits: ${gitError(result)}`);
  }
  return result.stdout.toString("utf-8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => GIT_OBJECT.test(value))
    .reverse();
}

export function readLearningInstallationCommit(cwdInput: string): string {
  const cwd = learningRepositoryRoot(cwdInput);
  const result = runGit(cwd, [
    "log",
    "--first-parent",
    "--diff-filter=A",
    "--format=%H",
    "-n",
    "1",
    "HEAD",
    "--",
    ".agentify/manifest.json",
  ]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot locate Agentify installation commit: ${gitError(result)}`,
    );
  }
  const commit = result.stdout.toString("utf-8").trim();
  if (!GIT_OBJECT.test(commit)) {
    throw new TeamMemoryError(
      "not_initialized",
      "cannot reconcile learning before the committed Agentify installation is present",
    );
  }
  return commit;
}

export function readCommitMetadata(cwdInput: string, commit: string): {
  accepted_at: string;
  actor: string;
} {
  const cwd = learningRepositoryRoot(cwdInput);
  const resolved = resolveLearningCommit(cwd, commit);
  const result = runGit(cwd, ["show", "-s", "--format=%cI%x00%an", resolved]);
  if (result.status !== 0) {
    throw new TeamMemoryError("invalid_input", `cannot read commit metadata: ${gitError(result)}`);
  }
  const [timestamp, actor] = result.stdout.toString("utf-8").trim().split("\0");
  const date = new Date(timestamp ?? "");
  if (!Number.isFinite(date.getTime()) || !(actor ?? "").trim()) {
    throw new TeamMemoryError("invalid_input", `git returned invalid metadata for ${resolved}`);
  }
  return { accepted_at: date.toISOString(), actor: actor!.trim() };
}
