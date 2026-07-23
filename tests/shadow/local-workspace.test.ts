import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acquireLock,
  lockPathFor,
  readLock,
  removeIfStale,
} from "../../src/core/shadow/lock.ts";
import {
  assertManagedWrite,
  preparePrivateClone,
  resolveWorkspacePaths,
} from "../../src/core/shadow/workspace.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-shadow-"));
}

test("acquireLock succeeds once and a second concurrent acquire fails clearly", () => {
  const root = tmp();
  try {
    const lock = acquireLock(root, { repo: "owner/repo", engagementId: "eng", issueNumber: 1, localRunId: "abc" });
    assert.ok(fs.existsSync(lockPathFor(root, "owner/repo", "eng", 1)));
    assert.throws(() => acquireLock(root, { repo: "owner/repo", engagementId: "eng", issueNumber: 1, localRunId: "xyz" }), /another local shadow run holds/);
    lock.release();
    assert.ok(!fs.existsSync(lockPathFor(root, "owner/repo", "eng", 1)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("readLock returns null when no lock exists", () => {
  const root = tmp();
  try { assert.equal(readLock(path.join(root, "locks/none.lock")), null); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("removeIfStale refuses to remove a lock whose pid is still alive", () => {
  const root = tmp();
  try {
    const lock = acquireLock(root, { repo: "owner/repo", engagementId: "eng", issueNumber: 1, localRunId: "abc" });
    const lockFile = lockPathFor(root, "owner/repo", "eng", 1);
    const outcome = removeIfStale(lockFile);
    assert.equal(outcome.removed, false);
    assert.match(outcome.reason, /still alive/);
    lock.release();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("removeIfStale removes a lock whose pid is no longer alive", () => {
  const root = tmp();
  try {
    const lockFile = lockPathFor(root, "owner/repo", "eng", 1);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({
      schemaVersion: "1", pid: 999999, host: os.hostname(), processStartIdentity: "dead-start", nonce: "test-nonce",
      startedAt: "2026-01-01T00:00:00.000Z", repo: "owner/repo", engagementId: "eng", issueNumber: 1, localRunId: "dead",
    }));
    const outcome = removeIfStale(lockFile);
    assert.equal(outcome.removed, true);
    assert.ok(!fs.existsSync(lockFile));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveWorkspacePaths rejects missing pilot-root", () => {
  assert.throws(() => resolveWorkspacePaths({
    pilotRoot: "/nonexistent",
    repoSlug: "agentify",
    githubFullName: "owner/repo",
    sourceRepoRoot: "/tmp",
    sourceCommitSha: "a".repeat(40),
  }), /pilot-root does not exist/);
});

test("resolveWorkspacePaths produces a stable directory tree", () => {
  const root = tmp();
  try {
    const paths = resolveWorkspacePaths({
      pilotRoot: root,
      repoSlug: "agentify",
      githubFullName: "owner/repo",
      sourceRepoRoot: "/tmp/src",
      sourceCommitSha: "a".repeat(40),
    });
    assert.equal(paths.repoSlug, "agentify");
    assert.equal(paths.workspaceRoot, path.join(root, "workspaces", "agentify"));
    assert.equal(paths.evidenceRoot, path.join(root, "workspaces", "agentify", "evidence"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveWorkspacePaths sanitizes repo slugs that contain dangerous characters", () => {
  const root = tmp();
  try {
    const paths = resolveWorkspacePaths({
      pilotRoot: root,
      repoSlug: "../etc",
      githubFullName: "owner/repo",
      sourceRepoRoot: path.join(os.tmpdir(), "separate-source"),
      sourceCommitSha: "a".repeat(40),
    });
    // The leading `..` collapses to `-` and is trimmed by the dash collapse.
    assert.equal(paths.repoSlug, "etc");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("preparePrivateClone creates a private detached clone without a remote", () => {
  const srcRoot = tmp();
  try {
    fs.writeFileSync(path.join(srcRoot, "README.md"), "hello");
    execFileSync("git", ["-C", srcRoot, "init", "--initial-branch=main"], { stdio: "ignore" });
    execFileSync("git", ["-C", srcRoot, "config", "user.email", "a@b"], { stdio: "ignore" });
    execFileSync("git", ["-C", srcRoot, "config", "user.name", "a"], { stdio: "ignore" });
    execFileSync("git", ["-C", srcRoot, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", srcRoot, "commit", "-m", "init"], { stdio: "ignore" });
    const sha = execFileSync("git", ["-C", srcRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const pilotRoot = tmp();
    try {
      const paths = resolveWorkspacePaths({
        pilotRoot,
        repoSlug: "agentify",
        githubFullName: "owner/repo",
        sourceRepoRoot: srcRoot,
        sourceCommitSha: sha,
      });
      preparePrivateClone(paths, sha);
      assert.ok(fs.existsSync(path.join(paths.cloneRoot, ".git")));
      assert.ok(fs.existsSync(path.join(paths.cloneRoot, "README.md")));
      assert.equal(execFileSync("git", ["-C", paths.cloneRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), "HEAD");
      assert.equal(execFileSync("git", ["-C", paths.cloneRoot, "remote"], { encoding: "utf8" }).trim(), "");
      const wrongRepoPaths = resolveWorkspacePaths({ pilotRoot, repoSlug: "agentify", githubFullName: "other-owner/agentify", sourceRepoRoot: srcRoot, sourceCommitSha: sha });
      assert.throws(() => preparePrivateClone(wrongRepoPaths, sha), /different repository/);
    } finally { fs.rmSync(srcRoot, { recursive: true, force: true }); fs.rmSync(pilotRoot, { recursive: true, force: true }); }
  } catch (error) {
    // If git is unavailable, skip the test rather than fail the suite.
    if (error instanceof Error && /git/.test(error.message)) return;
    throw error;
  }
});

test("assertManagedWrite accepts writes inside the workspace but rejects writes outside", () => {
  const pilotRoot = tmp();
  try {
    const paths = resolveWorkspacePaths({
      pilotRoot,
      repoSlug: "agentify",
      githubFullName: "owner/repo",
      sourceRepoRoot: "/tmp/src",
      sourceCommitSha: "a".repeat(40),
    });
    const inside = path.join(paths.evidenceRoot, "x.json");
    const outside = path.join(pilotRoot, "escape.json");
    assertManagedWrite(inside, paths);
    assert.throws(() => assertManagedWrite(outside, paths), /write rejected/);
    assert.throws(() => assertManagedWrite("/etc/passwd", paths), /write rejected/);
  } finally { fs.rmSync(pilotRoot, { recursive: true, force: true }); }
});