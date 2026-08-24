import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EvidenceReference,
  MemorySourceType,
} from "../memory/schema.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import { TeamMemoryError } from "../memory/contracts.ts";
import { digestCanonical } from "../memory/serialization.ts";

const MAX_SPECIALIST_EVIDENCE_BYTES = 16 * 1024 * 1024;
const GIT_OBJECT = /^[0-9a-f]{40,64}$/;

interface GitResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface BuildSpecialistEvidenceInput {
  cwd: string;
  supportingCommit: string;
  repositoryPath: string;
  sourceType: MemorySourceType;
  observedAt: string;
  actor: string | null;
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = 1024 * 1024,
): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) {
    throw new TeamMemoryError(
      "persistence_failed",
      `cannot execute git while building specialist evidence: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
  };
}

function conciseGitError(result: GitResult): string {
  return result.stderr.toString("utf-8").trim().replace(/\s+/g, " ").slice(0, 240)
    || `git exited with status ${result.status ?? "unknown"}`;
}

function repositoryRoot(cwd: string): string {
  try {
    return fs.realpathSync.native(path.resolve(cwd));
  } catch (error) {
    throw new TeamMemoryError("unsafe_path", `cannot resolve repository root ${cwd}`, {
      cause: error,
    });
  }
}

function resolveCommit(cwd: string, commit: string): string {
  const resolved = runGit(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (resolved.status !== 0) {
    throw new TeamMemoryError("invalid_input", `unknown specialist evidence commit ${commit}`);
  }
  const objectId = resolved.stdout.toString("utf-8").trim();
  if (!GIT_OBJECT.test(objectId)) {
    throw new TeamMemoryError("invalid_input", `git returned an invalid commit identity for ${commit}`);
  }
  const ancestor = runGit(cwd, ["merge-base", "--is-ancestor", objectId, "HEAD"]);
  if (ancestor.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `specialist evidence commit ${commit} is not reachable from repository HEAD`,
    );
  }
  return objectId;
}

function resolveBlob(cwd: string, commit: string, repositoryPath: string): string {
  const result = runGit(cwd, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    commit,
    "--",
    repositoryPath,
  ]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot inspect specialist evidence ${repositoryPath}: ${conciseGitError(result)}`,
    );
  }
  const records = result.stdout.toString("utf-8").split("\0").filter(Boolean);
  if (records.length !== 1) {
    throw new TeamMemoryError(
      "invalid_input",
      `specialist evidence path is not one tracked file at ${commit}: ${repositoryPath}`,
    );
  }
  const separator = records[0]!.indexOf("\t");
  if (separator < 0 || records[0]!.slice(separator + 1) !== repositoryPath) {
    throw new TeamMemoryError(
      "invalid_input",
      `specialist evidence path did not round-trip exactly: ${repositoryPath}`,
    );
  }
  const metadata = records[0]!.slice(0, separator).split(" ");
  if (metadata.length !== 3 || metadata[1] !== "blob" || !GIT_OBJECT.test(metadata[2]!)) {
    throw new TeamMemoryError(
      "invalid_input",
      `specialist evidence is not a tracked regular blob: ${repositoryPath}`,
    );
  }
  if (metadata[0] === "120000") {
    throw new TeamMemoryError(
      "unsafe_path",
      `specialist evidence cannot use a symlink: ${repositoryPath}`,
    );
  }
  return metadata[2]!;
}

function readBlob(cwd: string, objectId: string, repositoryPath: string): Buffer {
  const sizeResult = runGit(cwd, ["cat-file", "-s", objectId]);
  if (sizeResult.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot determine specialist evidence size for ${repositoryPath}`,
    );
  }
  const size = Number(sizeResult.stdout.toString("utf-8").trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `git returned an invalid specialist evidence size for ${repositoryPath}`,
    );
  }
  if (size > MAX_SPECIALIST_EVIDENCE_BYTES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `specialist evidence ${repositoryPath} exceeds ${MAX_SPECIALIST_EVIDENCE_BYTES} bytes`,
    );
  }
  const result = runGit(
    cwd,
    ["cat-file", "blob", objectId],
    MAX_SPECIALIST_EVIDENCE_BYTES + 1024,
  );
  if (result.status !== 0 || result.stdout.byteLength !== size) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot read exact specialist evidence bytes for ${repositoryPath}`,
    );
  }
  return result.stdout;
}

export function buildSpecialistEvidenceReference(
  input: BuildSpecialistEvidenceInput,
): EvidenceReference {
  const cwd = repositoryRoot(input.cwd);
  const repositoryPath = normalizeMemoryRepositoryPath(
    input.repositoryPath,
    "specialist evidence path",
  );
  const commit = resolveCommit(cwd, input.supportingCommit);
  const blob = resolveBlob(cwd, commit, repositoryPath);
  const content = readBlob(cwd, blob, repositoryPath);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  return {
    evidence_id: `evidence-${digestCanonical({
      commit,
      repositoryPath,
      sourceType: input.sourceType,
    }).slice(0, 24)}`,
    source_type: input.sourceType,
    repository_path: repositoryPath,
    commit_sha: commit,
    source_commit_time: readGitCommitTimestamp(cwd, commit),
    sha256,
    line_start: null,
    line_end: null,
    external_ref: null,
    description: `Tracked repository evidence for specialist and procedure discovery: ${repositoryPath}`,
    observed_at: input.observedAt,
    actor: input.actor,
  };
}

export function readGitCommitTimestamp(cwdInput: string, commitInput: string): string {
  const cwd = repositoryRoot(cwdInput);
  const commit = resolveCommit(cwd, commitInput);
  const result = runGit(cwd, ["show", "-s", "--format=%cI", commit]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot read specialist evidence timestamp for ${commit}`,
    );
  }
  const timestamp = result.stdout.toString("utf-8").trim();
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TeamMemoryError(
      "invalid_input",
      `git returned an invalid specialist evidence timestamp for ${commit}`,
    );
  }
  return parsed.toISOString();
}

export function readGitHeadCommit(cwdInput: string): string {
  const cwd = repositoryRoot(cwdInput);
  const result = runGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot resolve the repository HEAD for specialist discovery: ${conciseGitError(result)}`,
    );
  }
  const commit = result.stdout.toString("utf-8").trim();
  if (!GIT_OBJECT.test(commit)) {
    throw new TeamMemoryError("invalid_input", "git returned an invalid HEAD commit identity");
  }
  return commit;
}

export function listTrackedFilesAtCommit(cwdInput: string, commitInput: string): string[] {
  const cwd = repositoryRoot(cwdInput);
  const commit = resolveCommit(cwd, commitInput);
  const result = runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", commit], 32 * 1024 * 1024);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot list tracked specialist evidence at ${commit}: ${conciseGitError(result)}`,
    );
  }
  return [...new Set(result.stdout.toString("utf-8").split("\0").filter(Boolean).map((repositoryPath) => (
    normalizeMemoryRepositoryPath(repositoryPath, "tracked specialist evidence path")
  )))].sort();
}
