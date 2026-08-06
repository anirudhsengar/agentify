import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ValidationCommandResult,
  ValidationCommandSpec,
  ValidationPlan,
  ValidationResult,
} from "./contracts.ts";
import { TASK_LIFECYCLE_SCHEMA_VERSION } from "./contracts.ts";
import { assessValidationResult } from "./execution.ts";
import {
  digestTaskValue,
  normalizeTaskPath,
  redactTaskText,
  sha256TaskHex,
  sortedTaskStrings,
} from "./serialization.ts";
import { validateValidationPlan, validateValidationResult } from "./schema.ts";
import { TaskLifecycleError } from "./state-machine.ts";
import { diffPathInventory } from "./git-path-inventory.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 2_000;
const MAX_SNAPSHOT_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DENIED_EXECUTABLES = new Set([
  "az",
  "curl",
  "gcloud",
  "gh",
  "helm",
  "kubectl",
  "nc",
  "netcat",
  "scp",
  "ssh",
  "terraform",
  "wget",
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "merge-base",
  "rev-parse",
  "show",
  "status",
]);
const SECRET_ENVIRONMENT = /(?:^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:$|_)/i;

export interface ValidationRunnerOptions {
  cwd: string;
  now?: () => Date;
  max_output_bytes?: number;
  environment?: NodeJS.ProcessEnv;
}

interface ProcessOutcome {
  exit_code: number | null;
  timed_out: boolean;
  output: string;
}

interface ResolvedValidationInvocation {
  command: string;
  args: string[];
}

export function resolveValidationInvocation(argv: ReadonlyArray<string>): ResolvedValidationInvocation {
  if (argv.length === 0) {
    throw new TaskLifecycleError("invalid_input", "validation command argv cannot be empty");
  }
  const executable = path.basename(argv[0]).toLowerCase();
  if (process.platform === "win32" && (executable === "npm" || executable === "npm.cmd")) {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const stat = fs.lstatSync(npmCli);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TaskLifecycleError("invalid_input", "trusted npm CLI is unavailable beside the active Node runtime");
    }
    return { command: process.execPath, args: [npmCli, ...argv.slice(1)] };
  }
  return { command: argv[0], args: [...argv.slice(1)] };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: sanitizedTaskEnvironment(process.env),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new TaskLifecycleError(
      "invalid_input",
      `trusted Git inspection failed for ${args[0]}: ${redactTaskText(result.stderr || result.stdout || "unknown failure", 1_000)}`,
    );
  }
  return result.stdout.trim();
}

function gitBuffer(root: string, args: string[], maximum = MAX_SNAPSHOT_DIFF_BYTES): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: sanitizedTaskEnvironment(process.env),
    maxBuffer: maximum,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr ?? "");
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
    throw new TaskLifecycleError(
      "invalid_input",
      `trusted Git inspection failed for ${args[0]}: ${redactTaskText(stderr || stdout || "unknown failure", 1_000)}`,
    );
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

export function sanitizedTaskEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      key === "GITHUB_TOKEN"
      || key === "GH_TOKEN"
      || key === "AGENT_PAT"
      || key === "PI_API_KEY"
      || SECRET_ENVIRONMENT.test(key)
    ) {
      continue;
    }
    environment[key] = value;
  }
  environment.CI = "true";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export function assertValidationCommandSafe(spec: ValidationCommandSpec): void {
  if (spec.argv.some((argument) => argument.includes("\0") || /[\r\n]/.test(argument))) {
    throw new TaskLifecycleError("invalid_input", `validation command ${spec.command_id} contains an unsafe argument`);
  }
  const executable = path.basename(spec.argv[0]).toLowerCase();
  if (DENIED_EXECUTABLES.has(executable)) {
    throw new TaskLifecycleError(
      "invalid_input",
      `validation command ${spec.command_id} uses forbidden executable ${executable}`,
    );
  }
  if (executable === "git") {
    const subcommand = spec.argv[1]?.toLowerCase() ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new TaskLifecycleError(
        "invalid_input",
        `validation command ${spec.command_id} uses mutating or unsupported git subcommand ${subcommand || "(missing)"}`,
      );
    }
  }
  if (
    (executable === "npm" && spec.argv[1] === "publish")
    || (executable === "pnpm" && spec.argv[1] === "publish")
    || (executable === "yarn" && spec.argv[1] === "publish")
    || (executable === "docker" && ["push", "login", "deploy"].includes(spec.argv[1] ?? ""))
  ) {
    throw new TaskLifecycleError("invalid_input", `validation command ${spec.command_id} may publish or deploy`);
  }
}

