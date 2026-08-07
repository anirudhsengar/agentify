import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  BuilderModelSubmission,
  BuilderRequest,
  ValidationCommandSpec,
} from "./contracts.ts";
import {
  normalizeTaskPath,
  pathWithinTaskScope,
  redactTaskText,
} from "./serialization.ts";
import { validateBuilderModelSubmission } from "./schema.ts";
import { TaskLifecycleError } from "./state-machine.ts";
import {
  assertValidationCommandSafe,
  captureRepositorySnapshot,
  resolveValidationCommandCwd,
  sanitizedTaskEnvironment,
} from "./validation-runner.ts";

const MAX_TASK_FILE_BYTES = 512 * 1024;
const MAX_REPLACE_TEXT_BYTES = 128 * 1024;
const MAX_CHECK_OUTPUT_BYTES = 16 * 1024;
const MAX_SUBMITTED_FILE_CHANGES = 64;

type BuilderSubmittedChange =
  | { action: "write"; path: string; content: string }
  | { action: "delete"; path: string; expected_sha256: string };

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realResolveThroughExistingAncestor(target: string): string {
  const suffix: string[] = [];
  let current = target;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) return path.join(fs.realpathSync(current), ...suffix.reverse());
    suffix.push(path.basename(current));
    current = path.dirname(current);
  }
  return target;
}

function taskPath(request: BuilderRequest, root: string, value: string): { relative: string; absolute: string } {
  const relative = normalizeTaskPath(value, "builder tool path");
  if (!request.allowed_paths.some((scope) => pathWithinTaskScope(relative, scope))) {
    throw new TaskLifecycleError("invalid_input", `builder tool path ${relative} is outside the approved plan scope`);
  }
  if (request.protected_paths.some((scope) => pathWithinTaskScope(relative, scope))) {
    throw new TaskLifecycleError("invalid_input", `builder tool path ${relative} is protected`);
  }
  const repositoryRoot = fs.realpathSync(root);
  const absolute = path.resolve(repositoryRoot, relative);
  const real = realResolveThroughExistingAncestor(absolute);
  if (!isInside(absolute, repositoryRoot) || !isInside(real, repositoryRoot)) {
    throw new TaskLifecycleError("invalid_input", `builder tool path ${relative} escapes the repository`);
  }
  let ancestor = repositoryRoot;
  for (const segment of relative.split("/")) {
    ancestor = path.join(ancestor, segment);
    if (!fs.existsSync(ancestor)) break;
    const stat = fs.lstatSync(ancestor);
    if (stat.isSymbolicLink()) {
      throw new TaskLifecycleError("invalid_input", `builder tool path ${relative} traverses a symlink`);
    }
  }
  return { relative, absolute };
}

