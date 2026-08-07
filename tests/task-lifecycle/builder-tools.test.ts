import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createBuilderTools } from "../../src/core/task-lifecycle/builder-tools.ts";
import type {
  BuilderRequest,
  OrchestratorPlan,
  ValidationCommandSpec,
} from "../../src/core/task-lifecycle/contracts.ts";

interface CheckTool {
  execute(id: string, params: { command_id: string }): Promise<unknown>;
}

interface WriteTool {
  execute(id: string, params: { path: string; content: string }): Promise<unknown>;
}

interface DeleteTool {
  execute(id: string, params: { path: string; expected_sha256: string }): Promise<unknown>;
}

interface SubmitTool {
  execute(id: string, params: {
    changes: Array<
      | { action: "write"; path: string; content: string }
      | { action: "delete"; path: string; expected_sha256: string }
    >;
    summary: string;
    attempts: Array<{
      sequence: number;
      approach: string;
      result: "succeeded" | "failed" | "cancelled";
      failure_category: string | null;
      signal: string;
      correction: string | null;
    }>;
  }): Promise<unknown>;
}

function oneAttempt() {
  return [{
    sequence: 1,
    approach: "direct edit",
    result: "succeeded" as const,
    failure_category: null,
    signal: "run_task_check passed",
    correction: null,
  }];
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): { root: string; tracked: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-builder-check-"));
  const tracked = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(tracked), { recursive: true });
  fs.writeFileSync(tracked, "committed\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Agentify Test");
  git(root, "config", "user.email", "agentify@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return { root, tracked };
}

function checkTool(root: string, script: string): CheckTool {
  const scriptPath = path.join(root, "check.mjs");
  fs.writeFileSync(scriptPath, script);
  const request = {
    ...({} as BuilderRequest),
    allowed_paths: ["src"],
    protected_paths: [".github"],
    plan: { validation_commands: [] } as unknown as OrchestratorPlan,
  };
  const command: ValidationCommandSpec = {
    command_id: "content-check",
    argv: [process.execPath, scriptPath],
    cwd: ".",
    timeout_ms: 10_000,
    required: true,
    mutation_allowed: false,
    source: "repository-policy",
  };
  const tool = createBuilderTools({ cwd: root, request, commands: [command] })
    .tools.find((candidate) => candidate.name === "run_task_check");
  assert.ok(tool);
  return tool as unknown as CheckTool;
}

function builderToolSet(root: string) {
  const request = {
    ...({} as BuilderRequest),
    allowed_paths: ["src"],
    protected_paths: [".github"],
    plan: { validation_commands: [] } as unknown as OrchestratorPlan,
  };
  return createBuilderTools({ cwd: root, request, commands: [] });
}

test("submit_builder_result with empty changes applies only a prior live write", async () => {
  const { root } = fixture();
  try {
    const toolSet = builderToolSet(root);
    const write = toolSet.tools.find((candidate) => candidate.name === "write_task_file") as unknown as WriteTool;
    const submit = toolSet.tools.find((candidate) => candidate.name === "submit_builder_result") as unknown as SubmitTool;
    await write.execute("write", { path: "src/live.txt", content: "written live\n" });
    await submit.execute("submit", { changes: [], summary: "applied via live write only", attempts: oneAttempt() });
    assert.equal(fs.readFileSync(path.join(root, "src", "live.txt"), "utf8"), "written live\n");
    assert.ok(toolSet.getSubmission());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("submit_builder_result redeclaring an already live-deleted file is a harmless no-op", async () => {
  const { root, tracked } = fixture();
  try {
    const toolSet = builderToolSet(root);
    const del = toolSet.tools.find((candidate) => candidate.name === "delete_task_file") as unknown as DeleteTool;
    const submit = toolSet.tools.find((candidate) => candidate.name === "submit_builder_result") as unknown as SubmitTool;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(tracked)).digest("hex");
    await del.execute("delete", { path: "src/value.txt", expected_sha256: digest });
    assert.equal(fs.existsSync(tracked), false);
    await assert.doesNotReject(submit.execute("submit", {
      changes: [{ action: "delete", path: "src/value.txt", expected_sha256: digest }],
      summary: "redeclares an already-deleted path",
      attempts: oneAttempt(),
    }));
    assert.equal(fs.existsSync(tracked), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("submit_builder_result rejects empty changes with no prior live mutation", async () => {
  const { root } = fixture();
  try {
    const toolSet = builderToolSet(root);
    const submit = toolSet.tools.find((candidate) => candidate.name === "submit_builder_result") as unknown as SubmitTool;
    await assert.rejects(
      submit.execute("submit", { changes: [], summary: "nothing happened", attempts: oneAttempt() }),
      /no changes and no prior live mutation/,
    );
    assert.equal(toolSet.getSubmission(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builder check detects content changes to an already-dirty tracked file", async () => {
  const { root, tracked } = fixture();
  try {
    fs.writeFileSync(tracked, "dirty before\n");
    const check = checkTool(root, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(tracked)}, "dirty after\\n");\n`);
    const statusBefore = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    await assert.rejects(check.execute("tracked", { command_id: "content-check" }), /mutated the repository/);
    const statusAfter = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    assert.equal(statusAfter, statusBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builder check detects content changes to an existing untracked file", async () => {
  const { root } = fixture();
  const untracked = path.join(root, "src", "untracked.txt");
  try {
    fs.writeFileSync(untracked, "untracked before\n");
    const check = checkTool(root, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(untracked)}, "untracked after\\n");\n`);
    const statusBefore = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    await assert.rejects(check.execute("untracked", { command_id: "content-check" }), /mutated the repository/);
    const statusAfter = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    assert.equal(statusAfter, statusBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builder check detects changed staged bytes with an unchanged status class", async () => {
  const { root, tracked } = fixture();
  try {
    fs.writeFileSync(tracked, "staged before\n");
    git(root, "add", "src/value.txt");
    const check = checkTool(root, [
      'import { spawnSync } from "node:child_process";',
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(tracked)}, "staged after\\n");`,
      `const result = spawnSync("git", ["-C", ${JSON.stringify(root)}, "add", "src/value.txt"]);`,
      'if (result.status !== 0) process.exit(1);',
      "",
    ].join("\n"));
    const statusBefore = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    await assert.rejects(check.execute("staged", { command_id: "content-check" }), /mutated the repository/);
    const statusAfter = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    assert.equal(statusAfter, statusBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builder check accepts a command that leaves repository bytes unchanged", async () => {
  const { root, tracked } = fixture();
  try {
    fs.writeFileSync(tracked, "dirty but unchanged\n");
    const check = checkTool(root, `import fs from "node:fs"; fs.readFileSync(${JSON.stringify(tracked)});\n`);
    await assert.doesNotReject(check.execute("control", { command_id: "content-check" }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
