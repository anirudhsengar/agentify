#!/usr/bin/env node

import assert from "node:assert/strict";
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
    encoding: "utf-8",
    timeout: options.timeout ?? 600_000,
  });
  if (result.error) throw result.error;
  if (options.expectFailure === true) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
    return result;
  }
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-installed-installer-"));
const installRoot = path.join(root, "install");
const fixturesRoot = path.join(root, "fixtures");
const remotesRoot = path.join(root, "remotes");
const fakeHome = path.join(root, "home");
const fakeBin = path.join(root, "bin");
fs.mkdirSync(installRoot, { recursive: true });
fs.mkdirSync(fixturesRoot, { recursive: true });
fs.mkdirSync(remotesRoot, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(path.join(fakeHome, ".agentify"), { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".agentify", "config.json"), `${JSON.stringify({
  schemaVersion: 1,
  provider: "anthropic",
  thinkingLevel: "high",
  models: { primary: { provider: "anthropic", model: "claude-sonnet-4-5" } },
}, null, 2)}\n`);
let resolvedArtifact = null;

try {
  const runNpm = (args, options = {}) => run(nodeCommand, [npmCliPath, ...args], options);
  resolvedArtifact = resolveExactArtifact({ repoRoot, packageJson, runNpm });
  const { tarballPath } = resolvedArtifact;
  run(nodeCommand, [npmCliPath, "init", "--yes"], { cwd: installRoot });
  run(nodeCommand, [npmCliPath, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: installRoot });
  const profiles = ["small", "moderate", "monorepo", "attached", "readiness-fail"];
  for (const profile of profiles) {
    const fixture = path.join(fixturesRoot, profile);
    const repository = `qualification/${profile}`;
    run(nodeCommand, [npmCliPath, "exec", "--", "tsx", path.join(repoRoot, "tests/package/seed-installed-installer-fixture.ts"), fixture, profile, repository], { cwd: repoRoot });
    const bare = path.join(remotesRoot, `${profile}.git`);
    run("git", ["init", "--bare", "-q", bare]);
    run("git", ["-C", fixture, "remote", "add", "qualification", bare]);
    run("git", ["-C", fixture, "push", "-q", "qualification", "HEAD:main"]);
  }

  const ghScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.join(" ");
if (key === "--version" || key === "auth status") process.exit(0);
const repoPrefix = "api repos/qualification/";
const profile = key.startsWith(repoPrefix) ? key.slice(repoPrefix.length) : "";
if (["small", "moderate", "monorepo", "attached", "readiness-fail"].includes(profile)) {
  const id = { small: 987651, moderate: 987652, monorepo: 987653, attached: 987654, "readiness-fail": 987655 }[profile];
  process.stdout.write(JSON.stringify({ id, full_name: "qualification/" + profile, default_branch: "main", permissions: { admin: true, push: true, pull: true } }));
  process.exit(0);
}
if (key === "api user") { process.stdout.write(JSON.stringify({ login: "fixture-maintainer" })); process.exit(0); }
if (key.startsWith("api repos/qualification/") && key.endsWith("/branches/main/protection")) { process.stdout.write("{}"); process.exit(0); }
if (key.startsWith("api repos/qualification/") && key.endsWith("/actions/permissions/workflow")) { process.stdout.write(JSON.stringify({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false })); process.exit(0); }
if (key.startsWith("api --method PUT repos/qualification/") && key.endsWith("/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true")) process.exit(0);
if (args[0] === "variable" && args[1] === "list") { console.log("[]"); process.exit(0); }
if (args[0] === "label" || args[0] === "variable" || args[0] === "secret") process.exit(0);
process.stderr.write("unexpected fake gh invocation: " + key + "\\n");
process.exit(1);
`;
  const ghPath = path.join(fakeBin, "gh.js");
  fs.writeFileSync(ghPath, ghScript, { mode: 0o755 });
  fs.chmodSync(ghPath, 0o755);
  fs.writeFileSync(path.join(fakeBin, "gh.cmd"), `@"${nodeCommand}" "%~dp0gh.js" %*\r\n`);

  const bin = path.join(installRoot, "node_modules", packageJson.name, "bin", "agentify.js");
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CI: "1",
    NO_COLOR: "1",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    AGENTIFY_GH_CLI: ghPath,
    ANTHROPIC_API_KEY: "installed-smoke-placeholder-not-a-real-key",
  };
  for (const [index, profile] of profiles.entries()) {
    const fixture = path.join(fixturesRoot, profile);
    const isScaffolded = profile === "readiness-fail";
    const first = run(nodeCommand, [bin], { cwd: fixture, env, timeout: 900_000 });
    if (isScaffolded) {
      // A repository with no verifiable validation of its own is not abandoned:
      // Agentify installs its own deterministic validation smoke and verifies it.
      assert.match(
        `${first.stdout}\n${first.stderr}`,
        /validation-smoke|ready/,
      );
    }
    assert.match(first.stdout, /Automatic application merge disabled/);
    for (const relative of [
      ".agentify/manifest.json",
      ".agentify/agents/orchestrator.json",
      ".agentify/agents/roles/builder.json",
      ".agentify/agents/roles/reviewer.json",
      ".agentify/agents/roles/knowledge-maintainer.json",
      ".agentify/policies/self-update-allowlist.json",
      ".github/workflows/agentify-issue.yml",
      ".github/workflows/agentify-learn.yml",
      ".github/scripts/complete-accepted-task-merge.mjs",
      ".github/scripts/publish-task-draft.mjs",
      ".github/scripts/run-task-lifecycle.mjs",
      ".github/scripts/task-state-github.mjs",
      ".github/agentify/task-runtime.mjs",
      ".github/agentify/learning-runtime.mjs",
      ".github/agentify/validation-smoke.mjs",
    ]) assert.ok(fs.existsSync(path.join(fixture, relative)), `${profile}: ${relative}`);
    const policy = JSON.parse(fs.readFileSync(path.join(fixture, ".github/agentify-task-policy.json"), "utf-8"));
    assert.equal(policy.schema_version, "2");
    assert.equal(policy.configured, true);
    assert.equal(policy.repository.repository_id, String(987651 + index));
    assert.notEqual(policy.validation_approval, null);
    assert.equal(policy.validation_execution.mode, "maintainer-approved-unsandboxed");
    assert.equal(policy.application_merge, "disabled");
    if (isScaffolded) {
      const commands = policy.policy.validation_commands.map((command) => command.argv.join(" "));
      assert.ok(
        commands.includes("node .github/agentify/validation-smoke.mjs"),
        `readiness-fail policy must record the scaffolded validation smoke; got: ${commands.join(", ")}`,
      );
    }
  }

  const fixture = path.join(fixturesRoot, "attached");
  const memoryManifestPath = path.join(fixture, ".agentify/manifest.json");
  const focusedMapPath = path.join(fixture, ".agentify/runtime/audit/codebase_map.json");
  assert.ok(fs.existsSync(focusedMapPath));
  run("git", ["-C", fixture, "check-ignore", "-q", ".agentify/runtime/audit/codebase_map.json"], {
    expectFailure: true,
  });
  run("git", ["-C", fixture, "check-ignore", "-q", ".agentify/runtime/audit/history/example.json"]);
  const memoryBefore = fs.readFileSync(memoryManifestPath, "utf-8");
  const second = run(nodeCommand, [bin], { cwd: fixture, env, timeout: 900_000 });
  assert.equal(fs.readFileSync(memoryManifestPath, "utf-8"), memoryBefore);

  run("git", ["-C", fixture, "add", ".agentify", ".github", "AGENTS.md", "SETUP.md"]);
  const staged = run("git", ["-C", fixture, "diff", "--cached", "--name-only"]);
  assert.match(staged.stdout, /^\.agentify\/runtime\/audit\/codebase_map\.json$/m);
  assert.doesNotMatch(staged.stdout, /^\.agentify\/runtime\/audit\/history\//m);
  run("git", ["-C", fixture, "commit", "-qm", "install Agentify fixture"]);
  run("git", ["-C", fixture, "push", "-q", "qualification", "HEAD:main"]);
  const roundTrip = path.join(fixturesRoot, "installed-round-trip");
  run("git", ["clone", "-q", "--branch", "main", path.join(remotesRoot, "attached.git"), roundTrip]);
  assert.ok(
    fs.existsSync(path.join(roundTrip, ".agentify/runtime/audit/codebase_map.json")),
    "canonical audit map must survive the installer commit and GitHub checkout boundary",
  );

  writeQualificationReceipt("installed-installer-smoke.mjs", [
    "installer.validation-approval-configured",
    "installer.schema-v2-fail-closed-policy-written",
    "installer.managed-runtime-installed",
    "installer.validation-smoke-scaffolded-when-missing",
    "installer.canonical-audit-map-versioned",
    "installer.transient-audit-history-ignored",
    "installer.repeated-decline-preserves-memory",
    "installer.checkout-round-trip-preserves-map",
  ]);
  console.log(`installed one-time installer qualification passed for small, moderate, monorepo, attached-team, and validation-scaffolded fixtures (${packageJson.name}@${packageJson.version}).`);
} finally {
  removeOwnedArtifact(resolvedArtifact);
  fs.rmSync(root, { recursive: true, force: true });
}
