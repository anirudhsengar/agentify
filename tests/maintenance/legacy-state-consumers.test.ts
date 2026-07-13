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
