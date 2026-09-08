import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assessInstallation, MODEL_CONFIG, redactSecrets, validateTarget, readEvidenceFile, snapshot } from "../../scripts/live-installation.mjs";

function completed(overrides = {}) {
  return { exitCode: 0, signal: null, terminalEvents: [{ status: "success", exit_code: 0 }],
    budget: { usage: { model_calls: 2 } }, sourceUnchanged: true, manifest: { repository_id: "anirudhsengar/hono" },
    specialists: 3, policy: { configured: false, policy: null }, executionPaths: [], observedModel: "MiniMax-M3", ...overrides };
}

test("live workflow pins M3 in every slot and keeps production budgets", () => {
  for (const role of ["primary", "explorer", "lite"]) assert.deepEqual(MODEL_CONFIG.models[role], { provider: "minimax", model: "MiniMax-M3" });
  assert.equal(MODEL_CONFIG.auditBudgets, undefined);
});

test("live target is a maintainer-owned fork at an immutable commit", () => {
  assert.deepEqual(validateTarget("anirudhsengar/hono", "a".repeat(40)), { repository: "anirudhsengar/hono", commit: "a".repeat(40) });
  for (const repository of ["honojs/hono", "anirudhsengar/../other", "anirudhsengar/hono;echo bad", "--help"]) assert.throws(() => validateTarget(repository, "a".repeat(40)));
  for (const commit of ["main", "a".repeat(7), "--upload-pack=bad", "a".repeat(40) + "\n"]) assert.throws(() => validateTarget("anirudhsengar/hono", commit));
});

test("diagnostic-only, synthetic, wrong-model and failed runs never pass", () => {
  for (const overrides of [
    { manifest: null, specialists: 0 }, { exitCode: 1 }, { signal: "SIGTERM" },
    { budget: null }, { budget: { usage: { model_calls: 0 } } },
    { observedModel: "MiniMax-M2.7" }, { sourceUnchanged: false }, { policy: null },
    { terminalEvents: [] }, { terminalEvents: [{ status: "error", exit_code: 1 }] },
    { terminalEvents: [{ status: "success", exit_code: 0 }, { status: "error", exit_code: 1 }] },
  ]) assert.equal(assessInstallation(completed(overrides)).passed, false, JSON.stringify(overrides));
});

test("analysis installation may pass only with execution absent", () => {
  assert.deepEqual(assessInstallation(completed()), { passed: true, failures: [], readiness: "analysis-ready" });
  assert.equal(assessInstallation(completed({ executionPaths: [".github/agentify/task-runtime.mjs"] })).passed, false);
  assert.equal(assessInstallation(completed({ policy: { configured: false, policy: {} } })).passed, false);
});

test("artifact redaction includes literal, JSON-escaped and base64 credentials", () => {
  const secret = 'synthetic-secret-"123456789';
  const raw = [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64")].join("\n");
  assert.equal(redactSecrets(raw, [secret]), "[REDACTED]\n[REDACTED]\n[REDACTED]");
  assert.equal(redactSecrets("ordinary evidence", [undefined, ""]), "ordinary evidence");
});

test("workflow requires deliberate owner authorization and exposes secrets only to installation", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/live-installation.yml", import.meta.url), "utf8");
  assert.match(workflow, /types: \[labeled\]/);
  assert.match(workflow, /github\.actor == github\.repository_owner/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|secrets: inherit/);
  assert.equal((workflow.match(/secrets\.PI_API_KEY/g) ?? []).length, 1);
  assert.match(workflow, /if: always\(\)/);
});

test("runner paths are initialized at step time, not in job-level expressions", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/live-installation.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow.split("    steps:")[0], /\$\{\{\s*runner\./);
  assert.match(workflow, /\$RUNNER_TEMP/);
});

