#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeOwnedArtifact, resolveExactArtifact } from "./exact-artifact.mjs";
import { writeQualificationReceipt } from "./qualification-receipts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const nodeCommand = process.execPath;
const npmCliPath = process.env.npm_execpath;
assert.equal(typeof npmCliPath, "string", "npm_execpath must identify the active npm CLI");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 240_000,
  });
  if (result.error) throw result.error;
  if (options.expectFailure === true) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
    return result;
  }
  assert.equal(
    result.status,
    options.expectedStatus ?? 0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runNpm(args, options = {}) {
  return run(nodeCommand, [npmCliPath, ...args], options);
}

function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-package-"));
const targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-target-"));
const publicationRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-publication-"));
const publicationRemote = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-remote-"));
let resolvedArtifact = null;

try {
  resolvedArtifact = resolveExactArtifact({ repoRoot, packageJson, runNpm });
  const { tarballPath, artifact } = resolvedArtifact;
  const packedPaths = new Set((artifact.files ?? []).map((entry) => entry.path));
  for (const required of [
    "dist/task-runtime.mjs",
    "scaffold/.github/workflows/agentify-issue.yml",
    "scaffold/.github/scripts/run-task-lifecycle.mjs",
    "scaffold/.github/scripts/task-state-github.mjs",
    "scaffold/.github/scripts/publish-task-draft.mjs",
    "scaffold/.github/agentify-task-policy.json",
  ]) {
    assert.ok(packedPaths.has(required), `packed package is missing ${required}`);
  }
  assert.ok(![...packedPaths].some((entry) => entry.endsWith(".map")), "source maps must remain excluded");
  assert.ok(![...packedPaths].some((entry) => entry.startsWith("src/")), "raw source must remain excluded");

  runNpm(["init", "--yes"], { cwd: installRoot });
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot });
  const installedRoot = path.join(installRoot, "node_modules", packageJson.name);
  const packagedRuntime = path.join(installedRoot, "dist", "task-runtime.mjs");
  assert.ok(fs.existsSync(packagedRuntime));
  const copiedRuntimeDirectory = path.join(targetRepo, ".github", "agentify");
  fs.mkdirSync(copiedRuntimeDirectory, { recursive: true });
  const runtime = path.join(copiedRuntimeDirectory, "task-runtime.mjs");
  fs.copyFileSync(packagedRuntime, runtime);

  const branchInput = path.join(targetRepo, "branch-input.json");
  const branchOutput = path.join(targetRepo, "branch-output.json");
  fs.writeFileSync(branchInput, JSON.stringify({ issue_number: 152, issue_title: "Implement task lifecycle" }));
  run(nodeCommand, [runtime, "branch-name", branchInput, branchOutput], { cwd: targetRepo, timeout: 30_000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(branchOutput, "utf8")), {
    branch: "agentify/issue-152-implement-task-lifecycle",
  });

  const eventInput = path.join(targetRepo, "event-input.json");
  const eventOutput = path.join(targetRepo, "event-output.json");
  fs.writeFileSync(eventInput, JSON.stringify({
    schema_version: "1",
    delivery_id: "delivery-152",
    event_name: "issues",
    action: "labeled",
    repository: { repository_id: "123", full_name: "fixture/repository", default_branch: "main" },
    installation_repository_id: "123",
    issue_number: 152,
    issue_state: "open",
    issue_is_pull_request: false,
    issue_title: "Task lifecycle",
    issue_body: "## Acceptance criteria\n- Opens a draft PR\n## Scope\n- `src/core/task-lifecycle`",
    actor: { login: "maintainer", type: "User", permission: "write" },
    label_name: "agentify:queue",
    comment_id: null,
    comment_body: null,
    comment_created_at: null,
    comment_updated_at: null,
    received_at: "2026-08-01T00:00:00.000Z",
  }));
  run(nodeCommand, [runtime, "parse-event", eventInput, eventOutput], { cwd: targetRepo, timeout: 30_000 });
  const parsed = JSON.parse(fs.readFileSync(eventOutput, "utf8"));
  assert.equal(parsed.disposition, "accepted");
  assert.equal(parsed.command, "queue");

  const policy = {
    policy_digest: "",
    approval_required: true,
    approval_ttl_ms: 60_000,
    maximum_cost_usd: 5,
    maximum_runtime_ms: 600_000,
    maximum_model_calls: 8,
    maximum_fix_cycles: 2,
    protected_paths: [".github", ".agentify/policies"],
    allowed_write_paths: ["src", "tests"],
    validation_commands: [{ command_id: "test", argv: ["npm", "test"], cwd: ".", timeout_ms: 60_000, required: true, mutation_allowed: false, source: "repository-policy" }],
    forbidden_actions: ["application merge", "deployment"],
  };
  policy.policy_digest = digest({ ...policy, policy_digest: undefined });
  const initializeInput = path.join(targetRepo, "initialize-input.json");
  const initializeOutput = path.join(targetRepo, "initialize-output.json");
  fs.writeFileSync(initializeInput, JSON.stringify({ repository: { repository_id: "123", full_name: "fixture/repository", default_branch: "main" }, issue_number: 152, expected_base_commit: "a".repeat(40), policy, event_id: "create-152", actor: "maintainer", now: "2026-08-01T00:00:00.000Z" }));
  run(nodeCommand, [runtime, "initialize", initializeInput, initializeOutput], { cwd: targetRepo, timeout: 30_000 });
  const renderOutput = path.join(targetRepo, "render-output.json");
  run(nodeCommand, [runtime, "render-state", initializeOutput, renderOutput], { cwd: targetRepo, timeout: 30_000 });
  const rendered = JSON.parse(fs.readFileSync(renderOutput, "utf8"));
  assert.match(rendered.body, /agentify-task-state:v1/);
  assert.deepEqual(rendered.labels, ["agentify:new"]);
  const readinessInput = path.join(targetRepo, "readiness-input.json");
  const readinessOutput = path.join(targetRepo, "readiness-output.json");
  fs.writeFileSync(readinessInput, JSON.stringify({ state: JSON.parse(fs.readFileSync(initializeOutput, "utf8")), decision: { disposition: "ready", reasons: [], clarification_questions: [], risk_category: "low" }, expected_revision: 1, event_id: "readiness-152", actor: "orchestrator", now: "2026-08-01T00:00:01.000Z" }));
  run(nodeCommand, [runtime, "record-readiness", readinessInput, readinessOutput], { cwd: targetRepo, timeout: 30_000 });
  assert.equal(JSON.parse(fs.readFileSync(readinessOutput, "utf8")).state.current_state, "ready");

  const unauthorizedInput = path.join(targetRepo, "unauthorized-input.json");
  const unauthorizedOutput = path.join(targetRepo, "unauthorized-output.json");
  fs.writeFileSync(unauthorizedInput, JSON.stringify({
    ...JSON.parse(fs.readFileSync(eventInput, "utf8")),
    delivery_id: "delivery-unauthorized",
    actor: { login: "attacker", type: "User", permission: "read" },
  }));
  run(nodeCommand, [runtime, "parse-event", unauthorizedInput, unauthorizedOutput], { cwd: targetRepo, timeout: 30_000 });
  assert.equal(JSON.parse(fs.readFileSync(unauthorizedOutput, "utf8")).disposition, "unauthorized");

  run("git", ["init", "-q"], { cwd: publicationRepo });
  run("git", ["config", "user.name", "Agentify Qualification"], { cwd: publicationRepo });
  run("git", ["config", "user.email", "agentify@example.invalid"], { cwd: publicationRepo });
  fs.mkdirSync(path.join(publicationRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(publicationRepo, "src", "value.ts"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: publicationRepo });
  run("git", ["commit", "-qm", "initial fixture"], { cwd: publicationRepo });
  const base = run("git", ["rev-parse", "HEAD"], { cwd: publicationRepo }).stdout.trim();
  run("git", ["init", "--bare", "-q"], { cwd: publicationRemote });
  run("git", ["remote", "add", "origin", publicationRemote], { cwd: publicationRepo });
  run("git", ["push", "-q", "origin", "HEAD:main"], { cwd: publicationRepo });
  const branch = "agentify/issue-152-implement-task-lifecycle";
  const taskId = "qualification-task-152";
  const planDigest = "a".repeat(64);
  run("git", ["switch", "-qc", branch], { cwd: publicationRepo });
  fs.writeFileSync(path.join(publicationRepo, "src", "value.ts"), "export const value = 2;\n");
  run("git", ["add", "src/value.ts"], { cwd: publicationRepo });
  run("git", ["commit", "-qm", [
    "implement qualified task",
    "",
    `Agentify-Task-ID: ${taskId}`,
    "Agentify-Issue: 152",
    `Agentify-Expected-Base: ${base}`,
    `Agentify-Plan-Digest: ${planDigest}`,
  ].join("\n")], { cwd: publicationRepo });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: publicationRepo }).stdout.trim();

  const fakeState = path.join(targetRepo, "fake-github.json");
  fs.writeFileSync(fakeState, JSON.stringify({ pull_request: null, labels: [] }));
  const fakeGh = path.join(targetRepo, "fake-github-driver.mjs");
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const bare = process.env.FAKE_GITHUB_BARE;
const base = process.env.FAKE_GITHUB_BASE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const remoteHead = (branch) => {
  const result = spawnSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/" + branch], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
if (args[0] === "auth" && args[1] === "setup-git") process.exit(0);
if (args[0] === "api") {
  const method = args[2]; const endpoint = args[3];
  if (method === "GET" && endpoint.endsWith("/git/ref/heads/main")) { console.log(JSON.stringify({ object: { sha: base } })); process.exit(0); }
  const marker = "/git/ref/heads/";
  if (method === "GET" && endpoint.includes(marker)) {
    const sha = remoteHead(decodeURIComponent(endpoint.slice(endpoint.indexOf(marker) + marker.length)));
    if (!sha) process.exit(1);
    console.log(JSON.stringify({ object: { sha } })); process.exit(0);
  }
  if (method === "POST" && endpoint.endsWith("/labels")) { state.labels.push("agentify:draft"); save(); console.log("[]"); process.exit(0); }
  if (method === "PATCH" && endpoint.includes("/pulls/")) { console.log(JSON.stringify(state.pull_request)); process.exit(0); }
}
if (args[0] === "pr" && args[1] === "list") { console.log(JSON.stringify(state.pull_request ? [state.pull_request] : [])); process.exit(0); }
if (args[0] === "pr" && args[1] === "create") {
  const pick = (name) => args[args.indexOf(name) + 1];
  const headBranch = pick("--head");
  state.pull_request = { number: 1520, url: "https://github.example/qualification/lifecycle/pull/1520", isDraft: true, state: "OPEN", body: fs.readFileSync(pick("--body-file"), "utf8"), headRefName: headBranch, baseRefName: pick("--base"), headRefOid: remoteHead(headBranch) };
  save(); console.log(state.pull_request.url); process.exit(0);
}
console.error("unsupported fake GitHub invocation: " + args.join(" ")); process.exit(2);
`, { mode: 0o755 });
  const publisher = path.join(installedRoot, "scaffold", ".github", "scripts", "publish-task-draft.mjs");
  const publicationInput = path.join(targetRepo, "publication-input.json");
  const publicationOutput = path.join(targetRepo, "publication-output.json");
  fs.writeFileSync(publicationInput, JSON.stringify({ repo_root: publicationRepo, repository: "qualification/lifecycle", task_id: taskId, issue_number: 152, expected_base_commit: base, expected_head_commit: head, plan_digest: planDigest, branch, base_branch: "main", allowed_paths: ["src"], protected_paths: [".github", ".agentify", "package.json"], title: "Implement qualified lifecycle", body: "Implements #152.\n\nValidated by the exact installed artifact." }));
  const publicationEnv = { ...process.env, GH_TOKEN: "qualification-placeholder", NODE_ENV: "test", AGENTIFY_GH_TEST_DRIVER: fakeGh, FAKE_GITHUB_STATE: fakeState, FAKE_GITHUB_BARE: publicationRemote, FAKE_GITHUB_BASE: base };
  run(nodeCommand, [publisher, publicationInput, publicationOutput], { cwd: publicationRepo, env: publicationEnv, timeout: 60_000 });
  const published = JSON.parse(fs.readFileSync(publicationOutput, "utf8"));
  assert.equal(published.status, "draft-pr-open");
  assert.equal(published.draft, true);
  assert.equal(published.head_commit, head);
  assert.equal(run("git", ["--git-dir", publicationRemote, "rev-parse", "refs/heads/main"]).stdout.trim(), base);
  assert.equal(run("git", ["--git-dir", publicationRemote, "rev-parse", `refs/heads/${branch}`]).stdout.trim(), head);
  const duplicateOutput = path.join(targetRepo, "publication-duplicate.json");
  run(nodeCommand, [publisher, publicationInput, duplicateOutput], { cwd: publicationRepo, env: publicationEnv, timeout: 60_000 });
  assert.equal(JSON.parse(fs.readFileSync(duplicateOutput, "utf8")).number, published.number);
  const forbiddenDriver = run(nodeCommand, [publisher, publicationInput, path.join(targetRepo, "publication-forbidden.json")], {
    cwd: publicationRepo,
    env: { ...publicationEnv, NODE_ENV: "production" },
    timeout: 60_000,
    expectFailure: true,
  });
  assert.match(forbiddenDriver.stderr, /fake GitHub driver is restricted to test qualification/);

  const installedPolicy = JSON.parse(fs.readFileSync(
    path.join(installedRoot, "scaffold", ".github", "agentify-task-policy.json"),
    "utf8",
  ));
  assert.equal(installedPolicy.schema_version, "2");
  assert.equal(installedPolicy.configured, false);
  assert.equal(installedPolicy.validation_approval, null);
  assert.equal(installedPolicy.validation_execution.network_isolation, "not-provided");
  assert.equal(installedPolicy.policy, null);

  writeQualificationReceipt("installed-task-lifecycle-smoke.mjs", [
    "lifecycle.authorized-issue-accepted",
    "lifecycle.unauthorized-actor-rejected",
    "lifecycle.readiness-transition-executed",
    "lifecycle.draft-publication-executed",
    "lifecycle.duplicate-publication-idempotent",
    "lifecycle.default-branch-unchanged",
    "lifecycle.test-driver-production-use-rejected",
    "lifecycle.schema-v2-placeholder-validated",
  ]);
  console.log(`installed task lifecycle qualification passed with unauthorized-event rejection, one owned builder branch, idempotent fake-GitHub draft publication, and an unchanged human-owned main branch (${packageJson.name}@${packageJson.version}).`);
} finally {
  removeOwnedArtifact(resolvedArtifact);
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(targetRepo, { recursive: true, force: true });
  fs.rmSync(publicationRepo, { recursive: true, force: true });
  fs.rmSync(publicationRemote, { recursive: true, force: true });
}
