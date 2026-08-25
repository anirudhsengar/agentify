import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  initializeTeamMemoryStore,
  listAgentIdentities,
  listMemoryRecords,
} from "../../src/core/memory/index.ts";
import {
  buildSpecialistEvidenceReference,
  discoverSpecialistPortfolio,
  materializeSpecialistPortfolio,
  readGitCommitTimestamp,
} from "../../src/core/specialists/index.ts";
import { makeSpecialistFixtureMap } from "../fixtures/specialist-map.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, relativePath: string, content = `${relativePath}\n`): void {
  const destination = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function createRepository(): { cwd: string; commit: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-specialist-store-"));
  for (const relativePath of [
    "package.json",
    "src/index.ts",
    "src/lib.ts",
    "src/auth/verify.ts",
    "src/routes/login.ts",
    "src/middleware/session.ts",
    "src/billing/index.ts",
    "src/billing/charge.ts",
    "src/billing/types.ts",
    "tests/auth.test.ts",
    "tests/billing.test.ts",
    "scripts/prime-db.sh",
  ]) {
    write(cwd, relativePath);
  }
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "specialist fixture");
  return { cwd, commit: git(cwd, "rev-parse", "HEAD") };
}

test("materialization persists read-only specialists and retires removed expertise", () => {
  const fixture = createRepository();
  try {
    const observedAt = readGitCommitTimestamp(fixture.cwd, fixture.commit);
    const bootstrapEvidence = buildSpecialistEvidenceReference({
      cwd: fixture.cwd,
      supportingCommit: fixture.commit,
      repositoryPath: "package.json",
      sourceType: "validated_bootstrap",
      observedAt,
      actor: "test-maintainer",
    });
    initializeTeamMemoryStore({
      cwd: fixture.cwd,
      repositoryId: "fixture/specialists",
      supportingCommit: fixture.commit,
      evidence: [bootstrapEvidence],
      actor: "agentify-installer",
      options: { now: () => new Date(observedAt) },
    });

    const portfolio = discoverSpecialistPortfolio(makeSpecialistFixtureMap(), fixture.commit);
    const first = materializeSpecialistPortfolio({
      cwd: fixture.cwd,
      portfolio,
      actor: "knowledge-maintainer",
      observed_at: observedAt,
    });
    assert.deepEqual(
      first.created_specialist_ids,
      ["specialist-authentication", "specialist-billing"],
    );
    const specialist = listAgentIdentities(fixture.cwd)
      .find((identity) => identity.agent_id === "specialist-billing");
    assert.ok(specialist);
    assert.equal(specialist.read_only, true);
    assert.equal(specialist.write_authority, "none");
    assert.equal(specialist.github_write_authority, "none");
    assert.ok(first.specialist_memory.length >= 1);
    assert.ok(first.procedure_memory.length >= 3);

    const second = materializeSpecialistPortfolio({
      cwd: fixture.cwd,
      portfolio,
      actor: "knowledge-maintainer",
      observed_at: observedAt,
    });
    assert.deepEqual(second.created_specialist_ids, []);
    assert.deepEqual(second.updated_specialist_ids, []);
    assert.deepEqual(
      second.unchanged_specialist_ids,
      ["specialist-authentication", "specialist-billing"],
    );
    assert.deepEqual(
      second.specialist_memory.map((record) => record.memory_id),
      first.specialist_memory.map((record) => record.memory_id),
    );

    const reducedMap = makeSpecialistFixtureMap();
    reducedMap.concern_evidence = { concerns: [], not_concerns: [] };
    reducedMap.expert_evidence = { expert_domains: [] };
    reducedMap.artifact_intents!.feature_agents = [];
    reducedMap.customization_evidence = { custom_tool_candidates: [], skill_candidates: [] };
    reducedMap.meta.suggested_subagent_domains = [];
    reducedMap.meta.lifecycle.per_area_template_candidates = [];
    const reducedPortfolio = discoverSpecialistPortfolio(reducedMap, fixture.commit);
    const reduced = materializeSpecialistPortfolio({
      cwd: fixture.cwd,
      portfolio: reducedPortfolio,
      actor: "knowledge-maintainer",
      observed_at: observedAt,
    });
    assert.deepEqual(
      reduced.retired_specialist_ids,
      ["specialist-authentication", "specialist-billing"],
    );
    assert.ok(reduced.stale_procedure_memory_ids.length >= 1);
    assert.equal(
      listAgentIdentities(fixture.cwd)
        .find((identity) => identity.agent_id === "specialist-billing")?.status,
      "retired",
    );
    assert.ok(listMemoryRecords(fixture.cwd, { freshness: "stale" }).length >= 1);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});
