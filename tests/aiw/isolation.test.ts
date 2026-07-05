// tests/aiw/isolation.test.ts — worktree + port allocation tests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createWorktree,
  getBranchNameForAiw,
  getPortsForAiw,
  getWorktreePathForAiw,
  isGitRepo,
  removeWorktree,
  resolveIsolation,
} from "../../src/core/aiw/isolation.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${prefix}-`));
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init", "-q"], { cwd: dir });
}

async function testGetPortsDeterministic(): Promise<void> {
  const a = getPortsForAiw("a".repeat(16));
  const b = getPortsForAiw("b".repeat(16));
  const a2 = getPortsForAiw("a".repeat(16));
  // Same id → same ports
  assert.deepEqual(a, a2);
  // Different ids → different ports (with high probability; for "a" vs "b" they differ)
  assert.notEqual(a.backend, b.backend);
  // Both within the 15-slot pool
  assert.ok(a.backend >= 9100 && a.backend < 9115);
  assert.ok(a.frontend >= 9200 && a.frontend < 9215);
}

async function testGetBranchAndPath(): Promise<void> {
  assert.equal(getBranchNameForAiw("c".repeat(16)), "aiw/" + "c".repeat(16));
  const worktree = getWorktreePathForAiw("/tmp/repo", "d".repeat(16));
  assert.equal(worktree, "/tmp/repo/trees/" + "d".repeat(16));
}

async function testIsGitRepo(): Promise<void> {
  const dir = tempDir("iso-git-");
  assert.equal(isGitRepo(dir), false);
  initGitRepo(dir);
  assert.equal(isGitRepo(dir), true);
}

async function testWorktreeCreation(): Promise<void> {
  const repo = tempDir("iso-worktree-");
  initGitRepo(repo);
  const aiwId = "f".repeat(16);
  const wt = createWorktree(repo, aiwId);
  assert.ok(fs.existsSync(wt));
  assert.ok(fs.existsSync(path.join(wt, "README.md")));
  // The new worktree is on its own branch.
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: wt,
    encoding: "utf-8",
  }).trim();
  assert.equal(branch, `aiw/${aiwId}`);
  // Idempotent: re-creating returns the same path without error.
  const wt2 = createWorktree(repo, aiwId);
  assert.equal(wt2, wt);
  // Cleanup.
  removeWorktree(repo, aiwId, { deleteBranch: true });
  assert.equal(fs.existsSync(wt), false);
  // Branch is gone.
  const branches = execFileSync("git", ["branch", "--list"], {
    cwd: repo,
    encoding: "utf-8",
  });
  assert.equal(branches.includes(`aiw/${aiwId}`), false);
}

async function testResolveIsolationGit(): Promise<void> {
  const repo = tempDir("iso-resolve-");
  initGitRepo(repo);
  const aiwId = "e".repeat(16);
  const result = resolveIsolation(repo, aiwId);
  assert.equal(result.created, true);
  assert.equal(result.worktreePath, path.join(repo, "trees", aiwId));
  assert.equal(result.branchName, `aiw/${aiwId}`);
  assert.ok(fs.existsSync(result.worktreePath));
  removeWorktree(repo, aiwId, { deleteBranch: true });
}

async function testResolveIsolationNoGit(): Promise<void> {
  const dir = tempDir("iso-nogit-");
  const aiwId = "8".repeat(16);
  const result = resolveIsolation(dir, aiwId);
  assert.equal(result.created, false);
  assert.equal(result.worktreePath, dir);
  assert.equal(result.branchName, `aiw/${aiwId}`);
  // No tree created
  assert.equal(fs.existsSync(path.join(dir, "trees", aiwId)), false);
}

async function testResolveIsolationNoWorktree(): Promise<void> {
  const repo = tempDir("iso-nowork-");
  initGitRepo(repo);
  const aiwId = "7".repeat(16);
  const result = resolveIsolation(repo, aiwId, { noWorktree: true });
  assert.equal(result.created, false);
  assert.equal(result.worktreePath, repo);
  // No tree created.
  assert.equal(fs.existsSync(path.join(repo, "trees", aiwId)), false);
}

async function testPortPoolBounds(): Promise<void> {
  // Try a range of ids — all should produce ports in [9100, 9115) and [9200, 9215).
  for (let i = 0; i < 100; i++) {
    const id = i.toString(16).padStart(16, "0");
    const ports = getPortsForAiw(id);
    assert.ok(ports.backend >= 9100 && ports.backend < 9115, `backend ${ports.backend} out of range`);
    assert.ok(ports.frontend >= 9200 && ports.frontend < 9215, `frontend ${ports.frontend} out of range`);
  }
}

await testGetPortsDeterministic();
await testGetBranchAndPath();
await testIsGitRepo();
await testWorktreeCreation();
await testResolveIsolationGit();
await testResolveIsolationNoGit();
await testResolveIsolationNoWorktree();
await testPortPoolBounds();

console.log("aiw isolation tests passed.");