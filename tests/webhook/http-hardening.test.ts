import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  startServer,
  type RunningServer,
  type ServerOptions,
} from "../../src/core/webhook/server.ts";
import { loadRegistry } from "../../src/core/webhook/trigger-registry.ts";
import type { Trigger } from "../../src/core/webhook/state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${prefix}-`));
}

function logger() {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}

interface TestServer {
  baseUrl: string;
  configDir: string;
  cwd: string;
  server: RunningServer;
  close(): Promise<void>;
}

async function startTestServer(
  triggers: Trigger[],
  overrides: Partial<ServerOptions> = {},
): Promise<TestServer> {
  const configDir = tempDir("webhook-hardening-config");
  const cwd = tempDir("webhook-hardening-cwd");
  fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agentify", "webhooks.json"),
    JSON.stringify({ triggers }),
  );

  try {
    const server = await startServer({
      configDir,
      cwd,
      host: "127.0.0.1",
      port: 0,
      loadRegistryFn: () => loadRegistry(cwd),
      logger: logger(),
      ...overrides,
    });
    return {
      baseUrl: `http://127.0.0.1:${server.port}`,
      configDir,
      cwd,
      server,
      async close(): Promise<void> {
        await server.close();
        fs.rmSync(configDir, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "secure-test",
    path: "/webhooks/secure-test",
    signature_header: "X-Signature",
    secret_env: "WEBHOOK_HARDENING_SECRET",
    prompt: { template: "/review" },
    ...overrides,
  };
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function request(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: options.method ?? "GET",
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({
          status: res.statusCode ?? 0,
          json: text ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function withSecret<T>(fn: (secret: string) => Promise<T>): Promise<T> {
  const previous = process.env["WEBHOOK_HARDENING_SECRET"];
  const secret = "hardening-secret";
  process.env["WEBHOOK_HARDENING_SECRET"] = secret;
  try {
    return await fn(secret);
  } finally {
    if (previous === undefined) delete process.env["WEBHOOK_HARDENING_SECRET"];
    else process.env["WEBHOOK_HARDENING_SECRET"] = previous;
  }
}

async function testInvalidSignatureDoesNotConsumeTriggerQuota(): Promise<void> {
  await withSecret(async (secret) => {
    const env = await startTestServer([
      trigger({ rate_limit: { requests: 1, window_seconds: 60 } }),
    ]);
    try {
      const body = JSON.stringify({ action: "review" });
      const invalid = await request(`${env.baseUrl}/webhooks/secure-test`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": "sha256=invalid" },
        body,
      });
      assert.equal(invalid.status, 401);
      assert.deepEqual(invalid.json, { error: "unauthorized" });

      const valid = await request(`${env.baseUrl}/webhooks/secure-test`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": sign(secret, body) },
        body,
      });
      assert.equal(valid.status, 202);
    } finally {
      await env.close();
    }
  });
}

async function testSignedReplayRejectedWithoutTriggerQuotaConsumption(): Promise<void> {
  await withSecret(async (secret) => {
    const env = await startTestServer([
      trigger({ rate_limit: { requests: 2, window_seconds: 60 } }),
    ]);
    try {
      const body = JSON.stringify({ action: "review", issue: 42 });
      const headers = { "content-type": "application/json", "x-signature": sign(secret, body) };
      const first = await request(`${env.baseUrl}/webhooks/secure-test`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(first.status, 202);

      const replay = await request(`${env.baseUrl}/webhooks/secure-test`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(replay.status, 409);
      assert.equal(replay.json.error, "replay_detected");

      const secondBody = JSON.stringify({ action: "review", issue: 43 });
      const second = await request(`${env.baseUrl}/webhooks/secure-test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": sign(secret, secondBody),
        },
        body: secondBody,
      });
      assert.equal(second.status, 202, "replay rejection must not consume the trigger quota");
    } finally {
      await env.close();
    }
  });
}

async function testDeliveryIdControlsReplayIdentity(): Promise<void> {
  await withSecret(async (secret) => {
    const env = await startTestServer([
      trigger({
        delivery_id_header: "X-Delivery-ID",
        rate_limit: { requests: 3, window_seconds: 60 },
      }),
    ]);
    try {
      const body = JSON.stringify({ action: "review" });
      const signature = sign(secret, body);
      for (const deliveryId of ["delivery-1", "delivery-2"]) {
        const accepted = await request(`${env.baseUrl}/webhooks/secure-test`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-signature": signature,
            "x-delivery-id": deliveryId,
          },
          body,
        });
        assert.equal(accepted.status, 202);
      }
      const duplicate = await request(`${env.baseUrl}/webhooks/secure-test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": signature,
          "x-delivery-id": "delivery-2",
        },
        body,
      });
      assert.equal(duplicate.status, 409);
    } finally {
      await env.close();
    }
  });
}

async function testPreAuthLimitIsSeparate(): Promise<void> {
  const env = await startTestServer([trigger()], {
    preAuthRateLimit: { requests: 1, windowSeconds: 60 },
  });
  try {
    const first = await request(`${env.baseUrl}/webhooks/secure-test`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(first.status, 401);
    const second = await request(`${env.baseUrl}/webhooks/secure-test`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(second.status, 429);
    assert.equal(second.json.error, "pre_auth_rate_limited");
  } finally {
    await env.close();
  }
}

async function testReloadDisabledAndAuthenticatedWhenEnabled(): Promise<void> {
  const disabled = await startTestServer([]);
  try {
    const response = await request(`${disabled.baseUrl}/__reload__`, { method: "POST" });
    assert.equal(response.status, 404);
  } finally {
    await disabled.close();
  }

  const enabled = await startTestServer([], {
    enableReloadEndpoint: true,
    adminToken: "reload-token",
  });
  try {
    const unauthorized = await request(`${enabled.baseUrl}/__reload__`, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    const authorized = await request(`${enabled.baseUrl}/__reload__`, {
      method: "POST",
      headers: { authorization: "Bearer reload-token" },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await enabled.close();
  }

  await assert.rejects(
    () => startTestServer([], {
      host: "0.0.0.0",
      enableReloadEndpoint: true,
      adminToken: "reload-token",
    }),
    /loopback host/,
  );
  await assert.rejects(
    () => startTestServer([], { enableReloadEndpoint: true }),
    /requires adminToken/,
  );
}

async function testTaskStatusIsSanitized(): Promise<void> {
  const env = await startTestServer([]);
  try {
    const taskId = "a".repeat(16);
    const taskDir = path.join(env.server.paths.tasksRoot, taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify({
      task_id: taskId,
      trigger_id: "secret-trigger",
      status: "running",
      received_at: "2026-07-11T00:00:00.000Z",
      started_at: "2026-07-11T00:00:01.000Z",
      http: { remote_addr: "10.0.0.1" },
      prompt: { args: { token: "secret" }, cwd: "/private/repo" },
      result: { error_message: "private stack trace" },
    }));

    const response = await request(`${env.baseUrl}/tasks/${taskId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      task_id: taskId,
      status: "running",
      received_at: "2026-07-11T00:00:00.000Z",
      claimed_at: null,
      started_at: "2026-07-11T00:00:01.000Z",
      ended_at: null,
    });
    assert.ok(!("prompt" in response.json));
    assert.ok(!("http" in response.json));
    assert.ok(!("result" in response.json));
  } finally {
    await env.close();
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "invalidSignatureDoesNotConsumeTriggerQuota", fn: testInvalidSignatureDoesNotConsumeTriggerQuota },
  { name: "signedReplayRejectedWithoutTriggerQuotaConsumption", fn: testSignedReplayRejectedWithoutTriggerQuotaConsumption },
  { name: "deliveryIdControlsReplayIdentity", fn: testDeliveryIdControlsReplayIdentity },
  { name: "preAuthLimitIsSeparate", fn: testPreAuthLimitIsSeparate },
  { name: "reloadDisabledAndAuthenticatedWhenEnabled", fn: testReloadDisabledAndAuthenticatedWhenEnabled },
  { name: "taskStatusIsSanitized", fn: testTaskStatusIsSanitized },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}
console.log(`webhook HTTP hardening tests passed (${passed}/${tests.length}).`);
