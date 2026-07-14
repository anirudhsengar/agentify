import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

const SUPPORTED_STATE_CONSUMERS = [
  "src/core/agentify-app.ts",
  "src/core/cli-commands.ts",
  "src/core/repo-status.ts",
  "src/core/revert.ts",
  "src/core/runs/brownfield-run.ts",
  "src/core/runs/greenfield-run.ts",
] as const;

const FORBIDDEN_COMPATIBILITY_CALLS = [
  "setMapSessionStateDir",
  "setRendererStateDir",
  "canonicalMapPath",
  "loadCanonicalMap",
  "verifyManifest",
  "readManifest",
  "writeManifest",
  "manifestPath",
] as const;

const REMOVED_EXPORT_NAMES = [
  "setMapSessionStateDir",
  "setRendererStateDir",
  "writeMapTool",
  "writeMapDeltaTool",
  "canonicalMapPath",
  "loadCanonicalMap",
  "manifestPath",
  "readManifest",
  "writeManifest",
  "verifyManifest",
  "greenfieldStatePath",
  "readGreenfieldState",
  "writeGreenfieldState",
  "greenfieldFormationPath",
  "readGreenfieldFormation",
  "writeGreenfieldFormation",
] as const;

const REMOVED_CONSTANT_NAMES = [
  "DRAFT_PATH",
  "HISTORY_DIR",
  "CANONICAL_MAP_PATH",
  "MANIFEST_RELATIVE_PATH",
  "CODEBASE_MAP_RELATIVE_PATH",
  "GREENFIELD_STATE_RELATIVE_PATH",
  "GREENFIELD_FORMATION_RELATIVE_PATH",
] as const;

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(absolute));
    else if (entry.isFile() && /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) result.push(absolute);
  }
  return result;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

function importedNames(source: string, moduleFragment: string): Set<string> {
  const names = new Set<string>();
  const imports = source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g);
  for (const match of imports) {
    if (!match[2]!.includes(moduleFragment)) continue;
    for (const raw of match[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return names;
}

test("supported production state consumers do not call deprecated compatibility APIs", () => {
  for (const relativePath of SUPPORTED_STATE_CONSUMERS) {
    const source = read(relativePath);
    for (const name of FORBIDDEN_COMPATIBILITY_CALLS) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${name}\\s*\\(`),
        `${relativePath} must use an explicit state-dir API instead of ${name}`,
      );
    }
  }
});

test("supported production code does not import singleton write-map tools", () => {
  for (const relativePath of SUPPORTED_STATE_CONSUMERS) {
    const imports = importedNames(read(relativePath), "write-map-tool");
    assert.equal(
      imports.has("writeMapTool"),
      false,
      `${relativePath} must use createWriteMapTools instead of singleton writeMapTool`,
    );
    assert.equal(
      imports.has("writeMapDeltaTool"),
      false,
      `${relativePath} must use createWriteMapTools instead of singleton writeMapDeltaTool`,
    );
  }
});

test("brownfield orchestration captures state in factories and renderer contexts", () => {
  const source = read("src/core/runs/brownfield-run.ts");
  assert.match(source, /createWriteMapTools\(\{\s*stateDir\s*\}\)/);
  assert.match(source, /renderValidatedBrownfieldArtifacts\(map,\s*\{\s*stateDir\s*\}\)/);
  assert.match(source, /spawnExplorerStateDir:\s*stateDir/);
});

test("attach, status, recovery, and revert pass or discover explicit state directories", () => {
  const app = read("src/core/agentify-app.ts");
  assert.match(app, /const resolved = await resolveTargets\(options\)/);
  assert.match(app, /resolveCanonicalStateDir\([\s\S]*?resolved\.targets/);
  assert.match(app, /inspectAgentifyRepoState\([\s\S]*?stateResolution\.relativeDir/);

  const status = read("src/core/repo-status.ts");
  assert.match(status, /verifyManifestAt\(cwd,\s*stateDir\)/);
  assert.match(status, /requiredBrownfieldFiles\(stateDir\)/);

  const commands = read("src/core/cli-commands.ts");
  assert.match(commands, /recoverInterruptedStateTransactions\(ctx\.cwd\)/);
  assert.match(commands, /discoverExistingStateDir\(ctx\.cwd\)/);

  const revert = read("src/core/revert.ts");
  assert.match(revert, /const stateDir = options\.stateDir/);
  assert.match(revert, /readManifestAt\(options\.cwd,\s*stateDir\)/);
});

test("removed compatibility exports cannot return anywhere in production source", () => {
  const productionFiles = sourceFiles(path.join(REPO_ROOT, "src"));
  for (const absolutePath of productionFiles) {
    const relativePath = path.relative(REPO_ROOT, absolutePath);
    const source = fs.readFileSync(absolutePath, "utf-8");
    for (const name of REMOVED_EXPORT_NAMES) {
      assert.doesNotMatch(
        source,
        new RegExp(`export\s+(?:async\s+)?(?:const|let|var|function)\s+${name}\b`),
        `${relativePath} must not reintroduce removed callable export ${name}`,
      );
      assert.doesNotMatch(
        source,
        new RegExp(`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from`, "s"),
        `${relativePath} must not import removed compatibility symbol ${name}`,
      );
    }
    for (const name of REMOVED_CONSTANT_NAMES) {
      assert.doesNotMatch(
        source,
        new RegExp(`export\s+(?:const|let|var)\s+${name}\b`),
        `${relativePath} must not reintroduce removed path constant ${name}`,
      );
    }
  }
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "src/core/audit/legacy-write-map.ts")),
    false,
    "the removed legacy write-map compatibility module must stay absent",
  );
});

test("write-map storage and renderer context contain no mutable process-global state", () => {
  const storage = read("src/core/audit/map-storage.ts");
  assert.doesNotMatch(storage, /AsyncLocalStorage|currentSessionStateDir|legacyMapContext/);
  assert.doesNotMatch(storage, /(?:let|var)\s+\w*stateDir\b/i);

  const rendererContext = read("src/core/artifacts/renderers/context.ts");
  assert.doesNotMatch(rendererContext, /legacyRendererStateDir|setRendererStateDir/);
  assert.doesNotMatch(rendererContext, /(?:let|var)\s+\w*stateDir\b/i);
  assert.match(rendererContext, /resolveRenderContext\(context:\s*RenderContext\)/);
});
