import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  TASK_LIFECYCLE_SCHEMA_VERSION,
  type ValidationPlan,
} from "../../src/core/task-lifecycle/contracts.ts";
import {
  captureRepositorySnapshot,
  runValidationPlan,
  resolveValidationInvocation,
} from "../../src/core/task-lifecycle/validation-runner.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(): { root: string; base: string; head: string; branch: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-validation-runner-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Agentify Test"]);
  git(root, ["config", "user.email", "agentify-test@example.invalid"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "value.txt"), "before\n");
  fs.writeFileSync(
    path.join(root, "scripts", "mutate.mjs"),
    'import * as fs from "node:fs"; fs.writeFileSync("src/value.txt", "mutated\\n");\n',
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  const branch = "agentify/issue-152-validation-runner";
  git(root, ["checkout", "-q", "-b", branch]);
  fs.writeFileSync(path.join(root, "src", "value.txt"), "after\n");
  git(root, ["add", "src/value.txt"]);
  git(root, ["commit", "-q", "-m", "builder"]);
  return { root, base, head: git(root, ["rev-parse", "HEAD"]), branch };
}

function plan(input: ReturnType<typeof repository>, argv: string[]): ValidationPlan {
  return {
    schema_version: TASK_LIFECYCLE_SCHEMA_VERSION,
    task_id: "task-validation-runner",
    expected_base_commit: input.base,
    expected_branch: input.branch,
    expected_builder_commit: input.head,
    commands: [{
      command_id: "focused-check",
      argv,
      cwd: ".",
      timeout_ms: 10_000,
      required: true,
      mutation_allowed: false,
      source: "repository-policy",
    }],
    protected_paths: [".github/workflows"],
    allowed_changed_paths: ["src"],
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    plan_digest: "a".repeat(64),
  };
}

test("validation resolves npm without a shell on Windows", () => {
  const invocation = resolveValidationInvocation(["npm", "run", "test"]);
  if (process.platform === "win32") {
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.args[0], /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
    assert.deepEqual(invocation.args.slice(1), ["run", "test"]);
  } else {
    assert.deepEqual(invocation, { command: "npm", args: ["run", "test"] });
  }
});

test("trusted validation runner executes direct argv and records a stable successful tree", async () => {
  const repo = repository();
  try {
    const result = await runValidationPlan(plan(repo, ["git", "status", "--short"]), { cwd: repo.root });
    assert.equal(result.policy_verdict, "passed");
    assert.equal(result.final_commit, repo.head);
    assert.deepEqual(result.changed_files, ["src/value.txt"]);
    assert.equal(result.commands[0].exit_code, 0);
    assert.equal(result.commands[0].tree_digest_before, result.commands[0].tree_digest_after);
    assert.match(result.commands[0].output_digest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("trusted validation runner rejects validation-time repository mutation", async () => {
  const repo = repository();
  try {
    const result = await runValidationPlan(plan(repo, [process.execPath, "scripts/mutate.mjs"]), { cwd: repo.root });
    assert.equal(result.policy_verdict, "failed");
    assert.ok(result.policy_reasons.some((reason) => reason.includes("mutated the repository")));
    assert.notEqual(result.commands[0].tree_digest_before, result.commands[0].tree_digest_after);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("trusted validation runner refuses GitHub and deployment executables before launch", async () => {
  const repo = repository();
  try {
    await assert.rejects(
      runValidationPlan(plan(repo, ["gh", "pr", "merge", "1"]), { cwd: repo.root }),
      /forbidden executable gh/,
    );
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("trusted snapshot detects content changes even when porcelain status is unchanged", () => {
  const repo = repository();
  try {
    fs.writeFileSync(path.join(repo.root, "src", "value.txt"), "dirty-before-check\n");
    const before = captureRepositorySnapshot(repo.root);
    assert.match(before.status.join("\n"), /^ M src\/value\.txt$/m);
    fs.writeFileSync(path.join(repo.root, "src", "value.txt"), "dirty-after-check\n");
    const after = captureRepositorySnapshot(repo.root);
    assert.deepEqual(after.status, before.status);
    assert.notEqual(after.tree_digest, before.tree_digest);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("validation inventories both sides of adversarial renames while allowing an in-scope rename", async () => {
  const cases = [
    [".github/workflows/build.yml", "src/build.ts", false],
    ["package.json", "src/package-copy.json", false],
    ["docs/outside.md", "src/inside.md", false],
    ["src/value.txt", "docs/outside.txt", false],
    ["src/value.txt", "src/renamed.txt", true],
  ] as const;
  for (const [source, destination, allowed] of cases) {
    const repo = repository();
    try {
      const sourcePath = path.join(repo.root, ...source.split("/"));
      if (!fs.existsSync(sourcePath)) {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, "protected\n");
        git(repo.root, ["add", source]);
        git(repo.root, ["commit", "-q", "-m", "seed rename source"]);
        repo.base = git(repo.root, ["rev-parse", "HEAD"]);
      }
      fs.mkdirSync(path.dirname(path.join(repo.root, ...destination.split("/"))), { recursive: true });
      git(repo.root, ["mv", source, destination]);
      git(repo.root, ["commit", "-q", "-m", "rename"]);
      repo.head = git(repo.root, ["rev-parse", "HEAD"]);
      const result = await runValidationPlan(plan(repo, ["git", "status", "--short"]), { cwd: repo.root });
      assert.ok(result.changed_files.includes(source), `missing previous rename path ${source}`);
      assert.ok(result.changed_files.includes(destination), `missing current rename path ${destination}`);
      assert.equal(result.policy_verdict === "passed", allowed);
    } finally {
      fs.rmSync(repo.root, { recursive: true, force: true });
    }
  }
});
