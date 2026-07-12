import assert from "node:assert/strict";
import * as fs from "node:fs";

const brownfield = fs.readFileSync("src/core/runs/brownfield-run.ts", "utf8");
const mapFacade = fs.readFileSync("src/core/audit/write-map-tool.ts", "utf8");
const mapStorage = fs.readFileSync("src/core/audit/map-storage.ts", "utf8");
const mapTools = fs.readFileSync("src/core/audit/write-map-tools.ts", "utf8");
const legacyMap = fs.readFileSync("src/core/audit/legacy-write-map.ts", "utf8");
const rendererFacade = fs.readFileSync("src/core/artifacts/renderers.ts", "utf8");
const rendererContext = fs.readFileSync("src/core/artifacts/renderers/context.ts", "utf8");

assert.doesNotMatch(brownfield, /setMapSessionStateDir/);
assert.doesNotMatch(brownfield, /setRendererStateDir/);
assert.match(brownfield, /createWriteMapTools\(\{ stateDir \}\)/);
assert.match(brownfield, /mapTools\.writeMapTool/);
assert.match(brownfield, /mapTools\.writeMapDeltaTool/);
assert.match(brownfield, /renderValidatedBrownfieldArtifacts\(map, \{ stateDir \}\)/);

assert.match(mapFacade, /Compatibility façade/);
assert.match(mapFacade, /from "\.\/write-map-tools\.ts"/);
assert.match(mapStorage, /AsyncLocalStorage<MapToolExecutionContext>/);
assert.match(mapTools, /export function createWriteMapTools/);
assert.match(legacyMap, /@deprecated Production callers must use/);
assert.match(rendererFacade, /export \* from "\.\/renderers\/index\.ts"/);
assert.match(rendererContext, /@deprecated Pass an explicit RenderContext/);
assert.doesNotMatch(rendererContext, /stateDirFor\(\)/);

console.log("production state-context ownership tests passed.");
