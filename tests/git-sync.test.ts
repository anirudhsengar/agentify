import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectGitSyncStatus, pullLatestBranch } from "../src/core/git-sync.ts";

function runGit(cwd: string, args: ReadonlyArray<string>): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-git-sync-"));
try {
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  const local = path.join(root, "local");
  runGit(root, ["init", "--bare", remote]);
  fs.mkdirSync(source);
  runGit(source, ["init"]);
  runGit(source, ["config", "user.email", "agentify@example.test"]);
  runGit(source, ["config", "user.name", "Agentify Test"]);
  fs.writeFileSync(path.join(source, "README.md"), "first\n");
  runGit(source, ["add", "README.md"]);
  runGit(source, ["commit", "-m", "first"]);
  runGit(source, ["branch", "-M", "master"]);
  runGit(source, ["remote", "add", "origin", remote]);
  runGit(source, ["push", "-u", "origin", "master"]);
  runGit(root, ["clone", remote, local]);

  fs.writeFileSync(path.join(source, "README.md"), "second\n");
  runGit(source, ["add", "README.md"]);
  runGit(source, ["commit", "-m", "second"]);
  runGit(source, ["push"]);

  const behind = inspectGitSyncStatus(local);
  assert.equal(behind.kind, "behind");
  assert.equal(behind.behind, 1);
  assert.equal(behind.ahead, 0);

  assert.equal(pullLatestBranch(local).ok, true);
  assert.equal(inspectGitSyncStatus(local).kind, "up_to_date");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("git sync tests passed");
