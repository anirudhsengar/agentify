import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamMemoryError,
  agentIdentityRelativePath,
  proposeMemoryCandidate,
} from "../../src/core/memory/index.ts";
import {
  codebaseCandidate,
  policyCandidate,
} from "./helpers.ts";

function hasCode(error: unknown, code: TeamMemoryError["code"]): boolean {
  return error instanceof TeamMemoryError && error.code === code;
}

test("persistent role identities use stable, non-overlapping paths", () => {
  assert.equal(agentIdentityRelativePath("orchestrator", "orchestrator"), ".agentify/agents/orchestrator.json");
  assert.equal(agentIdentityRelativePath("builder", "builder"), ".agentify/agents/roles/builder.json");
  assert.equal(agentIdentityRelativePath("reviewer", "reviewer"), ".agentify/agents/roles/reviewer.json");
  assert.equal(
    agentIdentityRelativePath("knowledge_maintainer", "knowledge-maintainer"),
    ".agentify/agents/roles/knowledge-maintainer.json",
  );
  assert.equal(agentIdentityRelativePath("specialist", "payments"), ".agentify/agents/specialists/payments.json");
  assert.throws(() => agentIdentityRelativePath("orchestrator", "orchestrator-2"), /stable agent ID/);
  assert.throws(() => agentIdentityRelativePath("specialist", "builder"), /reserved agent ID/);
});

test("candidate serialization is deterministic and rejects persisted secrets", () => {
  const draft = codebaseCandidate("candidate-one", "entrypoint");
  const first = proposeMemoryCandidate(draft);
  if (first.kind !== "codebase") throw new Error("candidate kind changed");
  const second = proposeMemoryCandidate({
    ...draft,
    tags: ["codebase", "codebase"],
    dependent_paths: [...draft.dependent_paths, ...draft.dependent_paths],
    payload: { ...draft.payload, symbols: ["entrypoint", "entrypoint"] },
  });
  assert.equal(first.candidate_digest, second.candidate_digest);
  assert.deepEqual(first.tags, ["codebase"]);
  assert.deepEqual(first.payload.symbols, ["entrypoint"]);

  assert.throws(
    () => proposeMemoryCandidate({
      ...draft,
      candidate_id: "secret-candidate",
      memory_id: "secret-memory",
      statement: `Never persist sk-${"x".repeat(32)}`,
    }),
    /credential|private key/i,
  );
  assert.throws(
    () => proposeMemoryCandidate({
      ...draft,
      candidate_id: "bad-evidence",
      memory_id: "bad-evidence",
      evidence: [{ ...draft.evidence[0]!, sha256: null }],
    }),
    /content digest/,
  );
});

test("policy candidates require attributed maintainer authority", () => {
  const valid = proposeMemoryCandidate(policyCandidate("dependency-policy", "dependency-policy"));
  assert.equal(valid.kind, "policy");
  assert.equal(valid.owning_agent_id, "knowledge-maintainer");

  assert.throws(
    () => proposeMemoryCandidate({
      ...policyCandidate("missing-attribution", "missing-attribution"),
      human_attribution: null,
    }),
    (error) => hasCode(error, "invalid_input"),
  );
  assert.throws(
    () => proposeMemoryCandidate({
      ...policyCandidate("wrong-source", "wrong-source"),
      source_type: "merged_code",
      evidence: [
        {
          ...policyCandidate("wrong-source-evidence", "wrong-source-evidence").evidence[0]!,
          source_type: "merged_code",
        },
      ],
    }),
    (error) => hasCode(error, "policy_violation"),
  );
});
