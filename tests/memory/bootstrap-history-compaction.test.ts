import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  acceptMemoryCandidate,
  createAgentIdentity,
  listAgentIdentities,
  markMemoryStale,
  persistMemoryCandidate,
  readMemoryRecord,
  recoverTeamMemoryStore,
  updateAgentIdentity,
} from "../../src/core/memory/index.ts";
import {
  COMMIT_A,
  COMMIT_B,
  evidence,
  initialize,
  policyCandidate,
  tempRepo,
  testMemoryOptions,
} from "./helpers.ts";

function exists(cwd: string, relativePath: string): boolean {
  return fs.existsSync(path.join(cwd, relativePath));
}

test("bootstrap identities and durable team knowledge avoid redundant revision-one snapshots", () => {
  const cwd = tempRepo("agentify-bootstrap-history-");
  try {
    initialize(cwd);
    for (const identity of listAgentIdentities(cwd)) {
      assert.equal(
        exists(cwd, `.agentify/history/agents/${identity.agent_id}/000000000001.json`),
        false,
        identity.agent_id,
      );
    }
    assert.equal(recoverTeamMemoryStore(cwd).status, "valid");

    const specialist = createAgentIdentity({
      cwd,
      agentId: "specialist-payments",
      role: "specialist",
      displayName: "Payments Specialist",
      domain: "payments",
      memoryKinds: ["codebase", "procedure", "episode", "specialist"],
      supportingCommit: COMMIT_A,
      evidence: [evidence("payments")],
      actor: "knowledge-maintainer",
      options: testMemoryOptions(),
    });
    assert.equal(specialist.revision, 1);
    assert.equal(
      exists(cwd, ".agentify/history/agents/specialist-payments/000000000001.json"),
      false,
    );

    updateAgentIdentity(cwd, "specialist-payments", {
      displayName: "Payments Domain Specialist",
      supportingCommit: COMMIT_B,
      evidence: [evidence("payments-update", COMMIT_B)],
      actor: "knowledge-maintainer",
      reason: "first material identity change",
      expectedRevision: 1,
      options: testMemoryOptions(),
    });
    assert.equal(
      exists(cwd, ".agentify/history/agents/specialist-payments/000000000001.json"),
      true,
    );
    assert.equal(
      exists(cwd, ".agentify/history/agents/specialist-payments/000000000002.json"),
      true,
    );

    persistMemoryCandidate(
      cwd,
      policyCandidate("bootstrap-policy-candidate", "bootstrap-policy"),
      testMemoryOptions(),
    );
    acceptMemoryCandidate(
      cwd,
      "bootstrap-policy-candidate",
      "knowledge-maintainer",
      "install bootstrap policy",
      testMemoryOptions(),
    );
    assert.equal(readMemoryRecord(cwd, "bootstrap-policy").revision, 1);
    assert.equal(
      exists(cwd, ".agentify/history/memory/bootstrap-policy/000000000001.json"),
      false,
    );
    assert.equal(recoverTeamMemoryStore(cwd).status, "valid");

    markMemoryStale(cwd, "bootstrap-policy", {
      actor: "knowledge-maintainer",
      expectedRevision: 1,
      evidence: [evidence("bootstrap-policy-stale", COMMIT_B, "maintainer_instruction")],
      supportingCommit: COMMIT_B,
      reason: "first material policy change",
      options: testMemoryOptions(),
    });
    assert.equal(
      exists(cwd, ".agentify/history/memory/bootstrap-policy/000000000001.json"),
      true,
    );
    assert.equal(
      exists(cwd, ".agentify/history/memory/bootstrap-policy/000000000002.json"),
      true,
    );
    assert.equal(recoverTeamMemoryStore(cwd).status, "valid");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
