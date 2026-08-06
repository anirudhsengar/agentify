import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STATE_SCRIPT = path.join(REPO_ROOT, "scaffold", ".github", "scripts", "task-state-github.mjs");

interface FakeGitHubState {
  next_comment_id: number;
  comments: Array<{ id: number; body: string; user: { login: string; type: string } }>;
  labels: string[];
  known_labels: string[];
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function fixture(): { root: string; stateFile: string; runtime: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-github-runtime-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stateFile = path.join(root, "github.json");
  const initial: FakeGitHubState = {
    next_comment_id: 1,
    comments: [],
    labels: ["user-owned", "agentify:queue"],
    known_labels: [],
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(initial, null, 2)}\n`);

  const runtime = path.join(root, "task-runtime.mjs");
  writeExecutable(runtime, `#!/usr/bin/env node
import fs from "node:fs";
const [command, inputPath, outputPath] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(inputPath, "utf8"));
let output = value;
if (command === "render-state") {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  output = {
    body: [
      "<!-- agentify-task-state:v1 task=" + value.task_id + " revision=" + value.revision + " digest=" + value.current_digest + " -->",
      "Agentify task state: **" + value.current_state + "**",
      "",
      String.fromCharCode(96).repeat(3) + "agentify-task-state",
      payload,
      String.fromCharCode(96).repeat(3),
    ].join("\\n"),
    labels: ["agentify:" + value.current_state],
  };
} else if (!command.startsWith("validate-")) {
  console.error("unsupported fake runtime command " + command);
  process.exit(1);
}
fs.writeFileSync(outputPath, JSON.stringify(output));
`);

  const gh = path.join(bin, process.platform === "win32" ? "gh.mjs" : "gh");
  writeExecutable(gh, `#!/usr/bin/env node
import fs from "node:fs";
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const input = fs.readFileSync(0, "utf8").trim();
const body = input ? JSON.parse(input) : undefined;
if (args[0] !== "api") { console.error("unsupported gh command"); process.exit(2); }
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const endpoint = methodIndex >= 0 ? args[methodIndex + 2] : args[1];
const comments = /^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/comments/.exec(endpoint);
const comment = /^repos\\/[^/]+\\/[^/]+\\/issues\\/comments\\/(\\d+)$/.exec(endpoint);
const issue = /^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)$/.exec(endpoint);
const issueLabels = /^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/labels$/.exec(endpoint);
const issueLabel = /^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/labels\\/(.+)$/.exec(endpoint);
const label = /^repos\\/[^/]+\\/[^/]+\\/labels\\/(.+)$/.exec(endpoint);
const labels = /^repos\\/[^/]+\\/[^/]+\\/labels$/.exec(endpoint);
if (method === "GET" && comments) { console.log(JSON.stringify([state.comments])); process.exit(0); }
if (method === "POST" && comments) {
  const created = { id: state.next_comment_id++, body: body.body, user: { login: "github-actions[bot]", type: "Bot" } };
  state.comments.push(created); save(); console.log(JSON.stringify(created)); process.exit(0);
}
if (method === "PATCH" && comment) {
  const found = state.comments.find((entry) => entry.id === Number(comment[1]));
  if (!found) process.exit(1);
  found.body = body.body; save(); console.log(JSON.stringify(found)); process.exit(0);
}
if (method === "GET" && issue) { console.log(JSON.stringify({ labels: state.labels.map((name) => ({ name })) })); process.exit(0); }
if (method === "POST" && issueLabels) { for (const name of body.labels || []) if (!state.labels.includes(name)) state.labels.push(name); save(); console.log(JSON.stringify(state.labels.map((name) => ({ name })))); process.exit(0); }
if (method === "DELETE" && issueLabel) { const name = decodeURIComponent(issueLabel[2]); state.labels = state.labels.filter((value) => value !== name); save(); process.exit(0); }
if (method === "GET" && label) { const name = decodeURIComponent(label[1]); if (!state.known_labels.includes(name)) process.exit(1); console.log(JSON.stringify({ name })); process.exit(0); }
if (method === "POST" && labels) { if (!state.known_labels.includes(body.name)) state.known_labels.push(body.name); save(); console.log(JSON.stringify(body)); process.exit(0); }
console.error("unsupported fake endpoint " + method + " " + endpoint);
process.exit(2);
`);
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(bin, "gh.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0gh.mjs" %*\r\n`,
    );
  }
  const executablePath = `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  return {
    root,
    stateFile,
    runtime,
    env: {
      ...process.env,
      PATH: executablePath,
      Path: executablePath,
      FAKE_GH_STATE: stateFile,
      GITHUB_REPOSITORY: "fixture/repository",
      AGENTIFY_TASK_RUNTIME: runtime,
      AGENTIFY_GH_TEST_DRIVER: gh,
      NODE_ENV: "test",
    },
  };
}

function runScript(
  env: NodeJS.ProcessEnv,
  args: string[],
  expectedStatus = 0,
): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [STATE_SCRIPT, ...args], {
    env,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `task state command ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function taskState(revision: number, prior: string | null, digest: string, state = "new"): Record<string, unknown> {
  return {
    format: "agentify_task_state",
    schema_version: "1",
    task_id: "task-fixture-152",
    revision,
    prior_state_digest: prior,
    current_digest: digest,
    current_state: state,
  };
}

