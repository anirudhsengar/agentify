import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWriteMapTools, loadCanonicalMapAt } from "../../src/core/audit/write-map-tool.ts";
import { renderValidatedBrownfieldArtifacts } from "../../src/core/artifacts/renderers.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

async function testPiCanonicalStateUsesExplicitFactory(): Promise<void> {
  const cwd = tempDir("pi-explicit-state");
  const tools = createWriteMapTools({ stateDir: ".pi/agentify" });
  try {
    const result = await tools.writeMapTool.execute(
      "write-pi",
      { map: makeValidCodebaseMap() } as never,
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.ok(fs.existsSync(tools.canonicalMapPath(cwd)));
    assert.ok(loadCanonicalMapAt(cwd, ".pi/agentify"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRendererRequiresExplicitContext(): void {
  const map = makeValidCodebaseMap();
  delete map.artifact_intents;
  map.meta.suggested_subagent_domains = ["payments"];
  const rendered = renderValidatedBrownfieldArtifacts(map, { stateDir: ".pi" });
  assert.equal(rendered.errors.length, 0, rendered.errors.join("\n"));
  assert.ok(rendered.artifacts.some((artifact) => artifact.relativePath === ".pi/agents/payments.md"));
}

async function testRemovedExportsStayAbsent(): Promise<void> {
  const mapFacade = await import("../../src/core/audit/write-map-tool.ts") as Record<string, unknown>;
  const renderers = await import("../../src/core/artifacts/renderers.ts") as Record<string, unknown>;
  for (const name of [
    "writeMapTool", "writeMapDeltaTool", "setMapSessionStateDir",
    "AGENTIFY_OUTPUT_DIR", "MAP_FILENAME", "DRAFT_DIR", "DRAFT_PATH",
    "DRAFT_TRANSPORT_DIR", "HISTORY_DIR", "canonicalMapPath", "loadCanonicalMap",
  ]) assert.equal(name in mapFacade, false, `${name} must remain removed`);
  assert.equal("setRendererStateDir" in renderers, false);
}

await testPiCanonicalStateUsesExplicitFactory();
testRendererRequiresExplicitContext();
await testRemovedExportsStayAbsent();
console.log("deprecated state API removal tests passed.");