export function resolveValidationCommandCwd(root: string, relative: string): string {
  const normalized = relative === "." ? "." : normalizeTaskPath(relative, "validation cwd");
  const absolute = path.resolve(root, normalized);
  const relation = path.relative(root, absolute);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new TaskLifecycleError("invalid_input", "validation cwd escapes the repository");
  }
  const actual = fs.realpathSync(absolute);
  const actualRelation = path.relative(fs.realpathSync(root), actual);
  if (actualRelation.startsWith("..") || path.isAbsolute(actualRelation)) {
    throw new TaskLifecycleError("invalid_input", "validation cwd resolves outside the repository");
  }
  return actual;
}

function boundedAppend(current: Buffer[], chunk: Buffer, state: { bytes: number }, maximum: number): void {
  if (state.bytes >= maximum) return;
  const remaining = maximum - state.bytes;
  const selected = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  current.push(selected);
  state.bytes += selected.length;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.killed) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to the direct child when process-group termination is unavailable.
    }
  }
  child.kill("SIGTERM");
}

function forceTerminate(child: ReturnType<typeof spawn>): void {
  if (child.killed) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct child when process-group termination is unavailable.
    }
  }
  child.kill("SIGKILL");
}

async function runCommand(input: {
  spec: ValidationCommandSpec;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeout_ms: number;
  max_output_bytes: number;
}): Promise<ProcessOutcome> {
  assertValidationCommandSafe(input.spec);
  return await new Promise<ProcessOutcome>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const bytes = { bytes: 0 };
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const invocation = resolveValidationInvocation(input.spec.argv);
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      env: input.environment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => boundedAppend(chunks, chunk, bytes, input.max_output_bytes));
    child.stderr?.on("data", (chunk: Buffer) => boundedAppend(chunks, chunk, bytes, input.max_output_bytes));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate(child);
      setTimeout(() => forceTerminate(child), TERMINATION_GRACE_MS).unref();
    }, input.timeout_ms);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        exit_code: typeof code === "number" && code >= 0 ? code : null,
        timed_out: timedOut,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

export interface RepositorySnapshotEvidence {
  head: string;
  tree_digest: string;
  status: string[];
}

function untrackedSnapshot(root: string, status: ReadonlyArray<string>): Array<{ path: string; size: number; sha256: string }> {
  return status
    .filter((line) => line.startsWith("?? "))
    .map((line) => normalizeTaskPath(line.slice(3), "untracked snapshot path"))
    .sort((left, right) => left.localeCompare(right))
    .map((relative) => {
      const absolute = path.resolve(root, relative);
      const relation = path.relative(root, absolute);
      if (relation.startsWith("..") || path.isAbsolute(relation)) {
        throw new TaskLifecycleError("invalid_input", `untracked path ${relative} escapes the repository`);
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_UNTRACKED_SNAPSHOT_BYTES) {
        throw new TaskLifecycleError(
          "invalid_input",
          `untracked path ${relative} is a symlink, non-regular file, or exceeds the snapshot bound`,
        );
      }
      return { path: relative, size: stat.size, sha256: sha256TaskHex(fs.readFileSync(absolute)) };
    });
}