test("evidence reads reject symlinks and oversize files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-evidence-read-"));
  try {
    const file = path.join(root, "evidence.json");
    const link = path.join(root, "link.json");
    fs.writeFileSync(file, "original evidence");
    fs.symlinkSync(file, link);
    assert.throws(() => readEvidenceFile(link));
    assert.throws(() => readEvidenceFile(file, 4), /size limit/);
    assert.equal(readEvidenceFile(file).bytes.toString("utf8"), "original evidence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source snapshots retain Gitlinks without reading submodule directories as files", () => {
  // Mustache's immutable ext/spec Gitlink blocked preparation before any M3 call.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-gitlink-snapshot-"));
  const target = path.join(root, "target");
  const submodule = path.join(root, "submodule");
  const git = (cwd, ...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    for (const directory of [target, submodule]) {
      fs.mkdirSync(directory);
      git(directory, "init", "-q");
      git(directory, "config", "user.name", "Fixture");
      git(directory, "config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(directory, "README.md"), "Original tracked source.\n");
      git(directory, "add", ".");
      git(directory, "commit", "-qm", "fixture");
    }
    const commit = git(submodule, "rev-parse", "HEAD");
    git(target, "update-index", "--add", "--cacheinfo", `160000,${commit},ext/spec`);
    git(target, "commit", "-qm", "tracked Gitlink");
    fs.mkdirSync(path.join(target, "ext/spec"), { recursive: true });
    const before = snapshot(target);
    assert.deepEqual(before["ext/spec"], { kind: "gitlink", commit, worktree_status: "" });
    assert.equal(before["README.md"].kind, "file");
    assert.deepEqual(snapshot(target), before);

    git(target, "update-index", "--cacheinfo", `160000,${"1".repeat(40)},ext/spec`);
    assert.notDeepEqual(snapshot(target)["ext/spec"], before["ext/spec"], "index changes must remain visible");
    git(target, "update-index", "--cacheinfo", `160000,${commit},ext/spec`);
    git(root, "clone", "--no-hardlinks", submodule, path.join(target, "ext/spec"));
    assert.deepEqual(snapshot(target), before, "clean materialization does not change the Gitlink");
    fs.writeFileSync(path.join(target, "ext/spec/README.md"), "Changed nested tracked source.\n");
    assert.notDeepEqual(snapshot(target)["ext/spec"], before["ext/spec"], "dirty nested source must remain visible");
    git(path.join(target, "ext/spec"), "checkout", "--", "README.md");
    assert.deepEqual(snapshot(target), before);
    fs.writeFileSync(path.join(target, "README.md"), "Changed parent source.\n");
    assert.notDeepEqual(snapshot(target)["README.md"], before["README.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata-to-read replacement cannot redirect evidence to an outside file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-evidence-race-"));
  const victim = path.join(root, "evidence.json");
  const outside = path.join(root, "private.json");
  fs.writeFileSync(victim, "original evidence");
  fs.writeFileSync(outside, "synthetic private content");
  const original = fs.lstatSync;
  const stat = t.mock.method(fs, "lstatSync", (candidate, ...args) => {
    const result = original(candidate, ...args);
    if (candidate === victim) {
      fs.unlinkSync(victim);
      fs.symlinkSync(outside, victim);
    }
    return result;
  });
  try {
    syncBuiltinESMExports();
    assert.equal(readEvidenceFile(victim).bytes.toString("utf8"), "original evidence");
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor metadata and bytes stay bound when the pathname is replaced", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-open-evidence-"));
  const victim = path.join(root, "evidence.json");
  const outside = path.join(root, "private.json");
  fs.writeFileSync(victim, "original evidence");
  fs.writeFileSync(outside, "synthetic private content");
  const original = fs.fstatSync;
  let replaced = false;
  const stat = t.mock.method(fs, "fstatSync", (...args) => {
    const result = original(...args);
    if (!replaced) {
      replaced = true;
      fs.unlinkSync(victim);
      fs.symlinkSync(outside, victim);
    }
    return result;
  });
  try {
    syncBuiltinESMExports();
    assert.equal(readEvidenceFile(victim).bytes.toString("utf8"), "original evidence");
    assert.equal(replaced, true);
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
