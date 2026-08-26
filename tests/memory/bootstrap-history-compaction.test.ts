import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  acceptMemoryCandidate,
  initializeTeamMemoryStore,
  markMemoryStale,
  proposeMemoryCandidate,
  readAgentMemoryView,
  readTeamMemoryManifest,
  recoverTeamMemoryStore,
  updateAgentIdentity,
} from "../../src/core/memory/index.ts";
import {
  COMMIT_A,
  COMMIT_B,
  codebaseCandidate,
  evidence,
  tempRepo,
  testMemoryOptions,
} from "./helpers.ts";

function exists(cwd: string, repositoryPath: string): boolean {
  return fs.existsSync(path.join(cwd, ...repositoryPath.split("/")));
}

test("installer bootstrap stores revision one once and backfills immutable history on mutation", () => {
  const cwd = tempRepo("agentify-memory-snapshot-v1-");
  try {
    initializeTeamMemoryStore({
      cwd,
      repositoryId: "owner/repo",
      supportingCommit: COMMIT_A,
      evidence: [evidence("bootstrap")],
      actor: "agentify-installer",
      options: testMemoryOptions({
        now: () => new Date("2026-08-26T00:00:00.000Z"),
        deferInitialHistory: true,
      }),
    });

    assert.equal(readTeamMemoryManifest(cwd).history_mode, "snapshot-v1");
    for (const identity of ["orchestrator", "builder", "knowledge-maintainer", "reviewer"]) {
      assert.equal(
        exists(cwd, `.agentify/history/agents/${identity}/000000000001.json`),
        false,
      );
    }

    const candidate = proposeMemoryCandidate(
      codebaseCandidate("candidate-bootstrap-memory", "bootstrap-memory"),
    );
    const record = acceptMemoryCandidate(
      cwd,
      candidate,
      "knowledge-maintainer",
      "accept trusted installer specialist memory",
      testMemoryOptions({ now: () => new Date("2026-08-26T00:01:00.000Z") }),
    );
    assert.equal(record.revision, 1);
    assert.equal(
      exists(cwd, ".agentify/history/memory/bootstrap-memory/000000000001.json"),
      false,
    );
    assert.equal(
      exists(cwd, ".agentify/history/candidates/candidate-bootstrap-memory.json"),
      true,
    );
    assert.equal(recoverTeamMemoryStore(cwd, testMemoryOptions()).status, "valid");

    updateAgentIdentity(cwd, "builder", {
      displayName: "Repository Task Builder",
      supportingCommit: COMMIT_B,
      evidence: [evidence("builder-update", COMMIT_B)],
      actor: "knowledge-maintainer",
      reason: "clarify the installed builder identity",
      expectedRevision: 1,
      options: testMemoryOptions({ now: () => new Date("2026-08-26T00:02:00.000Z") }),
    });
    markMemoryStale(cwd, record.memory_id, {
      supportingCommit: COMMIT_B,
      evidence: [evidence("bootstrap-memory-stale", COMMIT_B)],
      actor: "knowledge-maintainer",
      reason: "repository behavior changed",
      expectedRevision: 1,
      options: testMemoryOptions({ now: () => new Date("2026-08-26T00:03:00.000Z") }),
    });

    for (const repositoryPath of [
      ".agentify/history/agents/builder/000000000001.json",
      ".agentify/history/agents/builder/000000000002.json",
      ".agentify/history/memory/bootstrap-memory/000000000001.json",
      ".agentify/history/memory/bootstrap-memory/000000000002.json",
    ]) assert.equal(exists(cwd, repositoryPath), true, repositoryPath);
    assert.equal(recoverTeamMemoryStore(cwd, testMemoryOptions()).status, "valid");

    const historical = readAgentMemoryView(cwd, "orchestrator", {
      asOf: "2026-08-26T00:02:30.000Z",
      includeInactive: true,
    });
    const historicalRecord = historical.records.find((entry) => entry.memory_id === record.memory_id);
    assert.ok(historicalRecord);
    assert.equal(historicalRecord.revision, 1);
    assert.equal(historicalRecord.freshness, "current");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
