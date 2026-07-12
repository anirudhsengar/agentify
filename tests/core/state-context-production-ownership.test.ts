import assert from "node:assert/strict";
import * as fs from "node:fs";

const brownfield = fs.readFileSync("src/core/runs/brownfield-run.ts", "utf8");
const mapTool = fs.readFileSync("src/core/audit/write-map-tool.ts", "utf8");
const renderers = fs.readFileSync("src/core/artifacts/renderers.ts", "utf8");

assert.doesNotMatch(brownfield, /setMapSessionStateDir/);
assert.doesNotMatch(brownfield, /setRendererStateDir/);
assert.match(brownfield, /createWriteMapTools\(\{ stateDir \}\)/);
assert.match(brownfield, /mapTools\.writeMapTool/);
assert.match(brownfield, /mapTools\.writeMapDeltaTool/);
assert.match(brownfield, /renderValidatedBrownfieldArtifacts\(map, \{ stateDir \}\)/);

assert.match(mapTool, /AsyncLocalStorage<MapToolExecutionContext>/);
assert.match(mapTool, /export function createWriteMapTools/);
assert.match(mapTool, /@deprecated Production callers must use/);
assert.match(renderers, /export interface RenderContext/);
assert.match(renderers, /@deprecated Pass an explicit RenderContext/);
assert.doesNotMatch(renderers, /stateDirFor\(\)/);

console.log("production state-context ownership tests passed.");
