import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodebaseMapSchema,
  PartialCodebaseMapSchema,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
} from "../../src/core/audit/schema.ts";
import * as schemaIndex from "../../src/core/audit/schema/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

assert.strictEqual(CodebaseMapSchema, schemaIndex.CodebaseMapSchema);
assert.strictEqual(PartialCodebaseMapSchema, schemaIndex.PartialCodebaseMapSchema);
assert.strictEqual(WriteMapParamsSchema, schemaIndex.WriteMapParamsSchema);
assert.strictEqual(WriteMapDeltaParamsSchema, schemaIndex.WriteMapDeltaParamsSchema);

const facade = fs.readFileSync(path.join(REPO_ROOT, "src/core/audit/schema.ts"), "utf8");
const index = fs.readFileSync(path.join(REPO_ROOT, "src/core/audit/schema/index.ts"), "utf8");
const composition = fs.readFileSync(
  path.join(REPO_ROOT, "src/core/audit/schema/codebase-map.ts"),
  "utf8",
);
const parameters = fs.readFileSync(
  path.join(REPO_ROOT, "src/core/audit/schema/write-map-params.ts"),
  "utf8",
);

assert.doesNotMatch(facade, /from ["']typebox(?:\/[^"']*)?["']/);
assert.doesNotMatch(facade, /\bType\./);
assert.doesNotMatch(facade, /\bStringEnum\s*\(/);
assert.doesNotMatch(index, /from ["']typebox(?:\/[^"']*)?["']/);
assert.doesNotMatch(index, /\bType\./);
assert.match(composition, /export const CodebaseMapSchema = Type\.Object/);
assert.match(composition, /export const PartialCodebaseMapSchema = Type\.Object/);
assert.match(parameters, /export const WriteMapParamsSchema = Type\.Object/);
assert.match(parameters, /export const WriteMapDeltaParamsSchema = Type\.Object/);

console.log("schema composition boundary tests passed.");
