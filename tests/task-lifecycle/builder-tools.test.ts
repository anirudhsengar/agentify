import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
