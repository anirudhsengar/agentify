// tests/webhook/end-to-end.test.ts — daemon + CLI integration test.
//
// Spins up the full daemon (HTTP server + worker), POSTs a signed
// trigger, asserts a task is queued, the worker dispatches it, and
// the terminal record lands on disk. Uses a FakeRuntime so no LLM is
// required.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { rebuildQueue, queuePaths } from "../../src/core/webhook/queue.ts";
import { startDaemon } from "../../src/core/webhook/index.ts";
import { loadRegistry } from "../../src/core/webhook/trigger-registry.ts";
import type { Trigger } from "../../src/core/webhook/state.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
} from "../../src/core/types.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${prefix}-`));
}

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "implement-issue",
    path: "/webhooks/github/issue",
    signature_header: "X-Hub-Signature-256",
    secret_env: "GH_SECRET",
    match: { equals: { "action": "labeled" } },
    prompt: {
      template: "/implement",
      args_from_payload: {
        issue_number: "issue.number",
        body: "issue.body",
        title: "issue.title",
      },
      cwd: "/tmp/nonexistent-just-for-test",
      tools: ["read"],
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
        path: u.pathname,
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
  throw new Error(`timeout waiting for condition after ${timeoutMs}ms`);
}

async function testEndToEnd(): Promise<void> {
  const configDir = tempDir("e2e-cfg");
  const cwd = tempDir("e2e-cwd");
  fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
  const trigger = makeTrigger();
  fs.writeFileSync(
    path.join(cwd, ".agentify", "webhooks.json"),
    JSON.stringify({ triggers: [trigger] }),
    { mode: 0o600 },
  );
  process.env["GH_SECRET"] = "supersecret";
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tempDir("e2e-home");

  // Fake runtime that records calls and finishes immediately.
  const calls: AgentRuntimeSessionOptions[] = [];
  const fakeRuntime: AgentRuntime = {
    async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
      calls.push(options);
      return { turns: 1, costUsd: 0.01, aborted: false };
    },
    async runGreenfield(): Promise<AgentRuntimeResult> {
      throw new Error("greenfield not used");
    },
  };

  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    // Use the worker.startWorker in dryRun? No — we want to test the
    // dispatch path. Use a custom runtime via the daemon's worker option.
    // The startDaemon function doesn't expose runtime override today;
    // work around by using the lower-level startServer + startWorker.
    const { startServer } = await import("../../src/core/webhook/server.ts");
    const { startWorker } = await import("../../src/core/webhook/worker.ts");
    const server = await startServer({
      configDir,
      cwd,
      port: 0,
      host: "127.0.0.1",
      loadRegistryFn: () => loadRegistry(cwd),
      logger: { info(){}, warn(){}, error(){} },
    });
    const paths = queuePaths(configDir);
    const worker = startWorker({
      configDir,
      runtime: fakeRuntime,
      pollIntervalMs: 25,
      logger: { info(){}, warn(){}, error(){} },
    });
    const port = server.port;

    try {
      // Send a POST that matches the trigger's match clause.
      const payload = JSON.stringify({
        action: "labeled",
        issue: {
          number: 42,
          body: "Add pagination",
          title: "Pagination",
        },
      });
      const sig = "sha256=" + createHmac("sha256", "supersecret").update(payload).digest("hex");
      const res = await httpPost(
        `http://127.0.0.1:${port}/webhooks/github/issue`,
        payload,
        { "content-type": "application/json", "x-hub-signature-256": sig },
      );
      assert.equal(res.status, 202);
      const taskId = JSON.parse(res.body).task_id as string;
      assert.match(taskId, /^[a-f0-9]{16}$/);

      // Wait for the worker to dispatch and finish.
      await waitFor(() => rebuildQueue(paths).terminal.length === 1);
      const final = rebuildQueue(paths).byId.get(taskId);
      assert.equal(final?.status, "done");
      assert.equal(final?.result?.turns, 1);

      // The runtime was called with the resolved args.
      assert.equal(calls.length, 1);
      const userPrompt = calls[0]!.userPrompt;
      assert.match(userPrompt, /issue_number="42"/);
      assert.match(userPrompt, /body="Add pagination"/);
      assert.match(userPrompt, /title="Pagination"/);
      assert.match(calls[0]!.systemPrompt, /webhook-dispatch mode/);
      // Tool list reflects the trigger's allowlist (single "read" tool).
      assert.deepEqual(calls[0]!.tools, ["read"]);
    } finally {
      await worker.stop();
      await server.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    delete process.env["GH_SECRET"];
  }
}

async function testBadSignatureRejected(): Promise<void> {
  const configDir = tempDir("e2e-bad");
  const cwd = tempDir("e2e-bad-cwd");
  fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
  const trigger = makeTrigger();
  fs.writeFileSync(
    path.join(cwd, ".agentify", "webhooks.json"),
    JSON.stringify({ triggers: [trigger] }),
    { mode: 0o600 },
  );
  process.env["GH_SECRET"] = "supersecret";
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tempDir("e2e-bad-home");

  try {
    const { startServer } = await import("../../src/core/webhook/server.ts");
    const server = await startServer({
      configDir,
      cwd,
      port: 0,
      host: "127.0.0.1",
      loadRegistryFn: () => loadRegistry(cwd),
      logger: { info(){}, warn(){}, error(){} },
    });
    try {
      const payload = JSON.stringify({ action: "labeled", issue: { number: 1 } });
      const bad = "sha256=" + createHmac("sha256", "WRONG").update(payload).digest("hex");
      const res = await httpPost(
        `http://127.0.0.1:${server.port}/webhooks/github/issue`,
        payload,
        { "content-type": "application/json", "x-hub-signature-256": bad },
      );
      assert.equal(res.status, 401);
    } finally {
      await server.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    delete process.env["GH_SECRET"];
  }
}

async function testMatchMissIgnored(): Promise<void> {
  const configDir = tempDir("e2e-miss");
  const cwd = tempDir("e2e-miss-cwd");
  fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agentify", "webhooks.json"),
    JSON.stringify({ triggers: [makeTrigger()] }),
    { mode: 0o600 },
  );
  process.env["GH_SECRET"] = "supersecret";
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tempDir("e2e-miss-home");

  try {
    const { startServer } = await import("../../src/core/webhook/server.ts");
    const server = await startServer({
      configDir,
      cwd,
      port: 0,
      host: "127.0.0.1",
      loadRegistryFn: () => loadRegistry(cwd),
      logger: { info(){}, warn(){}, error(){} },
    });
    const paths = queuePaths(configDir);
    try {
      // action is "opened" (not "labeled"); match clause fails.
      const payload = JSON.stringify({ action: "opened", issue: { number: 1 } });
      const sig = "sha256=" + createHmac("sha256", "supersecret").update(payload).digest("hex");
      const res = await httpPost(
        `http://127.0.0.1:${server.port}/webhooks/github/issue`,
        payload,
        { "content-type": "application/json", "x-hub-signature-256": sig },
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.queued, false);
      assert.equal(body.reason, "match_miss");
      // No task was queued
      assert.equal(rebuildQueue(paths).pending.length, 0);
    } finally {
      await server.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    delete process.env["GH_SECRET"];
  }
}

await testEndToEnd();
await testBadSignatureRejected();
await testMatchMissIgnored();

console.log("webhook end-to-end tests passed.");