import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWriteMapTools } from "../../src/core/audit/write-map-tool.ts";
import { renderValidatedBrownfieldArtifacts } from "../../src/core/artifacts/renderers.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function executeWrite(
  tool: ReturnType<typeof createWriteMapTools>["writeMapTool"],
  cwd: string,
  hypothesis: string,
) {
  const map = makeValidCodebaseMap();
  map.meta.domain_hypothesis = hypothesis;
  return tool.execute(
    hypothesis,
    { map } as never,
    undefined,
    undefined,
    { cwd } as never,
  );
}

async function testFactoryPathsAndSameProcessIsolation(): Promise<void> {
  const cwd = tempDir("map-factory-isolation");
  const claude = createWriteMapTools({ stateDir: ".claude/agentify" });
  const codex = createWriteMapTools({ stateDir: ".codex/agentify" });
  try {
    assert.equal(claude.canonicalMapRelative, ".claude/agentify/codebase_map.json");
    assert.equal(claude.draftDirectoryRelative, ".claude/agentify/.agentify");
    assert.equal(claude.draftPathRelative, ".claude/agentify/.agentify/draft.json");
    assert.equal(claude.historyRelative, ".claude/agentify/history");
    assert.equal(
      claude.canonicalMapPath(cwd),
      path.join(cwd, ".claude/agentify", "codebase_map.json"),
    );

    const [claudeResult, codexResult] = await Promise.all([
      executeWrite(claude.writeMapTool, cwd, "claude isolated"),
      executeWrite(codex.writeMapTool, cwd, "codex isolated"),
    ]);
    assert.equal(isToolError(claudeResult), false);
    assert.equal(isToolError(codexResult), false);

    const claudeMap = JSON.parse(fs.readFileSync(claude.canonicalMapPath(cwd), "utf8"));
    const codexMap = JSON.parse(fs.readFileSync(codex.canonicalMapPath(cwd), "utf8"));
    assert.equal(claudeMap.meta.domain_hypothesis, "claude isolated");
    assert.equal(codexMap.meta.domain_hypothesis, "codex isolated");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testThrownExecutionDoesNotLeakIntoAnotherFactory(): Promise<void> {
  const cwd = tempDir("map-factory-throw");
  const failed = createWriteMapTools({ stateDir: ".claude/agentify" });
  const healthy = createWriteMapTools({ stateDir: ".codex/agentify" });
  try {
    const throwingParams = new Proxy({}, {
      get(): never {
        throw new Error("intentional factory execution failure");
      },
    });
    await assert.rejects(
      () => failed.writeMapTool.execute(
        "throwing-run",
        throwingParams as never,
        undefined,
        undefined,
        { cwd } as never,
      ),
      /intentional factory execution failure/,
    );

    const result = await executeWrite(healthy.writeMapTool, cwd, "healthy after throw");
    assert.equal(isToolError(result), false);
    assert.ok(fs.existsSync(healthy.canonicalMapPath(cwd)));
    assert.ok(!fs.existsSync(failed.canonicalMapPath(cwd)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testExplicitRendererContextsAreIsolated(): void {
  const map = makeValidCodebaseMap();
  delete map.artifact_intents;
  map.meta.suggested_subagent_domains = ["payments"];

    const claude = renderValidatedBrownfieldArtifacts(map, { stateDir: ".claude/agentify" });
    const codex = renderValidatedBrownfieldArtifacts(map, { stateDir: ".codex/agentify" });
    assert.equal(claude.errors.length, 0, claude.errors.join("\n"));
    assert.equal(codex.errors.length, 0, codex.errors.join("\n"));
    assert.ok(claude.artifacts.some((artifact) => artifact.relativePath === ".claude/agentify/agents/payments.md"));
    assert.ok(codex.artifacts.some((artifact) => artifact.relativePath === ".codex/agentify/agents/payments.md"));
    assert.ok(!claude.artifacts.some((artifact) => artifact.relativePath.startsWith(".codex/agentify/")));
    assert.ok(!codex.artifacts.some((artifact) => artifact.relativePath.startsWith(".claude/agentify/")));
}

await testFactoryPathsAndSameProcessIsolation();
await testThrownExecutionDoesNotLeakIntoAnotherFactory();
testExplicitRendererContextsAreIsolated();
console.log("explicit state-directory isolation tests passed.");
