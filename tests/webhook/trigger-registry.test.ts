// tests/webhook/trigger-registry.test.ts — registry loading + arg resolution.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkRateLimit,
  findTrigger,
  loadRegistry,
  matchesClause,
  resolvePromptInvocation,
} from "../../src/core/webhook/trigger-registry.ts";
import type { Trigger } from "../../src/core/webhook/state.ts";

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-registry-"));
}

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
}

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "t1",
    path: "/webhooks/t1",
    signature_header: "X-Signature",
    secret_env: "T1_SECRET",
    prompt: { template: "/implement" },
    ...overrides,
  };
}

async function testProjectOverridesUser(): Promise<void> {
  const cwd = tempCwd();
  // Mock user config dir by setting HOME
  const home = tempCwd();
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    writeJson(path.join(home, ".agentify", "webhooks.json"), {
      triggers: [
        makeTrigger({ id: "shared", description: "user" }),
        makeTrigger({ id: "user-only", path: "/webhooks/user-only" }),
      ],
    });
    writeJson(path.join(cwd, ".agentify", "webhooks.json"), {
      triggers: [
        makeTrigger({ id: "shared", description: "project" }),
        makeTrigger({ id: "project-only", path: "/webhooks/project-only" }),
      ],
    });
    const result = loadRegistry(cwd);
    assert.equal(result.triggers.length, 3);
    const shared = result.triggers.find((t) => t.id === "shared");
    assert.equal(shared?.description, "project");
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  }
}

async function testNoFiles(): Promise<void> {
  const cwd = tempCwd();
  const home = tempCwd();
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const result = loadRegistry(cwd);
    assert.equal(result.triggers.length, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  }
}

async function testInvalidJson(): Promise<void> {
  const cwd = tempCwd();
  const home = tempCwd();
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    fs.mkdirSync(path.join(home, ".agentify"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".agentify", "webhooks.json"),
      "{ this is not json",
      { mode: 0o600 },
    );
    const result = loadRegistry(cwd);
    assert.equal(result.triggers.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /not valid JSON/);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  }
}

async function testSchemaViolation(): Promise<void> {
  const cwd = tempCwd();
  const home = tempCwd();
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    writeJson(path.join(home, ".agentify", "webhooks.json"), {
      triggers: [{ id: "missing-fields" }],
    });
    const result = loadRegistry(cwd);
    assert.equal(result.triggers.length, 0);
    assert.ok(result.errors.length >= 1);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  }
}

async function testFindTrigger(): Promise<void> {
  const t1 = makeTrigger({ id: "a", path: "/x", method: "POST" });
  const t2 = makeTrigger({ id: "b", path: "/y", method: "GET" });
  const t3 = makeTrigger({ id: "c", path: "/x", method: "PUT" });

  assert.equal(findTrigger([t1, t2, t3], "POST", "/x")?.id, "a");
  assert.equal(findTrigger([t1, t2, t3], "GET", "/y")?.id, "b");
  assert.equal(findTrigger([t1, t2, t3], "PUT", "/x")?.id, "c");
  assert.equal(findTrigger([t1, t2, t3], "DELETE", "/x"), null);
  assert.equal(findTrigger([t1, t2, t3], "POST", "/nope"), null);
}

async function testMatchesClause(): Promise<void> {
  const trigger = makeTrigger({
    match: {
      equals: { "issue.action": "labeled", "issue.label.name": "agent:implement" },
      content_type: "application/json",
    },
  });

  assert.equal(
    matchesClause(trigger, {
      issue: { action: "labeled", label: { name: "agent:implement" } },
    }, "application/json"),
    true,
  );
  assert.equal(
    matchesClause(trigger, {
      issue: { action: "labeled", label: { name: "bug" } },
    }, "application/json"),
    false,
  );
  assert.equal(
    matchesClause(trigger, {
      issue: { action: "labeled", label: { name: "agent:implement" } },
    }, "text/plain"),
    false,
  );
  assert.equal(matchesClause(trigger, null, "application/json"), false);
}

async function testResolvePromptInvocation(): Promise<void> {
  const trigger = makeTrigger({
    prompt: {
      template: "/implement",
      args_static: { framework: "fastapi" },
      args_from_query: { trace: "trace_id" },
      args_from_payload: { issue_number: "issue.number", body: "issue.body" },
    },
  });
  const payload = {
    issue: { number: 42, body: "Add pagination" },
  };
  const query = { trace_id: "abc-123" };
  const resolved = resolvePromptInvocation(trigger, payload, query);
  assert.equal(resolved.template, "/implement");
  assert.equal(resolved.args["framework"], "fastapi");
  assert.equal(resolved.args["trace"], "abc-123");
  assert.equal(resolved.args["issue_number"], "42");
  assert.equal(resolved.args["body"], "Add pagination");
  // Default tools are read-only (the safe default)
  assert.deepEqual(resolved.tools, ["read", "grep", "find", "ls"]);
}

async function testResolvePromptInvocationPayloadPriority(): Promise<void> {
  const trigger = makeTrigger({
    prompt: {
      template: "/x",
      args_static: { name: "static" },
      args_from_query: { name: "input" },
      args_from_payload: { name: "data" },
    },
  });
  const resolved = resolvePromptInvocation(
    trigger,
    { data: "from-payload" },
    { input: "from-query" },
  );
  // precedence: payload wins over query wins over static
  assert.equal(resolved.args["name"], "from-payload");
}

async function testResolvePromptInvocationMissingPath(): Promise<void> {
  const trigger = makeTrigger({
    prompt: {
      template: "/x",
      args_from_payload: { x: "missing.path" },
    },
  });
  const resolved = resolvePromptInvocation(trigger, {}, {});
  assert.equal(resolved.args["x"], undefined);
}

async function testRateLimit(): Promise<void> {
  const trigger = makeTrigger({
    rate_limit: { requests: 3, window_seconds: 1 },
  });
  const limiter = { buckets: new Map<string, { tokens: number; lastRefill: number }>() };
  // Three calls should pass instantly
  assert.equal(checkRateLimit(limiter, trigger, 1000), true);
  assert.equal(checkRateLimit(limiter, trigger, 1000), true);
  assert.equal(checkRateLimit(limiter, trigger, 1000), true);
  // Fourth fails
  assert.equal(checkRateLimit(limiter, trigger, 1000), false);
  // After 1s window, refilled
  assert.equal(checkRateLimit(limiter, trigger, 2000), true);
}

await testProjectOverridesUser();
await testNoFiles();
await testInvalidJson();
await testSchemaViolation();
await testFindTrigger();
await testMatchesClause();
await testResolvePromptInvocation();
await testResolvePromptInvocationPayloadPriority();
await testResolvePromptInvocationMissingPath();
await testRateLimit();

console.log("webhook trigger-registry tests passed.");