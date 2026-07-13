// tests/orchestrator/comms/registry.test.ts — PeerRegistry mechanics.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PeerRegistry,
  expandHome,
  isPidAlive,
  projectHash,
  sanitizeName,
} from "../../../src/core/orchestrator/comms/registry.ts";
import type { PeerEntry } from "../../../src/core/orchestrator/comms/types.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function peerEntry(overrides: Partial<PeerEntry> = {}): PeerEntry {
  return {
    name: "test-peer",
    pid: process.pid,
    socketPath: "/tmp/test-peer.sock",
    project: "deadbeefdeadbeef",
    cwd: "/tmp",
    purpose: "test peer",
    color: "#36F9F6",
    lastHeartbeat: new Date().toISOString(),
    contextUsedPct: 0,
    ...overrides,
  };
}

async function testExpandHome(): Promise<void> {
  assert.equal(expandHome("~"), process.env["HOME"] ?? "");
  assert.equal(expandHome("~/foo"), path.join(process.env["HOME"] ?? "", "foo"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("rel/path"), "rel/path");
}

async function testProjectHashIsStable(): Promise<void> {
  const a = projectHash("/tmp/foo");
  const b = projectHash("/tmp/foo");
  assert.equal(a, b);
  const c = projectHash("/tmp/bar");
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
}

async function testSanitizeName(): Promise<void> {
  assert.equal(sanitizeName("planner"), "planner");
  assert.equal(sanitizeName("Foo Bar"), "foo-bar");
  assert.equal(sanitizeName("a/b\\c"), "a-b-c");
  assert.equal(sanitizeName(""), "peer");
  assert.equal(sanitizeName("---"), "peer");
  const long = "a".repeat(100);
  assert.equal(sanitizeName(long).length, 64);
}

async function testIsPidAlive(): Promise<void> {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(2_000_000), false);
}

async function testUpsertGetRemove(): Promise<void> {
  const dir = tempDir("agentify-registry-");
  try {
    const reg = new PeerRegistry({ registryDir: dir });
    const entry = peerEntry({ name: "alpha", project: reg.project });
    reg.upsert(entry);
    const got = reg.get("alpha");
    assert.ok(got);
    assert.equal(got.name, "alpha");
    assert.equal(got.pid, process.pid);

    reg.upsert({ ...entry, contextUsedPct: 42 });
    const got2 = reg.get("alpha");
    assert.equal(got2?.contextUsedPct, 42);

    reg.remove("alpha");
    assert.equal(reg.get("alpha"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testListPrunesDeadPids(): Promise<void> {
  const dir = tempDir("agentify-registry-deadpids-");
  try {
    const reg = new PeerRegistry({ registryDir: dir });
    reg.upsert(peerEntry({ name: "alive", pid: process.pid, project: reg.project }));
    reg.upsert(peerEntry({ name: "dead", pid: 2_000_000, project: reg.project }));
    const { live, pruned } = reg.list();
    assert.equal(live.length, 1);
    assert.equal(live[0]?.name, "alive");
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0]?.name, "dead");
    assert.equal(reg.get("dead"), null);
    const second = reg.list();
    assert.equal(second.live.length, 1);
    assert.equal(second.pruned.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testUpsertRejectsProjectMismatch(): Promise<void> {
  const dir = tempDir("agentify-registry-mismatch-");
  try {
    const reg = new PeerRegistry({ registryDir: dir });
    let threw = false;
    try {
      reg.upsert(peerEntry({ name: "x", project: "wronghashxxxxxx" }));
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testRegistryCreatesAgentsDir(): Promise<void> {
  const dir = tempDir("agentify-registry-createdir-");
  try {
    const reg = new PeerRegistry({ registryDir: dir });
    assert.ok(fs.existsSync(path.join(dir, "projects", reg.project, "agents")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testListHandlesCorruptEntry(): Promise<void> {
  const dir = tempDir("agentify-registry-corrupt-");
  try {
    const reg = new PeerRegistry({ registryDir: dir });
    reg.upsert(peerEntry({ name: "good", pid: process.pid, project: reg.project }));
    const agentsDirPath = path.join(dir, "projects", reg.project, "agents");
    fs.writeFileSync(path.join(agentsDirPath, "corrupt.json"), "{not valid json");
    const { live } = reg.list();
    assert.equal(live.length, 1);
    assert.equal(live[0]?.name, "good");
    assert.equal(fs.existsSync(path.join(agentsDirPath, "corrupt.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "expandHome", fn: testExpandHome },
  { name: "projectHashIsStable", fn: testProjectHashIsStable },
  { name: "sanitizeName", fn: testSanitizeName },
  { name: "isPidAlive", fn: testIsPidAlive },
  { name: "upsertGetRemove", fn: testUpsertGetRemove },
  { name: "listPrunesDeadPids", fn: testListPrunesDeadPids },
  { name: "upsertRejectsProjectMismatch", fn: testUpsertRejectsProjectMismatch },
  { name: "registryCreatesAgentsDir", fn: testRegistryCreatesAgentsDir },
  { name: "listHandlesCorruptEntry", fn: testListHandlesCorruptEntry },
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
console.log(`orchestrator/comms/registry tests passed (${passed}/${tests.length}).`);
