import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runLocalShadow } from "../../src/core/shadow/local-runner.ts";
import { collectIssueIdentity, collectOperatorIdentity } from "../../src/core/shadow/identity.ts";
import { readMetricEvents } from "../../src/core/engagement/metrics/storage.ts";

function tmp(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeSource(root: string): string {
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi/agentify"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi/agentify/engagements/verification/evals/suites"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi/agentify/engagements/verification/evals/tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/cache.ts"), "export const cache = true;\n");
  fs.writeFileSync(path.join(root, ".pi/agentify/codebase_map.json"), JSON.stringify({ schema_version: "1" }));
  const stateRoot = path.join(root, ".pi/agentify");
  const engagementRoot = path.join(stateRoot, "engagements/verification");
  fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify({ schema_version: "2", files: [] }));
  for (const name of ["charter", "current-workflow", "automation-decisions", "risk-register"]) {
    fs.writeFileSync(path.join(engagementRoot, `${name}.json`), JSON.stringify({ schema_version: "1", engagement_id: "verification" }));
  }
  fs.writeFileSync(path.join(engagementRoot, "evals/suites/suite.json"), JSON.stringify({ schema_version: "1", suite_id: "suite", task_references: ["task"] }));
  fs.writeFileSync(path.join(engagementRoot, "evals/tasks/task.json"), JSON.stringify({ schema_version: "1", suite_id: "suite", task_id: "task" }));
  fs.writeFileSync(path.join(root, ".github/agentify-shadow.json"), JSON.stringify({
    schema_version: "1", mode: "shadow", engagement_id: "verification", eval_suite_id: "suite",
    task_id: "task", validation_policy: "fixture", maximum_runtime_ms: 10_000,
    maximum_cost_usd: 1, forbidden_paths: [".git", ".github/workflows"],
  }));
  execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/fixture-owner/fixture-repo.git"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"], { stdio: "ignore" });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function makeGh(bin: string, log: string, hangRepo = false): void {
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n  "api --method GET user --jq .login") printf '%s\\n' fixture-operator ;;\n  "repo view fixture-owner/fixture-repo --json id,nameWithOwner,defaultBranchRef") ${hangRepo ? "sleep 2" : "printf '%s\\n' '{\"id\":\"R_fixture\",\"nameWithOwner\":\"fixture-owner/fixture-repo\",\"defaultBranchRef\":{\"name\":\"main\"}}'"} ;;\n  "issue view 9001 --repo fixture-owner/fixture-repo --json number,title,body,url,state,repository") printf '%s\\n' '{"number":9001,"title":"Fix cache ghp_abcdefghijklmnopqrstuvwxyz123456","body":"Acceptance criteria: cache updates are deterministic. Owner: fixture. Add a focused test. Authorization: Bearer secret-token-abcdefghijklmnop","url":"https://github.com/fixture-owner/fixture-repo/issues/9001","state":"OPEN","repository":{"nameWithOwner":"fixture-owner/fixture-repo"}}' ;;\n  "--version") printf '%s\\n' 'gh version fixture' ;;\n  *) printf '%s\\n' "unexpected gh command: $*" >&2; exit 97 ;;\nesac\n`;
  fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o700 });
}

async function withFixture<T>(hangRepo: boolean, run: (input: { source: string; pilot: string; log: string }) => Promise<T>): Promise<T> {
  const source = tmp("agentify-local-source-");
  const pilot = tmp("agentify-local-pilot-");
  const bin = tmp("agentify-local-bin-");
  const log = path.join(bin, "gh.log");
  makeSource(source);
  makeGh(bin, log, hangRepo);
  const oldPath = process.env.PATH;
  const oldUser = process.env.USER;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.USER = "local-fixture-user";
  try { return await run({ source, pilot, log }); }
  finally {
    process.env.PATH = oldPath;
    if (oldUser === undefined) delete process.env.USER; else process.env.USER = oldUser;
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(pilot, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

function input(source: string, pilot: string, maximumRuntimeMs = 10_000) {
  return {
    pilotRoot: pilot, repoSlug: "fixture-repo", githubFullName: "fixture-owner/fixture-repo",
    sourceRepoRoot: source, engagementId: "verification", issueNumber: 9001, suiteId: "suite", taskId: "task",
    configPath: path.join(source, ".github/agentify-shadow.json"), maximumRuntimeMs,
  };
}

test("local runner uses read-only GitHub commands and emits portable origin-bound evidence", async () => {
  await withFixture(false, async ({ source, pilot, log }) => {
    const before = execFileSync("git", ["-C", source, "status", "--porcelain=v1"], { encoding: "utf8" });
    const result = await runLocalShadow(input(source, pilot));
    assert.equal(result.evidenceOrigin, "live_local_shadow");
    assert.doesNotMatch(result.evidencePacketPath, /^\//);
    const packetPath = path.join(pilot, "workspaces/fixture-repo", result.evidencePacketPath);
    const raw = fs.readFileSync(packetPath, "utf8");
    assert.doesNotMatch(raw, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(raw, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(raw, /ghp_abcdefghijklmnopqrstuvwxyz123456|Authorization: Bearer/);
    const packet = JSON.parse(raw);
    assert.equal(packet.local_shadow_attestation.github_operator_login, "fixture-operator");
    assert.equal(packet.local_shadow_attestation.local_operator_identity, "local-fixture-user");
    assert.equal(packet.local_shadow_attestation.github_authentication_status, "authenticated");
    assert.equal(packet.cost.source, "no provider invocation");
    assert.equal(execFileSync("git", ["-C", source, "status", "--porcelain=v1"], { encoding: "utf8" }), before);
    const commands = fs.readFileSync(log, "utf8");
    assert.match(commands, /api --method GET user/);
    assert.match(commands, /repo view/);
    assert.match(commands, /issue view/);
    assert.doesNotMatch(commands, /issue edit|issue comment|pr create|workflow run|secret|variable|repo edit/);
    const events = readMetricEvents(path.join(pilot, "workspaces/fixture-repo/managed-state"), "verification");
    assert.ok(events.every((event) => event.execution_origin === "live_local_shadow"));
  });
});

test("operator identity separates anonymous and unavailable GitHub auth from the OS account", async () => {
  const bin = tmp("agentify-auth-bin-");
  const oldPath = process.env.PATH;
  const oldUser = process.env.USER;
  process.env.USER = "os-user-must-not-be-github";
  try {
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'gh fixture'; exit 0; fi\nexit 1\n", { mode: 0o700 });
    process.env.PATH = bin;
    const anonymous = await collectOperatorIdentity({ timeoutMs: 1_000 });
    assert.equal(anonymous.githubAuthenticationStatus, "anonymous_read");
    assert.equal(anonymous.githubOperatorLogin, null);
    assert.equal(anonymous.localOperatorIdentity, "os-user-must-not-be-github");
    fs.rmSync(path.join(bin, "gh"));
    const unavailable = await collectOperatorIdentity({ timeoutMs: 1_000 });
    assert.equal(unavailable.githubAuthenticationStatus, "unavailable");
    assert.equal(unavailable.githubOperatorLogin, null);
  } finally {
    process.env.PATH = oldPath;
    if (oldUser === undefined) delete process.env.USER; else process.env.USER = oldUser;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("private or inaccessible issues fail closed without a write-capable GitHub fallback", async () => {
  const bin = tmp("agentify-private-bin-");
  const oldPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    process.env.PATH = bin;
    await assert.rejects(() => collectIssueIdentity("fixture-owner/private-repo", 9001, { timeoutMs: 1_000 }), /unable to read requested issue/);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("local runner rejects a symlinked shadow configuration before identity collection", async () => {
  const source = tmp("agentify-config-source-");
  const pilot = tmp("agentify-config-pilot-");
  const outside = path.join(tmp("agentify-config-outside-"), "config.json");
  try {
    makeSource(source);
    const config = path.join(source, ".github/agentify-shadow.json");
    fs.writeFileSync(outside, fs.readFileSync(config));
    fs.unlinkSync(config);
    fs.symlinkSync(outside, config);
    await assert.rejects(() => runLocalShadow(input(source, pilot)), /configuration cannot be a symlink/);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(pilot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  }
});


test("a hanging read-only GitHub subprocess is bounded and writes invalid terminal evidence", async () => {
  await withFixture(true, async ({ source, pilot }) => {
    const started = Date.now();
    await assert.rejects(() => runLocalShadow(input(source, pilot, 150)), /timed out|maximum runtime|SIGKILL/i);
    assert.ok(Date.now() - started < 1_500);
    const shadow = path.join(pilot, "workspaces/fixture-repo/shadow");
    const run = fs.readdirSync(shadow)[0]!;
    const terminal = JSON.parse(fs.readFileSync(path.join(shadow, run, "terminal-evidence.json"), "utf8"));
    assert.equal(terminal.status, "timed_out");
    assert.equal(terminal.classification, "invalid_live_local_shadow_evidence");
  });
});