test("GitHub-backed task state is optimistic, idempotent, projected, and preserves user labels", () => {
  const f = fixture();
  try {
    const first = path.join(f.root, "state-1.json");
    const firstOut = path.join(f.root, "state-1-output.json");
    fs.writeFileSync(first, JSON.stringify(taskState(1, null, "a".repeat(64))));
    runScript(f.env, ["state-write", "152", first, firstOut]);
    assert.equal(JSON.parse(fs.readFileSync(firstOut, "utf8")).status, "created");

    const duplicateOut = path.join(f.root, "state-1-duplicate.json");
    runScript(f.env, ["state-write", "152", first, duplicateOut]);
    assert.equal(JSON.parse(fs.readFileSync(duplicateOut, "utf8")).status, "recovered");

    const second = path.join(f.root, "state-2.json");
    const secondOut = path.join(f.root, "state-2-output.json");
    fs.writeFileSync(second, JSON.stringify(taskState(2, "a".repeat(64), "b".repeat(64), "ready")));
    runScript(f.env, ["state-write", "152", second, secondOut]);
    assert.equal(JSON.parse(fs.readFileSync(secondOut, "utf8")).status, "updated");

    const github = JSON.parse(fs.readFileSync(f.stateFile, "utf8")) as FakeGitHubState;
    assert.equal(github.comments.filter((entry) => entry.body.includes("agentify-task-state:v1")).length, 1);
    assert.equal(github.comments.filter((entry) => entry.body.includes("type=state-event")).length, 2);
    assert.ok(github.labels.includes("user-owned"));
    assert.ok(github.labels.includes("agentify:ready"));
    assert.ok(!github.labels.includes("agentify:new"));
    assert.ok(!github.labels.includes("agentify:queue"));

    const stale = path.join(f.root, "state-stale.json");
    fs.writeFileSync(stale, JSON.stringify(taskState(2, "a".repeat(64), "c".repeat(64), "planned")));
    const staleResult = spawnSync(process.execPath, [STATE_SCRIPT, "state-write", "152", stale, path.join(f.root, "stale-out.json")], { env: f.env, encoding: "utf8" });
    assert.notEqual(staleResult.status, 0);
    assert.match(staleResult.stderr, /stale task state mutation/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("immutable machine records deduplicate exact retries and reject conflicting content", () => {
  const f = fixture();
  try {
    const record = path.join(f.root, "plan.json");
    fs.writeFileSync(record, JSON.stringify({ plan_digest: "a".repeat(64), value: 1 }));
    const first = path.join(f.root, "plan-first.json");
    runScript(f.env, ["record-write", "152", "plan", "task-fixture-152", record, first]);
    assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).status, "created");
    const retry = path.join(f.root, "plan-retry.json");
    runScript(f.env, ["record-write", "152", "plan", "task-fixture-152", record, retry]);
    assert.equal(JSON.parse(fs.readFileSync(retry, "utf8")).status, "recovered");
    fs.writeFileSync(record, JSON.stringify({ plan_digest: "b".repeat(64), value: 2 }));
    const conflict = spawnSync(process.execPath, [STATE_SCRIPT, "record-write", "152", "plan", "task-fixture-152", record, path.join(f.root, "plan-conflict.json")], { env: f.env, encoding: "utf8" });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /already exists with different content/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("public projection comments are bounded and redact credentials and stack frames", () => {
  const f = fixture();
  try {
    const body = path.join(f.root, "comment.txt");
    fs.writeFileSync(body, "Failed with token=github_pat_abcdefghijklmnopqrstuvwxyz123456\n    at secret (/tmp/file.js:1:2)\nSafe next action.");
    runScript(f.env, ["comment", "152", body, path.join(f.root, "comment-output.json")]);
    const github = JSON.parse(fs.readFileSync(f.stateFile, "utf8")) as FakeGitHubState;
    const posted = github.comments.at(-1)?.body ?? "";
    assert.match(posted, /\[REDACTED(?: CREDENTIAL)?\]/);
    assert.doesNotMatch(posted, /github_pat_/);
    assert.doesNotMatch(posted, /at secret/);
    assert.match(posted, /Safe next action/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