function writeAtomic(filePath: string, content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TASK_FILE_BYTES) {
    throw new TaskLifecycleError("invalid_input", `builder file exceeds ${MAX_TASK_FILE_BYTES} bytes`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.agentify-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function gitSnapshot(root: string): string {
  return captureRepositorySnapshot(root).tree_digest;
}

export interface BuilderToolSet {
  tools: ToolDefinition[];
  getSubmission(): BuilderModelSubmission | null;
  checkResults(): ReadonlyArray<{
    command_id: string;
    exit_code: number | null;
    timed_out: boolean;
    output_digest: string;
    summary: string;
  }>;
}

export function createBuilderTools(input: {
  cwd: string;
  request: BuilderRequest;
  commands: ReadonlyArray<ValidationCommandSpec>;
}): BuilderToolSet {
  const root = fs.realpathSync(path.resolve(input.cwd));
  const commandById = new Map(input.commands.map((command) => [command.command_id, command]));
  let submission: BuilderModelSubmission | null = null;
  let hasLiveMutation = false;
  const checks: Array<{
    command_id: string;
    exit_code: number | null;
    timed_out: boolean;
    output_digest: string;
    summary: string;
  }> = [];

  const writeTool = defineTool({
    name: "write_task_file",
    label: "Write approved task file",
    description: "Atomically write one UTF-8 file inside the approved application scope. Protected paths, symlinks, traversal, and oversized content are rejected by trusted code. Use this iteratively; it does not end the session.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1_024 }),
      content: Type.String({ maxLength: MAX_TASK_FILE_BYTES }),
    }, { additionalProperties: false }),
    async execute(_id: string, params: { path: string; content: string }) {
      const target = taskPath(input.request, root, params.path);
      writeAtomic(target.absolute, params.content);
      hasLiveMutation = true;
      return { content: [{ type: "text", text: `Wrote ${target.relative}.` }], details: { path: target.relative } };
    },
  });

  const replaceTool = defineTool({
    name: "replace_task_text",
    label: "Replace approved task text",
    description: "Replace an exact bounded UTF-8 string in one approved regular file. The expected replacement count is enforced. Use this iteratively; it does not end the session.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1_024 }),
      old_text: Type.String({ minLength: 1, maxLength: MAX_REPLACE_TEXT_BYTES }),
      new_text: Type.String({ maxLength: MAX_REPLACE_TEXT_BYTES }),
      expected_replacements: Type.Integer({ minimum: 1, maximum: 100 }),
    }, { additionalProperties: false }),
    async execute(_id: string, params: { path: string; old_text: string; new_text: string; expected_replacements: number }) {
      const target = taskPath(input.request, root, params.path);
      const stat = fs.lstatSync(target.absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TASK_FILE_BYTES) {
        throw new TaskLifecycleError("invalid_input", `${target.relative} is not one bounded regular file`);
      }
      const original = fs.readFileSync(target.absolute, "utf8");
      const count = original.split(params.old_text).length - 1;
      if (count !== params.expected_replacements) {
        throw new TaskLifecycleError(
          "invalid_input",
          `${target.relative} contains ${count} replacements, expected ${params.expected_replacements}`,
        );
      }
      writeAtomic(target.absolute, original.split(params.old_text).join(params.new_text));
      hasLiveMutation = true;
      return { content: [{ type: "text", text: `Replaced text in ${target.relative}.` }], details: { path: target.relative, replacements: count } };
    },
  });

  const deleteTool = defineTool({
    name: "delete_task_file",
    label: "Delete approved task file",
    description: "Delete one approved regular file only when its current SHA-256 equals the supplied digest. Use this iteratively; it does not end the session.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1_024 }),
      expected_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    }, { additionalProperties: false }),
    async execute(_id: string, params: { path: string; expected_sha256: string }) {
      const target = taskPath(input.request, root, params.path);
      const stat = fs.lstatSync(target.absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TASK_FILE_BYTES) {
        throw new TaskLifecycleError("invalid_input", `${target.relative} is not one bounded regular file`);
      }
      const bytes = fs.readFileSync(target.absolute);
      if (sha256(bytes) !== params.expected_sha256) {
        throw new TaskLifecycleError("invalid_input", `${target.relative} changed since deletion was proposed`);
      }
      fs.unlinkSync(target.absolute);
      hasLiveMutation = true;
      return { content: [{ type: "text", text: `Deleted ${target.relative}.` }], details: { path: target.relative } };
    },
  });

  const checkTool = defineTool({
    name: "run_task_check",
    label: "Run admitted task check",
    description: "Execute one exact argv-vector check admitted by repository policy, as an advisory self-check. Trusted code independently reruns the authoritative check after the session ends. Arbitrary commands, shells, GitHub tools, network tools, and repository mutation are rejected.",
    parameters: Type.Object({
      command_id: Type.String({ minLength: 1, maxLength: 256 }),
    }, { additionalProperties: false }),
    async execute(_id: string, params: { command_id: string }) {
      const spec = commandById.get(params.command_id);
      if (!spec) throw new TaskLifecycleError("invalid_input", `unknown admitted task check ${params.command_id}`);
      assertValidationCommandSafe(spec);
      const before = gitSnapshot(root);
      const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
        cwd: resolveValidationCommandCwd(root, spec.cwd),
        env: sanitizedTaskEnvironment(process.env),
        encoding: "utf8",
        timeout: spec.timeout_ms,
        maxBuffer: MAX_CHECK_OUTPUT_BYTES,
      });
      const after = gitSnapshot(root);
      if (before !== after) {
        throw new TaskLifecycleError("invalid_input", `task check ${spec.command_id} mutated the repository`);
      }
      const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      const record = {
        command_id: spec.command_id,
        exit_code: result.status,
        timed_out: timedOut,
        output_digest: sha256(Buffer.from(raw, "utf8")),
        summary: redactTaskText(raw || (timedOut ? "check timed out" : `exit ${result.status ?? "unknown"}`), 1_000),
      };
      checks.push(record);
      return {
        content: [{ type: "text", text: `${spec.command_id}: ${timedOut ? "timed out" : `exit ${result.status ?? "unknown"}`}. Output is redacted and digest-bound.` }],
        isError: timedOut || result.status !== 0,
        details: record,
      };
    },
  });

  const submitTool = defineTool({
    name: "submit_builder_result",
    label: "Submit typed builder result",
    description: "Submit the implementation summary and attempt evidence as the terminal action. Only list a file in changes if you have not already applied it live with write_task_file/replace_task_text/delete_task_file; changes may be empty if your live edits already produced the final state. Trusted code validates every path and precondition before applying any listed changes. This does not approve, commit, push, publish, or merge the work.",
    parameters: Type.Object({
      changes: Type.Array(Type.Union([
        Type.Object({
          action: Type.Literal("write"),
          path: Type.String({ minLength: 1, maxLength: 1_024 }),
          content: Type.String({ maxLength: MAX_TASK_FILE_BYTES }),
        }, { additionalProperties: false }),
        Type.Object({
          action: Type.Literal("delete"),
          path: Type.String({ minLength: 1, maxLength: 1_024 }),
          expected_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        }, { additionalProperties: false }),
      ]), { minItems: 0, maxItems: MAX_SUBMITTED_FILE_CHANGES }),
      summary: Type.String({ minLength: 1, maxLength: 12_000 }),
      attempts: Type.Array(Type.Object({
        sequence: Type.Integer({ minimum: 1, maximum: 32 }),
        approach: Type.String({ minLength: 1, maxLength: 12_000 }),
        result: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]),
        failure_category: Type.Union([Type.String({ minLength: 1, maxLength: 1_500 }), Type.Null()]),
        signal: Type.String({ minLength: 1, maxLength: 12_000 }),
        correction: Type.Union([Type.String({ minLength: 1, maxLength: 12_000 }), Type.Null()]),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
    }, { additionalProperties: false }),
    async execute(_id: string, params: {
      changes: BuilderSubmittedChange[];
      summary: string;
      attempts: Array<{
        sequence: number;
        approach: string;
        result: "succeeded" | "failed" | "cancelled";
        failure_category: string | null;
        signal: string;
        correction: string | null;
      }>;
    }) {
      if (params.changes.length === 0 && !hasLiveMutation) {
        throw new TaskLifecycleError("invalid_input", "builder submission has no changes and no prior live mutation this session");
      }
      const validatedSubmission = validateBuilderModelSubmission({
        summary: params.summary,
        attempts: params.attempts,
        turns: 0,
        cost_usd: null,
        runtime_ms: 0,
        aborted: false,
      });
      const prepared = params.changes.map((change) => ({
        change,
        target: taskPath(input.request, root, change.path),
      }));
      const uniquePaths = new Set(prepared.map(({ target }) => target.relative));
      if (uniquePaths.size !== prepared.length) {
        throw new TaskLifecycleError("invalid_input", "builder submission contains duplicate file changes");
      }
      for (const { change, target } of prepared) {
        if (change.action === "write") {
          if (Buffer.byteLength(change.content, "utf8") > MAX_TASK_FILE_BYTES) {
            throw new TaskLifecycleError("invalid_input", `builder file ${target.relative} exceeds ${MAX_TASK_FILE_BYTES} bytes`);
          }
          continue;
        }
        // A live delete_task_file call earlier this session may have already
        // removed this path; redeclaring it here is a harmless no-op rather
        // than a stale-precondition error.
        if (!fs.existsSync(target.absolute)) continue;
        const stat = fs.lstatSync(target.absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TASK_FILE_BYTES) {
          throw new TaskLifecycleError("invalid_input", `${target.relative} is not one bounded regular file`);
        }
        if (sha256(fs.readFileSync(target.absolute)) !== change.expected_sha256) {
          throw new TaskLifecycleError("invalid_input", `${target.relative} changed since deletion was proposed`);
        }
      }
      for (const { change, target } of prepared) {
        if (change.action === "write") writeAtomic(target.absolute, change.content);
        else if (fs.existsSync(target.absolute)) fs.unlinkSync(target.absolute);
      }
      submission = validatedSubmission;
      return {
        content: [{ type: "text", text: "Bounded file changes and typed builder result recorded. Trusted code will inspect, validate, commit, and publish only after the model session ends." }],
        details: {
          recorded: true,
          changed_paths: prepared.map(({ change, target }) => ({ action: change.action, path: target.relative })),
        },
      };
    },
  });

  return {
    tools: [writeTool, replaceTool, deleteTool, checkTool, submitTool],
    getSubmission: () => submission,
    checkResults: () => [...checks],
  };
}
