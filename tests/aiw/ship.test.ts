// tests/aiw/ship.test.ts — ship phase tests.
//
// Covers:
//   - Ship phase calls git push, then gh pr create, then gh pr merge
//   - Ship phase handles "branch already has a PR" by reusing it
//   - Ship phase records the PR URL in the state
//   - Ship phase fails gracefully when gh is missing
//   - Ship phase is skipped (not errored) when the gate denies
//   - Force override proceeds even with denied gate

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aiwStatePaths } from "../../src/core/aiw/paths.ts";
import {
  makeQueuedAiwState,
  WorkflowName,
  PhaseName,
  type ChangeType,
} from "../../src/core/aiw/state.ts";
import {
  readAiwState,
  writeAiwState,
} from "../../src/core/aiw/paths.ts";
import {
  finishPhase,
  startPhase,
  skipPhase,
  updatePhase,
} from "../../src/core/aiw/state.ts";
import {
  runShipPhase,
  type ExecLayer,
} from "../../src/core/aiw/ship.ts";
import { recordRun } from "../../src/core/aiw/kpis.ts";
import { aiwPaths } from "../../src/core/aiw/paths.ts";
import { nullAiwLogger } from "../../src/core/aiw/logging.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-ship-"));
}

function makeState(changeType: ChangeType, workflow: WorkflowName = WorkflowName.PlanBuildReviewShip): ReturnType<typeof makeQueuedAiwState> {
  const aiwId = "abcdef".padEnd(16, "0").slice(0, 16);
  return makeQueuedAiwState({
    aiwId,
    workflow,
    prompt: "ship it",
    workingDir: "/tmp/repo",
    branchName: `aiw/${aiwId}`,
    worktreePath: `/tmp/trees/${aiwId}`,
    backendPort: 9100,
    frontendPort: 9200,
    worktreeCreated: false,
    source: "test",
    changeType,
  });
}

