import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DRAFT_PATH,
  setMapSessionStateDir,
  writeMapTool,
} from "../../src/core/audit/write-map-tool.ts";
import {
  renderValidatedBrownfieldArtifacts,
  setRendererStateDir,
} from "../../src/core/artifacts/renderers.ts";
import { LEGACY_PI_STATE_RELATIVE_DIR } from "../../src/core/state-dir.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function writeMapAt(cwd: string, stateDir: string): Promise<string> {
  setMapSessionStateDir(stateDir);
  const result = await writeMapTool.execute(
    `write-${stateDir}`,
    { map: makeValidCodebaseMap() } as never,
    undefined,
    undefined,
    { cwd } as never,
  );
  assert.equal(isToolError(result), false);
  const details = result.details as { path?: string } | undefined;
  assert.ok(details?.path);
  return details.path;
}

async function testLegacyMapToolSetterControlsCanonicalWrites(): Promise<void> {
  const cwd = tempDir("legacy-map-state");
  try {
    const claudePath = await writeMapAt(cwd, ".claude/agentify");
    const codexPath = await writeMapAt(cwd, ".codex/agentify");

    assert.equal(claudePath, path.join(cwd, ".claude/agentify", "codebase_map.json"));
    assert.equal(codexPath, path.join(cwd, ".codex/agentify", "codebase_map.json"));
    assert.ok(fs.existsSync(claudePath));
    assert.ok(fs.existsSync(codexPath));
  } finally {
    setMapSessionStateDir(LEGACY_PI_STATE_RELATIVE_DIR);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testLegacyRendererSetterControlsOneArgumentWrapper(): void {
  const map = makeValidCodebaseMap();
  delete map.artifact_intents;
  map.meta.suggested_subagent_domains = ["payments"];

  try {
    setRendererStateDir(".claude/agentify");
    const claude = renderValidatedBrownfieldArtifacts(map);
    assert.equal(claude.errors.length, 0, claude.errors.join("\n"));
    assert.ok(
      claude.artifacts.some((artifact) => artifact.relativePath === ".claude/agentify/agents/payments.md"),
    );

    setRendererStateDir(".codex/agentify");
    const codex = renderValidatedBrownfieldArtifacts(map);
    assert.equal(codex.errors.length, 0, codex.errors.join("\n"));
    assert.ok(
      codex.artifacts.some((artifact) => artifact.relativePath === ".codex/agentify/agents/payments.md"),
    );
  } finally {
    setRendererStateDir(".pi");
  }
}

function testLegacyDraftConstantRemainsProviderAgnostic(): void {
  assert.equal(
    DRAFT_PATH,
    path.join(LEGACY_PI_STATE_RELATIVE_DIR, ".agentify", "draft.json"),
    "deprecated draft constants remain pinned to the legacy Pi state tree",
  );
}

await testLegacyMapToolSetterControlsCanonicalWrites();
testLegacyRendererSetterControlsOneArgumentWrapper();
testLegacyDraftConstantRemainsProviderAgnostic();
console.log("legacy state-directory characterization tests passed.");
