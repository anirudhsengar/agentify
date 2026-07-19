import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWriteMapTools } from "../../src/core/audit/write-map-tool.ts";
import { LEGACY_PI_STATE_RELATIVE_DIR } from "../../src/core/state-dir.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

function oversizedMap(label: string) {
  const map = makeValidCodebaseMap();
  map.meta.domain_hypothesis = `${label}:${"x".repeat(110_000)}`;
  return map;
}

function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function resultDetails(result: unknown): {
  path?: string;
  source_path?: string;
} {
  return (result as { details?: { path?: string; source_path?: string } }).details ?? {};
}

async function executeOversized(
  tool: ReturnType<typeof createWriteMapTools>["writeMapTool"],
  cwd: string,
  label: string,
) {
  return tool.execute(
    `draft-${label}`,
    { map: oversizedMap(label), mode: "auto" } as never,
    undefined,
    undefined,
    { cwd } as never,
  );
}

function assertNoAtomicTemps(draftDir: string): void {
  const leftovers = fs.existsSync(draftDir)
    ? fs.readdirSync(draftDir).filter((name) => name.endsWith(".tmp"))
    : [];
  assert.deepEqual(leftovers, []);
}

async function testProviderFactoriesUseTheirConfiguredDraftPath(): Promise<void> {
  for (const stateDir of [".claude/agentify", ".agents/agentify", ".pi/agentify"]) {
    const cwd = tempDir(`draft-${stateDir.replace(/[^a-z]/g, "-")}`);
    const tools = createWriteMapTools({ stateDir });
    const expectedRelative = path.join(stateDir, ".agentify", "draft.json").replace(/\\/g, "/");
    const expectedAbsolute = path.join(cwd, stateDir, ".agentify", "draft.json");
    try {
      assert.equal(tools.draftDirectoryRelative, path.join(stateDir, ".agentify").replace(/\\/g, "/"));
      assert.equal(tools.draftPathRelative, expectedRelative);

      const result = await executeOversized(tools.writeMapTool, cwd, stateDir);
      assert.equal(isToolError(result), false);
      assert.equal(resultDetails(result).path, tools.canonicalMapPath(cwd));
      assert.equal(resultDetails(result).source_path, `auto-fallback:${expectedAbsolute}`);
      assert.ok(fs.existsSync(expectedAbsolute));
      assert.ok(fs.existsSync(tools.canonicalMapPath(cwd)));

      const persistedDraft = JSON.parse(fs.readFileSync(expectedAbsolute, "utf8"));
      assert.ok(persistedDraft.meta.domain_hypothesis.startsWith(`${stateDir}:`));
      assertNoAtomicTemps(path.dirname(expectedAbsolute));

      if (stateDir !== LEGACY_PI_STATE_RELATIVE_DIR) {
        assert.equal(fs.existsSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, ".agentify", "draft.json")), false);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

async function testTwoFactoriesDoNotShareDraftTransport(): Promise<void> {
  const cwd = tempDir("draft-two-factories");
  const claude = createWriteMapTools({ stateDir: ".claude/agentify" });
  const agents = createWriteMapTools({ stateDir: ".agents/agentify" });
  try {
    const [claudeResult, agentsResult] = await Promise.all([
      executeOversized(claude.writeMapTool, cwd, "claude"),
      executeOversized(agents.writeMapTool, cwd, "agents"),
    ]);
    assert.equal(isToolError(claudeResult), false);
    assert.equal(isToolError(agentsResult), false);

    const claudeDraft = path.join(cwd, claude.draftPathRelative);
    const agentsDraft = path.join(cwd, agents.draftPathRelative);
    assert.ok(JSON.parse(fs.readFileSync(claudeDraft, "utf8")).meta.domain_hypothesis.startsWith("claude:"));
    assert.ok(JSON.parse(fs.readFileSync(agentsDraft, "utf8")).meta.domain_hypothesis.startsWith("agents:"));
    assert.equal(fs.existsSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, ".agentify", "draft.json")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testExistingLegacyDraftIsNotReadOrOverwritten(): Promise<void> {
  const cwd = tempDir("draft-legacy-present");
  const tools = createWriteMapTools({ stateDir: ".claude/agentify" });
  const legacyDraft = path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, ".agentify", "draft.json");
  const legacyContent = '{"legacy":"leave untouched"}\n';
  try {
    fs.mkdirSync(path.dirname(legacyDraft), { recursive: true });
    fs.writeFileSync(legacyDraft, legacyContent, { mode: 0o600 });

    const result = await executeOversized(tools.writeMapTool, cwd, "provider-wins");
    assert.equal(isToolError(result), false);
    assert.equal(fs.readFileSync(legacyDraft, "utf8"), legacyContent);
    assert.ok(fs.existsSync(path.join(cwd, tools.draftPathRelative)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testPartialOversizedEvidenceUsesScopedDraftAndCleansAtomicTemp(): Promise<void> {
  const cwd = tempDir("draft-partial-evidence");
  const tools = createWriteMapTools({ stateDir: ".agents/agentify" });
  const invalid = oversizedMap("invalid") as unknown as Record<string, unknown>;
  delete invalid.coverage;
  try {
    const result = await tools.writeMapTool.execute(
      "invalid-draft",
      { map: invalid, mode: "auto" } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal(isToolError(result), false);
    const draftPath = path.join(cwd, tools.draftPathRelative);
    assert.ok(fs.existsSync(draftPath));
    assert.equal(fs.existsSync(tools.canonicalMapPath(cwd)), true);
    assert.equal(fs.existsSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, ".agentify", "draft.json")), false);
    assertNoAtomicTemps(path.dirname(draftPath));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}


await testProviderFactoriesUseTheirConfiguredDraftPath();
await testTwoFactoriesDoNotShareDraftTransport();
await testExistingLegacyDraftIsNotReadOrOverwritten();
await testPartialOversizedEvidenceUsesScopedDraftAndCleansAtomicTemp();
console.log("provider-scoped draft transport tests passed.");
