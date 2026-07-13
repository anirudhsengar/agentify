// tests/orchestrator/comms/server.test.ts — ComsPeer tests.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ComsPeer } from "../../../src/core/orchestrator/comms/server.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function newPeer(comsRoot: string, name: string, sessionId: string): Promise<ComsPeer> {
  const peer = new ComsPeer({
    name,
    sessionId,
    cwd: "/tmp",
    purpose: `peer ${name}`,
    color: "#36F9F6",
    comsRoot,
    project: "test-project-1234",
    heartbeatMs: 60_000,
    socketTimeoutMs: 2_000,
  });
  await peer.listen();
  return peer;
}

async function testListDiscoversPeers(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-list-");
  try {
    const a = await newPeer(comsRoot, "alpha", "session-aaaa");
    const b = await newPeer(comsRoot, "bravo", "session-bbbb");
    const aList = a.list();
    assert.equal(aList.length, 2);
    assert.ok(aList.find((peer) => peer.name === "alpha"));
    assert.ok(aList.find((peer) => peer.name === "bravo"));
    assert.equal(b.list().length, 2);
    const agentsDirPath = path.join(comsRoot, "projects", "test-project-1234", "agents");
    assert.equal(fs.readdirSync(agentsDirPath).filter((name) => name.endsWith(".json")).length, 2);
    await a.close();
    await b.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testSendAndReply(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-roundtrip-");
  try {
    const sender = await newPeer(comsRoot, "sender", "session-cccc");
    const receiver = await newPeer(comsRoot, "receiver", "session-dddd");
    const received: string[] = [];
    receiver.on("prompt", (env) => {
      received.push(env.body);
      void receiver.reply(env.msg_id, `echo: ${env.body}`);
    });
    const pending = sender.send("receiver", "hello");
    assert.equal(pending.status, "pending");
    const result = await sender.await(pending.msg_id, 5_000);
    assert.equal(result.status, "complete");
    assert.equal(result.response?.body, "echo: hello");
    assert.deepEqual(received, ["hello"]);
    await sender.close();
    await receiver.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testFailSendsErrorEnvelope(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-fail-");
  try {
    const sender = await newPeer(comsRoot, "sender", "session-eeee");
    const receiver = await newPeer(comsRoot, "receiver", "session-ffff");
    receiver.on("prompt", (env) => {
      void receiver.fail(env.msg_id, "delivery_failed", "agent crashed");
    });
    const pending = sender.send("receiver", "do thing");
    const result = await sender.await(pending.msg_id, 5_000);
    assert.equal(result.status, "error");
    assert.equal(result.error, "agent crashed");
    assert.equal(result.errorCode, "delivery_failed");
    await sender.close();
    await receiver.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testHopLimitEnforced(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-hop-");
  try {
    const peer1 = await newPeer(comsRoot, "peer1", "session-hhhh");
    const peer2 = await newPeer(comsRoot, "peer2", "session-iiii");
    peer2.on("prompt", (env) => {
      void peer2.fail(env.msg_id, "hop_limit_exceeded", "hop limit exceeded");
    });
    const pending = peer1.send("peer2", "forwarded", { hops: 5 });
    const result = await peer1.await(pending.msg_id, 5_000);
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "hop_limit_exceeded");
    await peer1.close();
    await peer2.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testSendToSelfThrows(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-self-");
  try {
    const me = await newPeer(comsRoot, "lone", "session-jjjj");
    assert.throws(() => me.send("lone", "hi me"), /cannot send to self/);
    await me.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testSendToUnknownTargetThrows(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-unknown-");
  try {
    const me = await newPeer(comsRoot, "alone", "session-kkkk");
    assert.throws(() => me.send("nobody", "hi"), /not found in registry/);
    await me.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testAwaitTimesOut(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-timeout-");
  try {
    const sender = await newPeer(comsRoot, "sender", "session-llll");
    const receiver = await newPeer(comsRoot, "receiver", "session-mmmm");
    receiver.on("prompt", () => undefined);
    const pending = sender.send("receiver", "ping");
    const result = await sender.await(pending.msg_id, 200);
    assert.equal(result.status, "timeout");
    assert.match(result.error ?? "", /timed out/);
    await sender.close();
    await receiver.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testCloseDeregisters(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-close-");
  try {
    const a = await newPeer(comsRoot, "alpha", "session-nnnn");
    const b = await newPeer(comsRoot, "bravo", "session-oooo");
    assert.equal(a.list().length, 2);
    await b.close();
    const aList = a.list();
    assert.equal(aList.length, 1);
    assert.equal(aList[0]?.name, "alpha");
    await a.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

async function testMultipleTurnConversation(): Promise<void> {
  const comsRoot = tempDir("agentify-coms-multi-");
  try {
    const alice = await newPeer(comsRoot, "alice", "session-pppp");
    const bob = await newPeer(comsRoot, "bob", "session-qqqq");
    bob.on("prompt", (env) => {
      void bob.reply(env.msg_id, `bob [${env.conversation_id ?? ""}]: ${env.body}`, {
        conversationId: env.conversation_id,
      });
    });
    const p1 = alice.send("bob", "ping", { conversationId: "turn1" });
    const r1 = await alice.await(p1.msg_id, 5_000);
    assert.equal(r1.response?.body, "bob [turn1]: ping");
    assert.equal(r1.response?.conversation_id, "turn1");
    const p2 = alice.send("bob", "pong", { conversationId: "turn1" });
    const r2 = await alice.await(p2.msg_id, 5_000);
    assert.equal(r2.response?.body, "bob [turn1]: pong");
    assert.equal(r2.response?.conversation_id, "turn1");
    const p3 = alice.send("bob", "again", { conversationId: "turn2" });
    const r3 = await alice.await(p3.msg_id, 5_000);
    assert.equal(r3.response?.body, "bob [turn2]: again");
    assert.equal(r3.response?.conversation_id, "turn2");
    await alice.close();
    await bob.close();
  } finally {
    fs.rmSync(comsRoot, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "listDiscoversPeers", fn: testListDiscoversPeers },
  { name: "sendAndReply", fn: testSendAndReply },
  { name: "failSendsErrorEnvelope", fn: testFailSendsErrorEnvelope },
  { name: "hopLimitEnforced", fn: testHopLimitEnforced },
  { name: "sendToSelfThrows", fn: testSendToSelfThrows },
  { name: "sendToUnknownTargetThrows", fn: testSendToUnknownTargetThrows },
  { name: "awaitTimesOut", fn: testAwaitTimesOut },
  { name: "closeDeregisters", fn: testCloseDeregisters },
  { name: "multipleTurnConversation", fn: testMultipleTurnConversation },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`orchestrator/comms/server tests passed (${passed}/${tests.length}).`);
