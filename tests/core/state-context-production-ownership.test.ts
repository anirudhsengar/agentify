import assert from "node:assert/strict";
import * as fs from "node:fs";

const brownfield = fs.readFileSync("src/core/runs/brownfield-run.ts", "utf8");
const mapFacade = fs.readFileSync("src/core/audit/write-map-tool.ts", "utf8");
const mapStorage = fs.readFileSync("src/core/audit/map-storage.ts", "utf8");
const mapTools = fs.readFileSync("src/core/audit/write-map-tools.ts", "utf8");
const rendererFacade = fs.readFileSync("src/core/artifacts/renderers.ts", "utf8");
const rendererContext = fs.readFileSync("src/core/artifacts/renderers/context.ts", "utf8");

assert.doesNotMatch(brownfield, /setMapSessionStateDir/);
assert.doesNotMatch(brownfield, /setRendererStateDir/);
assert.match(brownfield, /createWriteMapTools\(\{ stateDir \}\)/);
assert.match(brownfield, /mapTools\.writeMapTool/);
assert.match(brownfield, /mapTools\.writeMapDeltaTool/);
assert.match(brownfield, /renderValidatedBrownfieldArtifacts\(map, \{ stateDir \}\)/);

assert.match(mapFacade, /Stable internal façade/);
assert.match(mapFacade, /from "\.\/write-map-tools\.ts"/);
assert.doesNotMatch(mapFacade, /writeMapTool[,\s}]/);
assert.doesNotMatch(mapStorage, /AsyncLocalStorage|currentSessionStateDir|LEGACY_/);
assert.match(mapStorage, /context: MapToolExecutionContext/);
assert.match(mapTools, /export function createWriteMapTools/);
assert.doesNotMatch(mapTools, /export const writeMapTool|export const writeMapDeltaTool/);
assert.match(rendererFacade, /export \* from "\.\/renderers\/index\.ts"/);
assert.doesNotMatch(rendererContext, /setRendererStateDir|legacyRendererStateDir|stateDirFor\(\)/);
assert.match(rendererContext, /resolveRenderContext\(context: RenderContext\)/);
assert.equal(fs.existsSync("src/core/audit/legacy-write-map.ts"), false);

console.log("production state-context ownership tests passed.");
