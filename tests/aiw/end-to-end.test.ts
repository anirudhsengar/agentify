// tests/aiw/end-to-end.test.ts — full AIW end-to-end test.
//
// Boots the webhook daemon (with the AIW worker attached), POSTs
// a signed trigger that declares `aiw_workflow`, asserts a task is
// queued, the AIW worker picks it up, runs the workflow, and the
// KPIs file is updated.
//
// The primary scenario exercises the GitHub PR-labeled-AFK-chore
// trigger (`github-chore-afk` in `.agentify/webhooks.example.json`)
// driving the `plan_build_review_ship` workflow end-to-end. We
// run the daemon with `--dryRun` so the per-phase agent invocations
// are short-circuited; the workflow still walks plan → build →
// review → fix → ship end-to-end on disk and the ship phase is
// gate-denied (no kpis streak), so the workflow terminates as
// `completed`.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/core/webhook/index.ts";
import { defaultConfigDir } from "../../src/core/agentify-config.ts";
import { aiwPaths } from "../../src/core/aiw/paths.ts";
import { aiwStatePaths } from "../../src/core/aiw/index.ts";
import type { Trigger } from "../../src/core/webhook/state.ts";
import type { AiwPaths } from "../../src/core/aiw/paths.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${prefix}-`));
}

function makeGithubChoreZteTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "github-chore-afk",
    path: "/webhooks/github/chore",
    signature_header: "X-Hub-Signature-256",
    signature_algorithm: "hmac-sha256",
    secret_env: "GH_CHORE_SECRET",
    match: {
      equals: {
        action: "labeled",
        "label.name": "agent:afk-chore",
      },
    },
    prompt: {
      template: "/implement",
      aiw_workflow: "plan_build_review_ship",
      args_from_payload: {
        branch: "pull_request.head.ref",
        pr_number: "pull_request.number",
        title: "pull_request.title",
      },
      cwd: "/tmp/nonexistent-just-for-test",
      tools: ["read", "grep", "find", "ls", "bash"],
    },
    ...overrides,
  };
}

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { ...headers, "content-length": String(Buffer.byteLength(body, "utf-8")) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

/**
 * GitHub-style HMAC: `sha256=<hex>` of the raw body. The webhook
 * engine accepts this signature shape via its generic `sha256=`
 * prefix fallback (no `signature_prefix` is required on the trigger).
 */
function githubSignature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function testEndToEnd(): Promise<void> {
  const projectDir = tempDir("aiw-e2e-proj");
  fs.mkdirSync(path.join(projectDir, ".agentify"), { recursive: true });
  const trigger = makeGithubChoreZteTrigger();
  fs.writeFileSync(
    path.join(projectDir, ".agentify", "webhooks.json"),
    JSON.stringify({ triggers: [trigger] }),
    { mode: 0o600 },
  );
  process.env["GH_CHORE_SECRET"] = "supersecret";
  const prevHome = process.env["HOME"];
  const tempHome = tempDir("aiw-e2e-home");
  process.env["HOME"] = tempHome;

  const daemon = await startDaemon({
    cwd: projectDir,
    port: 0,
    dryRun: true, // dry-run so the per-phase LLM calls are skipped
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  try {
    const payload = JSON.stringify({
      action: "labeled",
      label: { name: "agent:afk-chore" },
      pull_request: {
        number: 42,
        title: "Bump dep X",
        head: { ref: "fix/bump-dep-x" },
      },
    });
    const sig = githubSignature("supersecret", payload);

    const response = await httpPost(
      `http://127.0.0.1:${daemon.port}/webhooks/github/chore`,
      payload,
      {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
    );

    assert.equal(response.status, 202, `expected 202, got ${response.status}: ${response.body}`);
    const parsed = JSON.parse(response.body) as { task_id: string; aiw_id: string; aiw: boolean; workflow: string };
    assert.equal(parsed.aiw, true);
    assert.equal(parsed.workflow, "plan_build_review_ship");
    assert.match(parsed.aiw_id, /^[0-9a-f]{16}$/);

    // Wait for the workflow to complete and KPIs to update.
    await waitFor(() => {
      const kpisFile = aiwPaths(defaultConfigDir()).kpisFile;
      return fs.existsSync(kpisFile);
    }, 10_000);

    // Verify the AIW state.json shows the workflow completed.
    const statePaths = aiwStatePaths(defaultConfigDir(), parsed.aiw_id) as AiwPaths;
    await waitFor(() => {
      const stateFile = statePaths.stateFile;
      if (!fs.existsSync(stateFile)) return false;
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as { status: string };
      return raw.status === "completed";
    });

    const finalState = JSON.parse(fs.readFileSync(statePaths.stateFile, "utf-8")) as {
      workflow: string;
      status: string;
      phases: Array<{ phase: string; status: string }>;
    };
    assert.equal(finalState.workflow, "plan_build_review_ship");
    assert.equal(finalState.status, "completed");
    // The 5-phase workflow: plan, build, review, fix, ship.
    // Fix is skipped because no review file was produced
    // (readReviewResult returns null in dry-run). Ship is skipped
    // because the AFK gate denies (no kpis streak).
    assert.equal(finalState.phases.length, 5);
    assert.equal(finalState.phases[0]!.phase, "plan");
    assert.equal(finalState.phases[1]!.phase, "build");
    assert.equal(finalState.phases[2]!.phase, "review");
    assert.equal(finalState.phases[3]!.phase, "fix");
    assert.equal(finalState.phases[4]!.phase, "ship");
    assert.equal(finalState.phases[0]!.status, "done");
    assert.equal(finalState.phases[1]!.status, "done");
    assert.equal(finalState.phases[2]!.status, "done");
    assert.equal(finalState.phases[3]!.status, "skipped");
    assert.equal(finalState.phases[4]!.status, "skipped");
  } finally {
    await daemon.stop();
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    delete process.env["GH_CHORE_SECRET"];
  }
}

async function testSinglePromptTriggerStillWorks(): Promise<void> {
  // Backward-compat: a trigger WITHOUT aiw_workflow still runs the
  // single-prompt path (Class 2 Grade 1 behavior).
  const projectDir = tempDir("aiw-e2e-proj-single");
  fs.mkdirSync(path.join(projectDir, ".agentify"), { recursive: true });
  const trigger: Trigger = {
    id: "github-implement",
    path: "/webhooks/github/issue",
    signature_header: "X-Hub-Signature-256",
    secret_env: "GH_SINGLE_SECRET",
    match: { equals: { action: "labeled" } },
    prompt: {
      template: "/implement",
      args_from_payload: { body: "issue.body" },
      cwd: "/tmp/single",
      tools: ["read"],
      // NOTE: no aiw_workflow — single-prompt path.
    },
  };
  fs.writeFileSync(
    path.join(projectDir, ".agentify", "webhooks.json"),
    JSON.stringify({ triggers: [trigger] }),
    { mode: 0o600 },
  );
  process.env["GH_SINGLE_SECRET"] = "supersecret";
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tempDir("aiw-e2e-home-single");

  const daemon = await startDaemon({
    cwd: projectDir,
    port: 0,
    dryRun: true, // dry-run so no LLM is required
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  try {
    const payload = JSON.stringify({ action: "labeled", issue: { body: "fix the bug" } });
    const sig = "sha256=" + createHmac("sha256", "supersecret").update(payload).digest("hex");
    const response = await httpPost(
      `http://127.0.0.1:${daemon.port}/webhooks/github/issue`,
      payload,
      {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
    );
    assert.equal(response.status, 202);
    const parsed = JSON.parse(response.body) as { queued: boolean; aiw?: boolean };
    assert.equal(parsed.queued, true);
    assert.equal(parsed.aiw, undefined); // NOT an AIW
  } finally {
    await daemon.stop();
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    delete process.env["GH_SINGLE_SECRET"];
  }
}

if (process.env["AGENTIFY_RUN_E2E"] === "1") {
  await testEndToEnd();
}
await testSinglePromptTriggerStillWorks();

console.log("aiw end-to-end tests passed.");