export function captureRepositorySnapshot(rootInput: string): RepositorySnapshotEvidence {
  const root = fs.realpathSync(path.resolve(rootInput));
  const head = git(root, ["rev-parse", "HEAD"]);
  const statusPayload = gitBuffer(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const status = statusPayload.length > 0
    ? statusPayload.toString("utf8").split("\0").filter(Boolean).sort()
    : [];
  const trackedDiff = gitBuffer(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const stagedDiff = gitBuffer(root, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const untracked = untrackedSnapshot(root, status);
  return {
    head,
    status,
    tree_digest: digestTaskValue({
      head,
      status,
      tracked_diff_sha256: sha256TaskHex(trackedDiff),
      staged_diff_sha256: sha256TaskHex(stagedDiff),
      untracked,
    }),
  };
}

function changedFiles(root: string, base: string, head: string): string[] {
  return diffPathInventory(root, `${base}...${head}`);
}

function untrackedFiles(status: ReadonlyArray<string>): string[] {
  return status
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3))
    .filter(Boolean)
    .sort();
}

export async function runValidationPlan(
  planInput: ValidationPlan,
  options: ValidationRunnerOptions,
): Promise<ValidationResult> {
  const plan = validateValidationPlan(planInput);
  const root = fs.realpathSync(path.resolve(options.cwd));
  const now = options.now ?? (() => new Date());
  const maximumOutput = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 1 || maximumOutput > 1024 * 1024) {
    throw new TaskLifecycleError("invalid_input", "validation output cap must be between 1 byte and 1 MiB");
  }
  const branch = git(root, ["branch", "--show-current"]);
  const initial = captureRepositorySnapshot(root);
  if (branch !== plan.expected_branch) {
    throw new TaskLifecycleError("invalid_input", `validation branch is ${branch}, expected ${plan.expected_branch}`);
  }
  if (initial.head !== plan.expected_builder_commit) {
    throw new TaskLifecycleError("invalid_input", "validation HEAD does not match the expected builder commit");
  }
  if (initial.status.length > 0) {
    throw new TaskLifecycleError(
      "invalid_input",
      "validation requires a clean worktree with no post-builder mutation or untracked files",
    );
  }
  git(root, ["rev-parse", `${plan.expected_base_commit}^{commit}`]);
  const ancestry = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", plan.expected_base_commit, plan.expected_builder_commit],
    { env: sanitizedTaskEnvironment(options.environment ?? process.env) },
  );
  if (ancestry.status !== 0) {
    throw new TaskLifecycleError(
      "invalid_input",
      "validation builder commit is not descended from the expected base commit",
    );
  }
  const startedAt = now().toISOString();
  const commandResults: ValidationCommandResult[] = [];
  const environment = sanitizedTaskEnvironment(options.environment ?? process.env);

  for (const spec of plan.commands) {
    const remaining = Date.parse(plan.deadline_at) - now().getTime();
    if (remaining <= 0) break;
    const commandStarted = now().toISOString();
    const before = captureRepositorySnapshot(root);
    const outcome = await runCommand({
      spec,
      cwd: resolveValidationCommandCwd(root, spec.cwd),
      environment,
      timeout_ms: Math.max(1, Math.min(spec.timeout_ms, remaining)),
      max_output_bytes: maximumOutput,
    });
    const after = captureRepositorySnapshot(root);
    const redacted = redactTaskText(outcome.output, maximumOutput);
    commandResults.push({
      command_id: spec.command_id,
      started_at: commandStarted,
      completed_at: now().toISOString(),
      exit_code: outcome.exit_code,
      timed_out: outcome.timed_out,
      output_digest: sha256TaskHex(redacted),
      redacted_summary: "Command output omitted; bounded redacted SHA-256 digest retained.",
      head_before: before.head,
      head_after: after.head,
      tree_digest_before: before.tree_digest,
      tree_digest_after: after.tree_digest,
    });
    if (outcome.timed_out) break;
  }

  const final = captureRepositorySnapshot(root);
  const preliminary: ValidationResult = {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: plan.task_id,
    expected_base_commit: plan.expected_base_commit,
    expected_branch: plan.expected_branch,
    builder_commit: plan.expected_builder_commit,
    final_commit: final.head,
    changed_files: changedFiles(root, plan.expected_base_commit, final.head),
    untracked_files: untrackedFiles(final.status),
    commands: commandResults,
    policy_verdict: "passed",
    policy_reasons: [],
    started_at: startedAt,
    completed_at: now().toISOString(),
    final_tree_digest: final.tree_digest,
  };
  const assessment = assessValidationResult(plan, preliminary, preliminary.completed_at);
  const result: ValidationResult = {
    ...preliminary,
    policy_verdict: assessment.passed ? "passed" : "failed",
    policy_reasons: sortedTaskStrings(assessment.reasons).slice(0, 256),
  };
  return validateValidationResult(result);
}
