import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PeerRegistry } from "../../../src/core/orchestrator/comms/registry.ts";
import { ComsPeer } from "../../../src/core/orchestrator/comms/server.ts";
import {
  DEFAULT_AWAIT_TIMEOUT_MS,
  DEFAULT_COMS_ROOT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_HOPS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  STALE_AFTER_MS,
  type ErrorCode,
  type ErrorEnvelope,
  type PeerEntry,
  type PromptEnvelope,
  type ResponseEnvelope,
} from "../../../src/core/orchestrator/comms/types.ts";

interface ContractFixture {
  registry_record_fields: string[];
  defaults: {
    coms_root: string;
    max_hops: number;
    socket_timeout_ms: number;
    poll_interval_ms: number;
    await_timeout_ms: number;
    heartbeat_interval_ms: number;
    stale_after_ms: number;
  };
  error_codes: ErrorCode[];
  envelope_fields: {
    prompt: string[];
    response: string[];
    error: string[];
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(HERE, "../../fixtures/orchestrator-comms-contract.json"), "utf-8"),
) as ContractFixture;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

test("communications constants and envelopes match the pre-move contract", () => {
  assert.deepEqual(
    {
      coms_root: DEFAULT_COMS_ROOT,
      max_hops: DEFAULT_MAX_HOPS,
      socket_timeout_ms: DEFAULT_SOCKET_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      await_timeout_ms: DEFAULT_AWAIT_TIMEOUT_MS,
      heartbeat_interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
      stale_after_ms: STALE_AFTER_MS,
    },
    fixture.defaults,
  );

  const prompt: PromptEnvelope = {
    type: "prompt",
    msg_id: "fixture-message",
    sender: "sender",
    target: "target",
    body: "body",
    hops: 0,
    ts: "2026-07-13T00:00:00.000Z",
  };
  const response: ResponseEnvelope = {
    type: "response",
    msg_id: "fixture-message",
    sender: "target",
    target: "sender",
    body: "result",
    hops: 1,
    ts: "2026-07-13T00:00:01.000Z",
    aborted: false,
  };
  const error: ErrorEnvelope = {
    type: "error",
    msg_id: "fixture-message",
    sender: "target",
    target: "sender",
    hops: 1,
    ts: "2026-07-13T00:00:01.000Z",
    error: "failed",
    code: "delivery_failed",
  };

  assert.deepEqual(sortedKeys(prompt), [...fixture.envelope_fields.prompt].sort());
  assert.deepEqual(sortedKeys(response), [...fixture.envelope_fields.response].sort());
  assert.deepEqual(sortedKeys(error), [...fixture.envelope_fields.error].sort());
  assert.deepEqual(fixture.error_codes, [
    "hop_limit_exceeded",
    "unknown_sender",
    "unknown_target",
    "self_send",
    "delivery_failed",
    "timeout",
    "invalid_envelope",
  ] satisfies ErrorCode[]);
});

test("registry record shape, atomic write, and private modes remain unchanged", () => {
  const root = tempDir("agentify-orchestrator-comms-registry-");
  try {
    const registry = new PeerRegistry({ registryDir: root, project: "fixture-project" });
    const entry: PeerEntry = {
      name: "fixture-peer",
      pid: process.pid,
      socketPath: "/tmp/fixture-peer.sock",
      project: "fixture-project",
      cwd: "/tmp",
      purpose: "fixture",
      color: "#36F9F6",
      lastHeartbeat: "2026-07-13T00:00:00.000Z",
      contextUsedPct: 0,
    };
    registry.upsert(entry);

    const agentsDirectory = path.join(root, "projects", "fixture-project", "agents");
    const recordPath = path.join(agentsDirectory, "fixture-peer.json");
    const persisted = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as PeerEntry;
    assert.deepEqual(persisted, entry);
    assert.deepEqual(sortedKeys(persisted), [...fixture.registry_record_fields].sort());
    assert.equal(fs.existsSync(`${recordPath}.tmp`), false);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(agentsDirectory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listen and close remain idempotent and close resolves pending waits", async () => {
  const root = tempDir("agentify-orchestrator-comms-close-");
  const sender = new ComsPeer({
    name: "sender",
    sessionId: "fixture-sender",
    cwd: "/tmp",
    comsRoot: root,
    project: "fixture-project",
  });
  const receiver = new ComsPeer({
    name: "receiver",
    sessionId: "fixture-receiver",
    cwd: "/tmp",
    comsRoot: root,
    project: "fixture-project",
  });
  try {
    await sender.listen();
    await sender.listen();
    await receiver.listen();
    receiver.on("prompt", () => undefined);

    const pending = sender.send("receiver", "remain pending");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = sender.await(pending.msg_id, 5_000);
    await sender.close();
    await sender.close();
    const result = await waiting;

    assert.equal(result.status, "error");
    assert.equal(result.error, "peer closed");
    assert.equal(result.errorCode, "delivery_failed");
  } finally {
    await sender.close();
    await receiver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale socket symlink cleanup does not delete the symlink target", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix-domain socket symlink behavior is POSIX-specific");
    return;
  }

  const root = tempDir("agentify-orchestrator-comms-symlink-");
  const socketsDirectory = path.join(root, "sockets");
  fs.mkdirSync(socketsDirectory, { recursive: true });
  const victimPath = path.join(root, "victim.txt");
  const socketPath = path.join(socketsDirectory, "fixture-symlink.sock");
  fs.writeFileSync(victimPath, "keep");
  fs.symlinkSync(victimPath, socketPath);

  const peer = new ComsPeer({
    name: "symlink-peer",
    sessionId: "fixture-symlink",
    cwd: "/tmp",
    comsRoot: root,
    project: "fixture-project",
  });
  try {
    await peer.listen();
    assert.equal(fs.readFileSync(victimPath, "utf-8"), "keep");
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await peer.close();
    assert.equal(fs.readFileSync(victimPath, "utf-8"), "keep");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
