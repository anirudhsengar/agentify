import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TASK_LIFECYCLE_SCHEMA_VERSION,
  type BuilderModelSubmission,
  type BuilderRequest,
  type BuilderResult,
} from "./contracts.ts";
import { redactTaskText } from "./serialization.ts";
import { validateBuilderRequest, validateBuilderResult } from "./schema.ts";
import { sanitizedTaskEnvironment } from "./validation-runner.ts";
import { TaskLifecycleError } from "./state-machine.ts";
import { diffPathInventory } from "./git-path-inventory.ts";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: sanitizedTaskEnvironment(process.env),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new TaskLifecycleError(
      "invalid_input",
      `trusted builder observation failed for git ${args[0]}: ${redactTaskText(result.stderr || result.stdout || "unknown failure", 1_000)}`,
    );
  }
  return result.stdout.trim();
}

function nulEntries(root: string, args: string[]): string[] {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: sanitizedTaskEnvironment(process.env),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new TaskLifecycleError("invalid_input", `trusted builder observation failed for git ${args[0]}`);
  }
  const payload = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  return payload.split("\0").filter(Boolean);
}

function lines(value: string): string[] {
  return value ? value.split("\n").map((entry) => entry.trim()).filter(Boolean) : [];
}

export function observeBuilderResult(input: {
  cwd: string;
  request: BuilderRequest;
  submission: BuilderModelSubmission;
  builder_agent_id: string;
  started_at: string;
  completed_at: string;
}): BuilderResult {
  const request = validateBuilderRequest(input.request);
  const root = fs.realpathSync(path.resolve(input.cwd));
  const branch = git(root, ["branch", "--show-current"]);
  if (branch !== request.branch) {
    throw new TaskLifecycleError("invalid_input", `builder observation found branch ${branch}, expected ${request.branch}`);
  }
  const finalCommit = git(root, ["rev-parse", "HEAD"]);
  const ancestry = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", request.expected_base_commit, finalCommit], {
    env: sanitizedTaskEnvironment(process.env),
  });
  if (ancestry.status !== 0) {
    throw new TaskLifecycleError("invalid_input", "builder commit is not descended from the expected base commit");
  }
  const commits = lines(git(root, ["rev-list", "--reverse", `${request.expected_base_commit}..${finalCommit}`]));
  const changed = diffPathInventory(root, `${request.expected_base_commit}...${finalCommit}`);
  const status = nulEntries(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const untracked = status
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .sort();
  const result: BuilderResult = {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: request.task_id,
    issue_number: request.issue_number,
    expected_base_commit: request.expected_base_commit,
    branch: request.branch,
    builder_agent_id: input.builder_agent_id,
    started_at: input.started_at,
    completed_at: input.completed_at,
    commit_shas: commits,
    final_commit: finalCommit,
    changed_files: changed,
    untracked_files: untracked,
    summary: redactTaskText(input.submission.summary, 8_000),
    attempts: input.submission.attempts.map((attempt) => ({ ...attempt })),
    cost_usd: input.submission.cost_usd,
    runtime_ms: input.submission.runtime_ms,
  };
  return validateBuilderResult(result);
}