/** A stub exec that records calls and returns canned responses. */
function makeStubExec(opts: {
  hasGh?: boolean;
  hasGit?: boolean;
  existingPr?: string;
  prCreate?: (args: string[]) => string;
  pushFails?: boolean;
  mergeFails?: boolean;
} = {}): ExecLayer & { calls: Array<{ file: string; args: string[]; cwd: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  return {
    calls,
    async execFile(file, args, options) {
      calls.push({ file, args, cwd: options.cwd });
      if (file === "git" && args[0] === "push") {
        if (opts.pushFails) {
          throw new Error("permission denied (publickey)");
        }
        return { stdout: "", stderr: "" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: opts.existingPr ?? "", stderr: "" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "create") {
        const url = opts.prCreate ? opts.prCreate(args) : "https://github.com/me/repo/pull/42";
        return { stdout: `Creating PR...\n${url}\n`, stderr: "" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "merge") {
        if (opts.mergeFails) {
          throw new Error("PR is in clean status, but branch protection requires 1 approving review");
        }
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    async which(binary) {
      if (binary === "gh") return opts.hasGh ?? true;
      if (binary === "git") return opts.hasGit ?? true;
      return false;
    },
  };
}

async function testShipCallsGitPushAndGhPrCreateAndMerge(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "abcdef".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("chore");
  // Pre-earn the AFK gate for chores.
  for (let i = 0; i < 5; i++) {
    recordRun(aiwPaths(configDir), {
      aiwId: `prereq${i}`,
      changeType: "chore",
      at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
  writeAiwState(paths, state);
  const exec = makeStubExec({ prCreate: () => "https://github.com/me/repo/pull/42" });

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "chore",
    logger: nullAiwLogger(),
    exec,
  });

  assert.equal(result.status, "shipped");
  assert.equal(result.prUrl, "https://github.com/me/repo/pull/42");

  // Verify call order: git push, gh pr list, gh pr merge.
  // (The stub returns no existing PR so the create branch is taken.)
  const fileArgs = exec.calls.map((c) => `${c.file} ${c.args[0]} ${c.args[1] ?? ""}`);
  assert.ok(fileArgs.some((s) => s.startsWith("git push")));
  assert.ok(fileArgs.some((s) => s.startsWith("gh pr list")));
  assert.ok(fileArgs.some((s) => s.startsWith("gh pr create")));
  assert.ok(fileArgs.some((s) => s.startsWith("gh pr merge")));

  // State should reflect a successful ship.
  const final = readAiwState(paths);
  assert.ok(final);
  const shipPhase = final!.phases.find((p) => p.phase === PhaseName.Ship);
  assert.equal(shipPhase?.status, "done");
  assert.equal(final!.gate_passed, true);
}

async function testShipReusesExistingPr(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "1".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("chore");
  for (let i = 0; i < 5; i++) {
    recordRun(aiwPaths(configDir), {
      aiwId: `prereq${i}`,
      changeType: "chore",
      at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
  writeAiwState(paths, state);
  const exec = makeStubExec({ existingPr: "https://github.com/me/repo/pull/99" });

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "chore",
    logger: nullAiwLogger(),
    exec,
  });

  assert.equal(result.status, "shipped");
  assert.equal(result.prUrl, "https://github.com/me/repo/pull/99");
  // No `gh pr create` should have been called.
  const created = exec.calls.find((c) => c.file === "gh" && c.args[0] === "pr" && c.args[1] === "create");
  assert.equal(created, undefined);
}

async function testShipFailsWhenGhMissing(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "2".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("chore");
  // Pre-earn the gate so the gh-missing path is reached.
  for (let i = 0; i < 5; i++) {
    recordRun(aiwPaths(configDir), {
      aiwId: `prereq${i}`,
      changeType: "chore",
      at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
  writeAiwState(paths, state);
  const exec = makeStubExec({ hasGh: false });

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "chore",
    logger: nullAiwLogger(),
    exec,
  });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /gh not found/);
}

async function testShipSkippedWhenGateDenies(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "3".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("feature"); // no prior runs → gate denies
  writeAiwState(paths, state);
  const exec = makeStubExec();

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "feature",
    logger: nullAiwLogger(),
    exec,
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.gateResult.allowed, false);
  // No git/gh calls should have been made.
  assert.equal(exec.calls.length, 0);
  // State should be marked skipped.
  const final = readAiwState(paths);
  const shipPhase = final!.phases.find((p) => p.phase === PhaseName.Ship);
  assert.equal(shipPhase?.status, "skipped");
  assert.match(shipPhase?.error_message ?? "", /AFK/);
  assert.equal(final!.gate_passed, false);
}

async function testShipForceOverrideProceedsEvenWithDeniedGate(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "4".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("feature"); // no prior runs → gate denies
  writeAiwState(paths, state);
  const exec = makeStubExec();

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "feature",
    force: true,
    logger: nullAiwLogger(),
    exec,
  });
  assert.equal(result.status, "shipped");
  // git push was called.
  const pushed = exec.calls.find((c) => c.file === "git" && c.args[0] === "push");
  assert.ok(pushed);
  // gh pr merge was called.
  const merged = exec.calls.find((c) => c.file === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
  assert.ok(merged);
}

async function testShipRecordsPrUrlEvenIfMergeFails(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "5".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("chore");
  for (let i = 0; i < 5; i++) {
    recordRun(aiwPaths(configDir), {
      aiwId: `prereq${i}`,
      changeType: "chore",
      at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
  writeAiwState(paths, state);
  const exec = makeStubExec({ mergeFails: true });

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "chore",
    logger: nullAiwLogger(),
    exec,
  });
  assert.equal(result.status, "error");
  assert.equal(result.prUrl, "https://github.com/me/repo/pull/42");
  assert.match(result.errorMessage ?? "", /requires 1 approving review/);
  const final = readAiwState(paths);
  const shipPhase = final!.phases.find((p) => p.phase === PhaseName.Ship);
  assert.equal(shipPhase?.status, "error");
  assert.match(shipPhase?.error_message ?? "", /PR is open at/);
}

async function testShipPushFailure(): Promise<void> {
  const configDir = tempConfigDir();
  const aiwId = "6".padEnd(16, "0").slice(0, 16);
  const paths = aiwStatePaths(configDir, aiwId);
  const state = makeState("chore");
  for (let i = 0; i < 5; i++) {
    recordRun(aiwPaths(configDir), {
      aiwId: `prereq${i}`,
      changeType: "chore",
      at: new Date(Date.now() - (5 - i) * 1000).toISOString(),
      attempts: 1,
      planLines: null,
      diffStat: null,
      oneAttempt: true,
    });
  }
  writeAiwState(paths, state);
  const exec = makeStubExec({ pushFails: true });

  const result = await runShipPhase({
    paths,
    state,
    cwd: state.worktree_path,
    workingDir: state.working_dir,
    changeType: "chore",
    logger: nullAiwLogger(),
    exec,
  });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /git push failed/);
}

await testShipCallsGitPushAndGhPrCreateAndMerge();
await testShipReusesExistingPr();
await testShipFailsWhenGhMissing();
await testShipSkippedWhenGateDenies();
await testShipForceOverrideProceedsEvenWithDeniedGate();
await testShipRecordsPrUrlEvenIfMergeFails();
await testShipPushFailure();

console.log("aiw ship tests passed.");