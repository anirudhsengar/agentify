import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceReference } from "./schema.ts";
import { normalizeMemoryRepositoryPath } from "./paths.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "./contracts.ts";

const MAX_EVIDENCE_BLOB_BYTES = 16 * 1024 * 1024;
const GIT_HEX_OBJECT = /^[0-9a-f]{40,64}$/;

interface GitResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function repositoryRoot(cwd: string): string {
  try {
    return fs.realpathSync.native(path.resolve(cwd));
  } catch (error) {
    throw new TeamMemoryError(
      "unsafe_path",
      `cannot resolve repository root ${path.resolve(cwd)}`,
      { cause: error },
    );
  }
}

function runGit(cwd: string, args: ReadonlyArray<string>, maxBuffer = 1024 * 1024): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) {
    throw new TeamMemoryError(
      "persistence_failed",
      `cannot execute git while validating memory provenance: ${result.error.message}`,
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
  const stderr = result.stderr.toString("utf-8").trim().replace(/\s+/g, " ");
  return stderr.slice(0, 240) || `git exited with status ${result.status ?? "unknown"}`;
}

function assertGitRepository(cwd: string): void {
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (result.status !== 0 || result.stdout.toString("utf-8").trim() !== "true") {
    throw new TeamMemoryError(
      "invalid_input",
      `durable team memory requires a Git repository: ${conciseGitError(result)}`,
    );
  }
}

function assertReachableCommit(cwd: string, commit: string): void {
  const object = runGit(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (object.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `memory evidence references an unknown commit ${commit}`,
    );
  }
  const resolved = object.stdout.toString("utf-8").trim();
  if (!GIT_HEX_OBJECT.test(resolved)) {
    throw new TeamMemoryError("invalid_input", `git returned an invalid commit identity for ${commit}`);
  }
  const ancestor = runGit(cwd, ["merge-base", "--is-ancestor", resolved, "HEAD"]);
  if (ancestor.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `memory evidence commit ${commit} is not reachable from the current repository HEAD`,
    );
  }
}

interface GitTreeBlob {
  mode: string;
  objectId: string;
}

function resolveBlob(cwd: string, commit: string, repositoryPath: string): GitTreeBlob {
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
      `cannot inspect evidence ${repositoryPath} at ${commit}: ${conciseGitError(result)}`,
    );
  }
  const records = result.stdout.toString("utf-8").split("\0").filter(Boolean);
  if (records.length !== 1) {
    throw new TeamMemoryError(
      "invalid_input",
      `memory evidence path does not identify one tracked file at ${commit}: ${repositoryPath}`,
    );
  }
  const separator = records[0]!.indexOf("\t");
  if (separator < 0 || records[0]!.slice(separator + 1) !== repositoryPath) {
    throw new TeamMemoryError(
      "invalid_input",
      `git evidence path did not round-trip exactly: ${repositoryPath}`,
    );
  }
  const metadata = records[0]!.slice(0, separator).split(" ");
  if (metadata.length !== 3 || metadata[1] !== "blob" || !GIT_HEX_OBJECT.test(metadata[2]!)) {
    throw new TeamMemoryError(
      "invalid_input",
      `memory evidence path is not a regular tracked blob: ${repositoryPath}`,
    );
  }
  if (metadata[0] === "120000") {
    throw new TeamMemoryError(
      "unsafe_path",
      `memory evidence cannot be supported by a symlink: ${repositoryPath}`,
    );
  }
  return { mode: metadata[0]!, objectId: metadata[2]! };
}

function readBlob(cwd: string, objectId: string, repositoryPath: string): Buffer {
  const sizeResult = runGit(cwd, ["cat-file", "-s", objectId]);
  if (sizeResult.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot determine evidence size for ${repositoryPath}: ${conciseGitError(sizeResult)}`,
    );
  }
  const size = Number(sizeResult.stdout.toString("utf-8").trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TeamMemoryError("invalid_input", `git returned an invalid evidence size for ${repositoryPath}`);
  }
  if (size > MAX_EVIDENCE_BLOB_BYTES) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `memory evidence ${repositoryPath} exceeds the ${MAX_EVIDENCE_BLOB_BYTES}-byte verification limit`,
    );
  }
  const result = runGit(cwd, ["cat-file", "blob", objectId], MAX_EVIDENCE_BLOB_BYTES + 1024);
  if (result.status !== 0) {
    throw new TeamMemoryError(
      "invalid_input",
      `cannot read evidence ${repositoryPath}: ${conciseGitError(result)}`,
    );
  }
  if (result.stdout.byteLength !== size) {
    throw new TeamMemoryError(
      "invalid_input",
      `git returned an unexpected byte count for evidence ${repositoryPath}`,
    );
  }
  return result.stdout;
}

function assertLineRange(reference: EvidenceReference, content: Buffer): void {
  if (reference.line_start === null && reference.line_end === null) return;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new TeamMemoryError(
      "invalid_input",
      `line-addressed evidence must be valid UTF-8: ${reference.repository_path}`,
      { cause: error },
    );
  }
  const logicalLineCount = text.length === 0
    ? 0
    : text.endsWith("\n")
      ? text.split("\n").length - 1
      : text.split("\n").length;
  const lineStart = reference.line_start ?? reference.line_end;
  const lineEnd = reference.line_end ?? reference.line_start;
  if (
    lineStart === null
    || lineEnd === null
    || lineStart < 1
    || lineEnd < lineStart
    || lineEnd > logicalLineCount
  ) {
    throw new TeamMemoryError(
      "invalid_input",
      `evidence line range ${lineStart ?? "?"}-${lineEnd ?? "?"} is outside ${reference.repository_path} at ${reference.commit_sha}`,
    );
  }
}

export function validateEvidenceProvenance(
  cwd: string,
  evidence: ReadonlyArray<EvidenceReference>,
  options?: MemoryStoreOptions,
): void {
  if (options?.provenanceVerifier !== undefined) {
    options.provenanceVerifier({ cwd, evidence });
    return;
  }
  const root = repositoryRoot(cwd);
  assertGitRepository(root);
  const verifiedCommits = new Set<string>();
  for (const reference of evidence) {
    if (!verifiedCommits.has(reference.commit_sha)) {
      assertReachableCommit(root, reference.commit_sha);
      verifiedCommits.add(reference.commit_sha);
    }
    if (reference.repository_path === null) continue;
    const repositoryPath = normalizeMemoryRepositoryPath(
      reference.repository_path,
      "evidence repository path",
    );
    const blob = resolveBlob(root, reference.commit_sha, repositoryPath);
    void blob.mode;
    const content = readBlob(root, blob.objectId, repositoryPath);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    if (reference.sha256 !== digest) {
      throw new TeamMemoryError(
        "invalid_input",
        `memory evidence digest does not match ${repositoryPath} at ${reference.commit_sha}`,
      );
    }
    assertLineRange(reference, content);
  }
}
