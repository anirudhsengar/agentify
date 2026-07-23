import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  captureGitSnapshot,
  findUnsafeChanges,
  resolveManagedStateRelative,
  verifyGitSafety,
} from "../../src/core/shadow/git-safety.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-shadow-safety-"));
}

function git(args: ReadonlyArray<string>, cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const root = tmp();
  fs.writeFileSync(path.join(root, "README.md"), "hello");
  git(["init", "--initial-branch=main"], root);
  git(["config", "user.email", "a@b"], root);
  git(["config", "user.name", "a"], root);
  git(["add", "."], root);
  git(["commit", "-m", "init"], root);
  return root;
}

test("captureGitSnapshot records HEAD, branch, refs, and a stable inventory digest", async () => {
  const root = makeRepo();
  try {
    const snap = await captureGitSnapshot(root);
    assert.match(snap.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(snap.branch, "main");
    assert.equal(snap.detached, false);
    assert.match(snap.inventoryDigest, /^sha256:/);
    assert.match(snap.porcelain, /^$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("verifyGitSafety accepts an unchanged tree", async () => {
  const root = makeRepo();
  try {
    const before = await captureGitSnapshot(root);
    const result = await verifyGitSafety(before, root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("verifyGitSafety detects HEAD changes", async () => {
  const root = makeRepo();
  try {
    const before = await captureGitSnapshot(root);
    fs.writeFileSync(path.join(root, "NEW.md"), "new");
    git(["add", "NEW.md"], root);
    git(["commit", "-m", "another"], root);
    const result = await verifyGitSafety(before, root);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.startsWith("HEAD changed")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("findUnsafeChanges only flags changes outside the managed state root", async () => {
  const root = makeRepo();
  try {
    // Pre-create the managed state dir so the snapshot recognises it.
    fs.mkdirSync(path.join(root, ".pi/agentify"), { recursive: true });
    const snap = await captureGitSnapshot(root);
    assert.equal(snap.managedStateRelative, ".pi/agentify");
    fs.writeFileSync(path.join(root, ".pi/agentify/x.json"), "x");
    fs.writeFileSync(path.join(root, "untracked.txt"), "u");
    const porcelain = git(["status", "--porcelain=v1", "--untracked-files=all"], root);
    const unsafe = findUnsafeChanges(snap, porcelain);
    assert.ok(unsafe.includes("untracked.txt"));
    assert.ok(!unsafe.includes(".pi/agentify/x.json"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveManagedStateRelative rejects a symlink managed state path", () => {
  const root = makeRepo();
  try {
    const target = path.join(root, ".agents/agentify");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.unlinkSync(target); } catch { /* not present */ }
    fs.symlinkSync(os.tmpdir(), target);
    assert.throws(() => resolveManagedStateRelative(root), /symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("GitSafety snapshot has a stable digest when the tree is unchanged", async () => {
  const root = makeRepo();
  try {
    const a = await captureGitSnapshot(root);
    const b = await captureGitSnapshot(root);
    assert.equal(a.inventoryDigest, b.inventoryDigest);
    assert.equal(a.commitSha, b.commitSha);
    assert.equal(a.remoteRefs, b.remoteRefs);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});