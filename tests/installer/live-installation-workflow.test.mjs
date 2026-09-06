import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { assessInstallation, MODEL_CONFIG, redactSecrets, validateTarget } from "../../scripts/live-installation.mjs";

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
