import assert from "node:assert/strict";
import * as fs from "node:fs";

const repositoryAudit = fs.readFileSync("src/core/runs/repository-audit-run.ts", "utf8");
const mapFacade = fs.readFileSync("src/core/audit/write-map-tool.ts", "utf8");
const mapStorage = fs.readFileSync("src/core/audit/map-storage.ts", "utf8");
const mapTools = fs.readFileSync("src/core/audit/write-map-tools.ts", "utf8");
const auditPaths = fs.readFileSync("src/core/audit/paths.ts", "utf8");

assert.match(repositoryAudit, /createWriteMapTools\(\{ stateDir \}\)/);
assert.match(repositoryAudit, /mapTools\.writeMapTool/);
assert.match(repositoryAudit, /mapTools\.writeMapDeltaTool/);
assert.match(repositoryAudit, /AUDIT_STATE_RELATIVE_DIR/);
assert.match(auditPaths, /AUDIT_STATE_RELATIVE_DIR = "\.agentify\/runtime\/audit"/);

assert.match(mapFacade, /Stable internal façade/);
assert.match(mapFacade, /from "\.\/write-map-tools\.ts"/);
assert.doesNotMatch(mapFacade, /writeMapTool[,\s}]/);
assert.doesNotMatch(mapStorage, /AsyncLocalStorage|currentSessionStateDir/);
assert.match(mapStorage, /context: MapToolExecutionContext/);
assert.match(mapTools, /export function createWriteMapTools/);
assert.doesNotMatch(mapTools, /export const writeMapTool|export const writeMapDeltaTool/);

console.log("production state-context ownership tests passed.");
