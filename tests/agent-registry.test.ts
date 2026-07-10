import assert from "node:assert/strict";
import {
  AGENT_REGISTRY,
  DEFAULT_AGENT_IDS,
  getAgentById,
  getPremiumTargets,
  getUniqueSkillsDirs,
  isKnownAgent,
  type AgentId,
} from "../src/core/agent-registry.ts";

async function testAllEntriesHaveValidShape(): Promise<void> {
  // Every entry has a non-empty id, label, and skillsDir.
  for (const agent of AGENT_REGISTRY) {
    assert.ok(agent.id.length > 0, `agent ${agent.id} has empty id`);
    assert.ok(agent.label.length > 0, `agent ${agent.id} has empty label`);
    assert.ok(
      agent.skillsDir.length > 0,
      `agent ${agent.id} has empty skillsDir`,
    );
    // skillsDir is relative (no leading slash).
    assert.ok(
      !agent.skillsDir.startsWith("/"),
      `agent ${agent.id} has absolute skillsDir: ${agent.skillsDir}`,
    );
  }
}

async function testNoDuplicateIds(): Promise<void> {
  const seen = new Set<AgentId>();
  for (const agent of AGENT_REGISTRY) {
    assert.ok(!seen.has(agent.id), `duplicate agent id: ${agent.id}`);
    seen.add(agent.id);
  }
}

async function testPremiumTargetsMapToExpectedAgents(): Promise<void> {
  // The three premium targets must each have exactly one entry with
  // their respective exportTarget set.
  const premiumEntries = AGENT_REGISTRY.filter((a) => a.exportTarget !== null);
  assert.equal(premiumEntries.length, 3, "expected exactly 3 premium entries");

  const byTarget = new Map(premiumEntries.map((e) => [e.exportTarget, e]));
  assert.ok(byTarget.has("claude"), "missing claude premium entry");
  assert.ok(byTarget.has("codex"), "missing codex premium entry");
  assert.ok(byTarget.has("pi"), "missing pi premium entry");

  assert.equal(byTarget.get("claude")?.id, "claude-code");
  assert.equal(byTarget.get("codex")?.id, "codex");
  assert.equal(byTarget.get("pi")?.id, "pi");
}

async function testIsKnownAgentTypeGuard(): Promise<void> {
  assert.ok(isKnownAgent("claude-code"));
  assert.ok(isKnownAgent("codex"));
  assert.ok(isKnownAgent("pi"));
  assert.ok(isKnownAgent("cursor"));
  assert.ok(isKnownAgent("windsurf"));
  assert.ok(!isKnownAgent("not-an-agent"));
  assert.ok(!isKnownAgent(""));
  assert.ok(!isKnownAgent("Claude-Code")); // case-sensitive
}

async function testGetAgentById(): Promise<void> {
  const claude = getAgentById("claude-code");
  assert.ok(claude);
  assert.equal(claude.label, "Claude Code");
  assert.equal(claude.skillsDir, ".claude/skills");
  assert.equal(claude.exportTarget, "claude");

  const cursor = getAgentById("cursor");
  assert.ok(cursor);
  assert.equal(cursor.label, "Cursor");
  assert.equal(cursor.skillsDir, ".agents/skills");
  assert.equal(cursor.exportTarget, null);

  assert.equal(getAgentById("nonexistent" as AgentId), undefined);
}

async function testGetUniqueSkillsDirsDeduplicates(): Promise<void> {
  // Codex and Cursor both use .agents/skills; passing both should yield
  // a single entry. Claude Code uses .claude/skills and Pi uses
  // .pi/skills — both unique.
  const dirs = getUniqueSkillsDirs(["codex", "cursor", "claude-code", "pi"]);
  assert.deepEqual(dirs, [".agents/skills", ".claude/skills", ".pi/skills"]);

  // Empty input → empty output.
  assert.deepEqual(getUniqueSkillsDirs([]), []);

  // Unknown IDs are silently dropped.
  assert.deepEqual(
    getUniqueSkillsDirs(["codex", "bogus" as AgentId]),
    [".agents/skills"],
  );
}

async function testGetPremiumTargets(): Promise<void> {
  // Three premium targets, all unique.
  const targets = getPremiumTargets(["claude-code", "codex", "pi"]);
  assert.deepEqual(targets, ["claude", "codex", "pi"]);

  // Only non-premium agents → empty list.
  assert.deepEqual(getPremiumTargets(["cursor", "windsurf", "opencode"]), []);

  // Mix: only the premium subset comes back.
  const mixed = getPremiumTargets(["codex", "cursor", "claude-code", "windsurf"]);
  assert.deepEqual(mixed, ["codex", "claude"]);

  // Unknown IDs are silently dropped.
  assert.deepEqual(
    getPremiumTargets(["bogus" as AgentId, "codex"]),
    ["codex"],
  );
}

async function testDefaultAgentIds(): Promise<void> {
  assert.deepEqual(DEFAULT_AGENT_IDS, ["claude-code", "codex", "pi"]);
  for (const id of DEFAULT_AGENT_IDS) {
    assert.ok(isKnownAgent(id), `default ID ${id} is not in registry`);
    const agent = getAgentById(id);
    assert.ok(agent?.exportTarget, `default ID ${id} has no premium exportTarget`);
  }
}

async function testRegistryIsNonTrivial(): Promise<void> {
  // Sanity: the registry has enough agents to be useful (matches the
  // vercel-labs/skills source of truth at ~73 entries).
  assert.ok(
    AGENT_REGISTRY.length >= 50,
    `registry has ${AGENT_REGISTRY.length} entries; expected >= 50`,
  );
}

async function main(): Promise<void> {
  await testAllEntriesHaveValidShape();
  await testNoDuplicateIds();
  await testPremiumTargetsMapToExpectedAgents();
  await testIsKnownAgentTypeGuard();
  await testGetAgentById();
  await testGetUniqueSkillsDirsDeduplicates();
  await testGetPremiumTargets();
  await testDefaultAgentIds();
  await testRegistryIsNonTrivial();
  // eslint-disable-next-line no-console
  console.log("agent-registry.test.ts: all 9 checks passed");
}

await main();