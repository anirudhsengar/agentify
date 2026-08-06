import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  TeamMemoryError,
  acceptMemoryCandidate,
  createAgentIdentity,
  digestCanonical,
  initializeTeamMemoryStore,
  invalidateMemory,
  listAgentIdentities,
  listMemoryRecords,
  markMemoryStale,
  persistMemoryCandidate,
  readAgentMemoryView,
  rejectMemoryCandidate,
  readMemoryRecord,
  readTeamMemoryManifest,
  recoverTeamMemoryStore,
  revalidateMemory,
  supersedeMemory,
  updateAgentIdentity,
} from "../../src/core/memory/index.ts";
import {
  COMMIT_A,
  COMMIT_B,
  codebaseCandidate,
  evidence,
  initialize,
  policyCandidate,
  tempRepo,
  testMemoryOptions,
} from "./helpers.ts";

function hasCode(error: unknown, code: TeamMemoryError["code"]): boolean {
  return error instanceof TeamMemoryError && error.code === code;
}

test("initialization creates fixed identities and a deterministic visible manifest", () => {
  const cwd = tempRepo("agentify-memory-init-");
  try {
    initialize(cwd);
    const identities = listAgentIdentities(cwd);
    assert.deepEqual(
      identities.map((identity) => identity.agent_id),
      ["orchestrator", "builder", "knowledge-maintainer", "reviewer"],
    );
    assert.equal(identities.find((identity) => identity.agent_id === "builder")?.write_authority, "application_task");
    assert.equal(identities.find((identity) => identity.agent_id === "reviewer")?.read_only, true);
    assert.equal(
      identities.find((identity) => identity.agent_id === "knowledge-maintainer")?.write_authority,
      "knowledge",
    );
    assert.ok(identities.every((identity) => identity.github_write_authority === "none"));

    const manifest = readTeamMemoryManifest(cwd);
    assert.equal(manifest.format, "agentify_team_memory");
    assert.equal(manifest.root, ".agentify");
    assert.equal(manifest.repository_id, "owner/repo");
    assert.deepEqual(manifest.entries, [...manifest.entries].sort((left, right) => left.path.localeCompare(right.path)));
    assert.ok(manifest.entries.some((entry) => entry.path === ".agentify/.gitignore"));
    assert.ok(manifest.entries.every((entry) => !entry.path.startsWith(".agentify/runtime/")));
    assert.equal(
      fs.readFileSync(path.join(cwd, ".agentify/.gitignore"), "utf-8"),
      "runtime/*\n!runtime/audit/\nruntime/audit/*\n!runtime/audit/codebase_map.json\nstate-transactions/\n",
    );
    assert.equal(recoverTeamMemoryStore(cwd).status, "valid");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("recovery migrates manifest-attested legacy ignore rules", () => {
  const cwd = tempRepo("agentify-memory-ignore-migration-");
  try {
    initialize(cwd);
    const manifestPath = path.join(cwd, ".agentify/manifest.json");
    const ignorePath = path.join(cwd, ".agentify/.gitignore");
    const legacyIgnore = "runtime/\nstate-transactions/\n";
    fs.writeFileSync(ignorePath, legacyIgnore);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      revision: number;
      root_digest: string;
      entries: Array<{ path: string; kind: string; sha256: string; bytes: number }>;
    };
    const entry = manifest.entries.find((candidate) => candidate.path === ".agentify/.gitignore");
    assert.ok(entry);
    entry.bytes = Buffer.byteLength(legacyIgnore, "utf-8");
    entry.sha256 = crypto.createHash("sha256").update(legacyIgnore).digest("hex");
    manifest.root_digest = crypto.createHash("sha256").update(
      manifest.entries.map((candidate) =>
        `${candidate.path}\0${candidate.kind}\0${candidate.sha256}\0${candidate.bytes}`
      ).join("\n"),
    ).digest("hex");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const recovery = recoverTeamMemoryStore(cwd);
    assert.equal(recovery.status, "recovered");
    assert.ok(recovery.repaired.includes(".agentify/.gitignore"));
    assert.ok(recovery.repaired.includes(".agentify/manifest.json"));
    assert.equal(
      fs.readFileSync(ignorePath, "utf-8"),
      "runtime/*\n!runtime/audit/\nruntime/audit/*\n!runtime/audit/codebase_map.json\nstate-transactions/\n",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("interrupted first-time initialization resumes from its durable journal", () => {
  const cwd = tempRepo("agentify-memory-init-recovery-");
  try {
    let interrupted = false;
    assert.throws(
      () => initializeTeamMemoryStore({
        cwd,
        repositoryId: "owner/repo",
        supportingCommit: COMMIT_A,
        evidence: [evidence("bootstrap")],
        options: testMemoryOptions({
          now: () => new Date("2026-07-30T00:00:00.000Z"),
          afterInitializationJournalWrite: () => {
            if (!interrupted) {
              interrupted = true;
              throw new Error("simulated initialization interruption");
            }
          },
        }),
      }),
      /simulated initialization interruption/,
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/manifest.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/agents")), false);
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify/state-transactions/team-memory-initialization.json")),
      true,
    );

    const recovery = recoverTeamMemoryStore(cwd, testMemoryOptions({
      now: () => new Date("2026-07-30T00:01:00.000Z"),
    }));
    assert.equal(recovery.status, "recovered");
    assert.equal(readTeamMemoryManifest(cwd).repository_id, "owner/repo");
    assert.deepEqual(
      listAgentIdentities(cwd).map((identity) => identity.agent_id),
      ["orchestrator", "builder", "knowledge-maintainer", "reviewer"],
    );
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify/state-transactions/team-memory-initialization.json")),
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("unrelated user-owned .agentify state is not claimed", () => {
  const cwd = tempRepo("agentify-memory-user-owned-");
  try {
    fs.mkdirSync(path.join(cwd, ".agentify"));
    fs.writeFileSync(path.join(cwd, ".agentify", "notes.txt"), "user-owned\n");
    assert.equal(recoverTeamMemoryStore(cwd).status, "absent");
    assert.throws(() => initialize(cwd), (error) => hasCode(error, "unsafe_path"));
    assert.equal(fs.readFileSync(path.join(cwd, ".agentify", "notes.txt"), "utf-8"), "user-owned\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("user-owned Agentify-shaped directories are not mistaken for partial team memory", () => {
  const cwd = tempRepo("agentify-memory-shaped-user-owned-");
  try {
    fs.mkdirSync(path.join(cwd, ".agentify", "agents"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".agentify", "agents", "notes.md"), "user-owned\n");

    const recovery = recoverTeamMemoryStore(cwd);
    assert.deepEqual(recovery, { status: "absent", repaired: [], manifest: null });
    assert.equal(
      fs.readFileSync(path.join(cwd, ".agentify", "agents", "notes.md"), "utf-8"),
      "user-owned\n",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unrecognized .agentify manifest is treated as user-owned", () => {
  const cwd = tempRepo("agentify-memory-user-manifest-");
  try {
    fs.mkdirSync(path.join(cwd, ".agentify"));
    fs.writeFileSync(
      path.join(cwd, ".agentify", "manifest.json"),
      `${JSON.stringify({ schema_version: "1", owner: "another-tool" }, null, 2)}\n`,
    );
    assert.equal(recoverTeamMemoryStore(cwd).status, "absent");
    assert.throws(() => initialize(cwd), (error) => hasCode(error, "unsafe_path"));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, ".agentify", "manifest.json"), "utf-8")),
      { schema_version: "1", owner: "another-tool" },
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "runtime")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("unrecognized operational directories are never claimed by initialization or mutations", () => {
  const cwd = tempRepo("agentify-memory-user-runtime-");
  try {
    fs.mkdirSync(path.join(cwd, ".agentify/runtime"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".agentify/runtime/owner.txt"), "another tool\n");
    assert.throws(() => initialize(cwd), (error) => hasCode(error, "unsafe_path"));
    assert.throws(
      () => persistMemoryCandidate(cwd, codebaseCandidate("foreign", "foreign")),
      (error) => hasCode(error, "not_initialized"),
    );
    assert.equal(
      fs.readFileSync(path.join(cwd, ".agentify/runtime/owner.txt"), "utf-8"),
      "another tool\n",
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/runtime/locks")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("identity updates are optimistic and role authority is immutable", () => {
  const cwd = tempRepo("agentify-memory-identities-");
  try {
    initialize(cwd);
    const specialist = createAgentIdentity({
      cwd,
      agentId: "payments",
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
    assert.equal(specialist.read_only, true);

    const updated = updateAgentIdentity(cwd, "payments", {
      displayName: "Payments Domain Specialist",
      supportingCommit: COMMIT_B,
      evidence: [evidence("payments-update", COMMIT_B)],
      actor: "knowledge-maintainer",
      reason: "domain ownership was confirmed",
      expectedRevision: 1,
      options: testMemoryOptions(),
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.evidence.length, 2);
    assert.throws(
      () => updateAgentIdentity(cwd, "payments", {
        supportingCommit: COMMIT_B,
        evidence: [evidence("payments-update", COMMIT_B)],
        actor: "knowledge-maintainer",
        reason: "stale writer",
        expectedRevision: 1,
        options: testMemoryOptions(),
      }),
      (error) => hasCode(error, "revision_conflict"),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("durable identity and memory decisions require the active knowledge maintainer", () => {
  const cwd = tempRepo("agentify-memory-authority-");
  try {
    initialize(cwd);
    assert.throws(
      () => createAgentIdentity({
        cwd,
        agentId: "payments",
        role: "specialist",
        displayName: "Payments Specialist",
        domain: "payments",
        memoryKinds: ["codebase", "procedure", "specialist"],
        supportingCommit: COMMIT_A,
        evidence: [evidence("payments")],
        actor: "orchestrator",
        options: testMemoryOptions(),
      }),
      (error) => hasCode(error, "policy_violation"),
    );
    assert.throws(
      () => updateAgentIdentity(cwd, "orchestrator", {
        status: "retired",
        supportingCommit: COMMIT_B,
        evidence: [evidence("retire-orchestrator", COMMIT_B)],
        actor: "knowledge-maintainer",
        reason: "fixed roles cannot be retired",
        expectedRevision: 1,
        options: testMemoryOptions(),
      }),
      (error) => hasCode(error, "policy_violation"),
    );
    assert.throws(
      () => updateAgentIdentity(cwd, "builder", {
        memoryKinds: ["policy"],
        supportingCommit: COMMIT_B,
        evidence: [evidence("expand-builder-memory", COMMIT_B)],
        actor: "knowledge-maintainer",
        reason: "fixed role ownership cannot expand",
        expectedRevision: 1,
        options: testMemoryOptions(),
      }),
      (error) => hasCode(error, "policy_violation"),
    );
    assert.throws(
      () => createAgentIdentity({
        cwd,
        agentId: "unsafe-specialist",
        role: "specialist",
        displayName: "Unsafe Specialist",
        domain: "unsafe",
        memoryKinds: ["codebase", "policy"],
        supportingCommit: COMMIT_A,
        evidence: [evidence("unsafe-specialist")],
        actor: "knowledge-maintainer",
        options: testMemoryOptions(),
      }),
      (error) => hasCode(error, "policy_violation"),
    );

    persistMemoryCandidate(cwd, codebaseCandidate("authority-candidate", "authority-memory"), testMemoryOptions());
    assert.throws(
      () => acceptMemoryCandidate(
        cwd,
        "authority-candidate",
        "orchestrator",
        "orchestrator cannot accept durable memory",
        testMemoryOptions(),
      ),
      (error) => hasCode(error, "policy_violation"),
    );
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify/runtime/candidates/authority-candidate.json")),
      true,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("candidates are idempotent, queryable, deduplicated, and authority checked", () => {
  const cwd = tempRepo("agentify-memory-candidates-");
  try {
    initialize(cwd);
    const first = persistMemoryCandidate(cwd, codebaseCandidate("candidate-one", "entrypoint"), testMemoryOptions());
    const repeated = persistMemoryCandidate(cwd, codebaseCandidate("candidate-one", "entrypoint"), testMemoryOptions());
    assert.equal(first.candidate_digest, repeated.candidate_digest);

    const accepted = acceptMemoryCandidate(
      cwd,
      "candidate-one",
      "knowledge-maintainer",
      "verified repository fact",
      testMemoryOptions({ now: () => new Date("2026-07-30T00:02:00.000Z") }),
    );
    const acceptedAgain = acceptMemoryCandidate(
      cwd,
      first,
      "knowledge-maintainer",
      "idempotent retry",
      testMemoryOptions({ now: () => new Date("2026-07-30T00:03:00.000Z") }),
    );
    assert.equal(acceptedAgain.revision, accepted.revision);
    assert.deepEqual(acceptedAgain.accepted_candidate_ids, ["candidate-one"]);
    assert.equal(listMemoryRecords(cwd, { path: "src" }).length, 1);
    assert.equal(listMemoryRecords(cwd, { owningAgentId: "orchestrator" }).length, 1);
    assert.equal(readAgentMemoryView(cwd, "builder").records.length, 1);
    assert.equal(readAgentMemoryView(cwd, "reviewer").records.length, 1);

    if (accepted.kind !== "codebase") throw new Error("accepted candidate kind changed");
    const duplicateDraft = {
      ...codebaseCandidate("candidate-two", "alternate-id"),
      statement: accepted.statement,
      dependent_paths: accepted.dependent_paths,
      payload: accepted.payload,
    };
    persistMemoryCandidate(cwd, duplicateDraft, testMemoryOptions());
    const merged = acceptMemoryCandidate(
      cwd, "candidate-two", "knowledge-maintainer", "same fact, new evidence", testMemoryOptions(),
    );
    assert.equal(merged.memory_id, accepted.memory_id);
    assert.deepEqual(merged.accepted_candidate_ids, ["candidate-one", "candidate-two"]);

    persistMemoryCandidate(cwd, policyCandidate("dependency-policy-candidate", "dependency-policy"), testMemoryOptions());
    const policy = acceptMemoryCandidate(
      cwd,
      "dependency-policy-candidate",
      "knowledge-maintainer",
      "maintainer-authorized policy",
      testMemoryOptions(),
    );
    assert.equal(policy.kind, "policy");
    assert.throws(
      () => persistMemoryCandidate(cwd, {
        ...policyCandidate("bad-policy-proposer", "bad-policy"),
        proposed_by_agent_id: "orchestrator",
      }, testMemoryOptions()),
      (error) => hasCode(error, "policy_violation"),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("first-time initialization resumes from its durable journal", () => {
  const cwd = tempRepo("agentify-memory-init-crash-");
  try {
    let interrupted = false;
    assert.throws(
      () => initializeTeamMemoryStore({
        cwd,
        repositoryId: "owner/repo",
        supportingCommit: COMMIT_A,
        evidence: [evidence("bootstrap")],
        options: testMemoryOptions({
          now: () => new Date("2026-07-30T00:00:00.000Z"),
          afterHistoryWrite: () => {
            if (!interrupted) {
              interrupted = true;
              throw new Error("simulated initialization loss");
            }
          },
        }),
      }),
      /simulated initialization loss/,
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/manifest.json")), false);
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify/state-transactions/team-memory-initialization.json")),
      true,
    );
    const recovery = recoverTeamMemoryStore(cwd, testMemoryOptions({
      now: () => new Date("2026-07-30T00:01:00.000Z"),
    }));
    assert.equal(recovery.status, "recovered");
    assert.equal(listAgentIdentities(cwd).length, 4);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/manifest.json")), true);
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify/state-transactions/team-memory-initialization.json")),
      false,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("event-first persistence repairs interrupted current snapshots and decisions", () => {
  const cwd = tempRepo("agentify-memory-crash-");
  try {
    initialize(cwd);
    persistMemoryCandidate(cwd, codebaseCandidate("crash-candidate", "crash-memory"), testMemoryOptions());
    let interrupted = false;
    assert.throws(
      () => acceptMemoryCandidate(
        cwd,
        "crash-candidate",
        "knowledge-maintainer",
        "exercise crash recovery",
        testMemoryOptions({
          now: () => new Date("2026-07-30T00:04:00.000Z"),
          afterHistoryWrite: () => {
            if (!interrupted) {
              interrupted = true;
              throw new Error("simulated process loss");
            }
          },
        }),
      ),
      /simulated process loss/,
    );
    assert.throws(() => readMemoryRecord(cwd, "crash-memory"), (error) => hasCode(error, "not_found"));
    const recovery = recoverTeamMemoryStore(cwd, testMemoryOptions({
      now: () => new Date("2026-07-30T00:05:00.000Z"),
    }));
    assert.equal(recovery.status, "recovered");
    assert.equal(readMemoryRecord(cwd, "crash-memory").revision, 1);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/runtime/candidates/crash-candidate.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/history/candidates/crash-candidate.json")), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejected candidates retain their bounded typed proposal in immutable history", () => {
  const cwd = tempRepo("agentify-memory-rejected-candidate-");
  try {
    initialize(cwd);
    persistMemoryCandidate(cwd, codebaseCandidate("rejected-candidate", "rejected-memory"), testMemoryOptions());
    const decision = rejectMemoryCandidate(
      cwd,
      "rejected-candidate",
      "knowledge-maintainer",
      "evidence was insufficient",
      testMemoryOptions(),
    );
    assert.equal(decision.decision, "rejected");
    assert.equal(decision.candidate.candidate_id, "rejected-candidate");
    assert.equal(decision.candidate.memory_id, "rejected-memory");
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify/runtime/candidates/rejected-candidate.json")),
      false,
    );
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(cwd, ".agentify/history/candidates/rejected-candidate.json"),
        "utf-8",
      ),
    ) as { candidate?: { statement?: string } };
    assert.equal(persisted.candidate?.statement, "rejected-memory statement");
    assert.equal(recoverTeamMemoryStore(cwd).status, "valid");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("every accepted candidate requires one matching immutable decision", () => {
  const cwd = tempRepo("agentify-memory-candidate-decision-");
  try {
    initialize(cwd);
    persistMemoryCandidate(
      cwd,
      codebaseCandidate("decision-candidate", "decision-memory"),
      testMemoryOptions(),
    );
    acceptMemoryCandidate(
      cwd,
      "decision-candidate",
      "knowledge-maintainer",
      "accepted with immutable decision",
      testMemoryOptions(),
    );
    fs.rmSync(path.join(cwd, ".agentify/history/candidates/decision-candidate.json"));
    assert.throws(
      () => recoverTeamMemoryStore(cwd, testMemoryOptions()),
      (error) => hasCode(error, "corrupt_state"),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  const mismatched = tempRepo("agentify-memory-candidate-materialization-");
  try {
    initialize(mismatched);
    persistMemoryCandidate(
      mismatched,
      codebaseCandidate("materialized-candidate", "materialized-memory"),
      testMemoryOptions(),
    );
    acceptMemoryCandidate(
      mismatched,
      "materialized-candidate",
      "knowledge-maintainer",
      "accepted with retained evidence",
      testMemoryOptions(),
    );
    const decisionPath = path.join(
      mismatched,
      ".agentify/history/candidates/materialized-candidate.json",
    );
    const decision = JSON.parse(fs.readFileSync(decisionPath, "utf-8")) as {
      candidate: {
        evidence: Array<{ description: string }>;
        candidate_digest: string;
        [key: string]: unknown;
      };
      candidate_digest: string;
      event_digest: string;
      [key: string]: unknown;
    };
    decision.candidate.evidence[0]!.description = "Different retained evidence";
    const { candidate_digest: _candidateDigest, ...candidateWithoutDigest } = decision.candidate;
    decision.candidate.candidate_digest = digestCanonical(candidateWithoutDigest);
    decision.candidate_digest = decision.candidate.candidate_digest;
    const { event_digest: _eventDigest, ...eventWithoutDigest } = decision;
    decision.event_digest = digestCanonical(eventWithoutDigest);
    fs.writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
    assert.throws(
      () => recoverTeamMemoryStore(mismatched, testMemoryOptions()),
      (error) => hasCode(error, "corrupt_state"),
    );
  } finally {
    fs.rmSync(mismatched, { recursive: true, force: true });
  }
});

test("current snapshots are repairable but immutable history and manifests fail closed on tampering", () => {
  const cwd = tempRepo("agentify-memory-tamper-");
  try {
    initialize(cwd);
    persistMemoryCandidate(cwd, codebaseCandidate("tamper-candidate", "tamper-memory"), testMemoryOptions());
    acceptMemoryCandidate(
      cwd, "tamper-candidate", "knowledge-maintainer", "accept for tamper test", testMemoryOptions(),
    );

    const currentPath = path.join(cwd, ".agentify/knowledge/codebase/tamper-memory.json");
    fs.writeFileSync(currentPath, "{broken\n");
    assert.equal(recoverTeamMemoryStore(cwd).status, "recovered");
    assert.equal(readMemoryRecord(cwd, "tamper-memory").memory_id, "tamper-memory");

    const historyPath = path.join(cwd, ".agentify/history/memory/tamper-memory/000000000001.json");
    const event = JSON.parse(fs.readFileSync(historyPath, "utf-8")) as Record<string, unknown>;
    event.reason = "tampered";
    fs.writeFileSync(historyPath, `${JSON.stringify(event, null, 2)}\n`);
    assert.throws(() => recoverTeamMemoryStore(cwd), (error) => hasCode(error, "corrupt_state"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  const manifestRepo = tempRepo("agentify-memory-manifest-tamper-");
  try {
    initialize(manifestRepo);
    const manifestPath = path.join(manifestRepo, ".agentify/manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest.root_digest = "0".repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => recoverTeamMemoryStore(manifestRepo), (error) => hasCode(error, "corrupt_state"));
  } finally {
    fs.rmSync(manifestRepo, { recursive: true, force: true });
  }
});

test("event chains are contiguous and visible layout is closed", () => {
  const cwd = tempRepo("agentify-memory-event-chain-");
  try {
    initialize(cwd);
    persistMemoryCandidate(cwd, codebaseCandidate("gap-candidate", "gap-memory"), testMemoryOptions());
    acceptMemoryCandidate(
      cwd, "gap-candidate", "knowledge-maintainer", "initial fact", testMemoryOptions(),
    );
    markMemoryStale(cwd, "gap-memory", {
      actor: "knowledge-maintainer",
      expectedRevision: 1,
      evidence: [evidence("gap-stale", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "create second revision",
      options: testMemoryOptions(),
    });
    fs.rmSync(path.join(cwd, ".agentify/history/memory/gap-memory/000000000001.json"));
    assert.throws(
      () => readAgentMemoryView(cwd, "orchestrator", {
        asOf: "2026-07-30T03:00:00.000Z",
        includeInactive: true,
      }),
      (error) => hasCode(error, "corrupt_state"),
    );
    assert.throws(() => recoverTeamMemoryStore(cwd), (error) => hasCode(error, "corrupt_state"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  const layoutRepo = tempRepo("agentify-memory-layout-");
  try {
    initialize(layoutRepo);
    fs.mkdirSync(path.join(layoutRepo, ".agentify/knowledge/unknown"), { recursive: true });
    assert.throws(() => recoverTeamMemoryStore(layoutRepo), (error) => hasCode(error, "unsafe_path"));
  } finally {
    fs.rmSync(layoutRepo, { recursive: true, force: true });
  }
});

test("stale, superseded, and invalid memory is retained but not served as current expertise", () => {
  const cwd = tempRepo("agentify-memory-lifecycle-");
  try {
    initialize(cwd);
    for (const [candidateId, memoryId, timestamp] of [
      ["old-candidate", "old-fact", "2026-07-30T01:00:00.000Z"],
      ["new-candidate", "new-fact", "2026-07-30T01:01:00.000Z"],
    ] as const) {
      persistMemoryCandidate(cwd, codebaseCandidate(candidateId, memoryId), testMemoryOptions());
      acceptMemoryCandidate(cwd, candidateId, "knowledge-maintainer", "accepted fact", testMemoryOptions({
        now: () => new Date(timestamp),
      }));
    }

    const stale = markMemoryStale(cwd, "old-fact", {
      actor: "knowledge-maintainer",
      expectedRevision: 1,
      evidence: [evidence("old-stale", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "supporting path changed",
      options: testMemoryOptions({ now: () => new Date("2026-07-30T02:00:00.000Z") }),
    });
    assert.equal(stale.freshness, "stale");
    assert.equal(readAgentMemoryView(cwd, "orchestrator").records.some((record) => record.memory_id === "old-fact"), false);

    const current = revalidateMemory(cwd, "old-fact", {
      actor: "knowledge-maintainer",
      expectedRevision: 2,
      evidence: [evidence("old-revalidated", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "fact was re-established",
      options: testMemoryOptions({ now: () => new Date("2026-07-30T02:10:00.000Z") }),
    });
    assert.equal(current.freshness, "current");
    assert.equal(current.invalidation_conditions.includes("fact was re-established"), false);

    const priorView = readAgentMemoryView(cwd, "orchestrator", {
      asOf: "2026-07-30T02:05:00.000Z",
      includeInactive: true,
    });
    assert.equal(priorView.records.find((record) => record.memory_id === "old-fact")?.freshness, "stale");

    const superseded = supersedeMemory(cwd, "old-fact", "new-fact", {
      actor: "knowledge-maintainer",
      expectedRevision: 3,
      evidence: [evidence("old-superseded", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "new fact replaces old fact",
      options: testMemoryOptions(),
    });
    assert.equal(superseded.freshness, "superseded");
    assert.equal(superseded.superseded_by, "new-fact");

    const invalid = invalidateMemory(cwd, "new-fact", {
      actor: "knowledge-maintainer",
      expectedRevision: 1,
      evidence: [evidence("new-invalid", COMMIT_B)],
      supportingCommit: COMMIT_B,
      reason: "underlying contract was removed",
      options: testMemoryOptions(),
    });
    assert.equal(invalid.freshness, "invalid");
    assert.deepEqual(readAgentMemoryView(cwd, "orchestrator").records, []);
    assert.equal(listMemoryRecords(cwd, { freshness: "superseded" }).length, 1);
    assert.equal(listMemoryRecords(cwd, { freshness: "invalid" }).length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("store locking rejects concurrent writers and recovers stale locks", () => {
  const cwd = tempRepo("agentify-memory-lock-");
  try {
    initialize(cwd);
    const lockPath = path.join(cwd, ".agentify/runtime/locks/store.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "{}\n");
    assert.throws(
      () => updateAgentIdentity(cwd, "orchestrator", {
        displayName: "Blocked update",
        supportingCommit: COMMIT_B,
        evidence: [evidence("lock-update", COMMIT_B)],
        actor: "knowledge-maintainer",
        reason: "exercise lock conflict",
        expectedRevision: 1,
      }),
      (error) => hasCode(error, "lock_conflict"),
    );

    const old = new Date("2020-01-01T00:00:00.000Z");
    fs.writeFileSync(lockPath, `${JSON.stringify({
      token: "live-writer",
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: old.toISOString(),
    })}\n`);
    fs.utimesSync(lockPath, old, old);
    assert.throws(
      () => updateAgentIdentity(cwd, "orchestrator", {
        displayName: "Still blocked update",
        supportingCommit: COMMIT_B,
        evidence: [evidence("live-lock-update", COMMIT_B)],
        actor: "knowledge-maintainer",
        reason: "live process owns old lock",
        expectedRevision: 1,
        options: testMemoryOptions({ now: () => new Date("2026-07-30T03:29:00.000Z"), staleLockMs: 1 }),
      }),
      (error) => hasCode(error, "lock_conflict"),
    );

    fs.writeFileSync(lockPath, "{}\n");
    fs.utimesSync(lockPath, old, old);
    const updated = updateAgentIdentity(cwd, "orchestrator", {
      displayName: "Repository Orchestrator",
      supportingCommit: COMMIT_B,
      evidence: [evidence("lock-update", COMMIT_B)],
      actor: "knowledge-maintainer",
      reason: "recover stale lock",
      expectedRevision: 1,
      options: testMemoryOptions({ now: () => new Date("2026-07-30T03:30:00.000Z"), staleLockMs: 1 }),
    });
    assert.equal(updated.revision, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("symlinked memory roots fail closed", { skip: process.platform === "win32" }, () => {
  const cwd = tempRepo("agentify-memory-symlink-");
  const outside = tempRepo("agentify-memory-outside-");
  try {
    fs.symlinkSync(outside, path.join(cwd, ".agentify"), "dir");
    assert.throws(() => initialize(cwd), (error) => hasCode(error, "unsafe_path"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
