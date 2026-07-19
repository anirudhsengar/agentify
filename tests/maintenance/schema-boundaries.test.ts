import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const AUDIT_ROOT = path.join(REPO_ROOT, "src/core/audit");
const SCHEMA_ROOT = path.join(AUDIT_ROOT, "schema");

const EXPECTED_SCHEMA_FILES = [
  "artifact-intents.ts",
  "codebase-map.ts",
  "conventions.ts",
  "coverage.ts",
  "evidence.ts",
  "index.ts",
  "meta.ts",
  "module-graph.ts",
  "operational-surface.ts",
  "pitfalls.ts",
  "primitives.ts",
  "security-surface.ts",
  "skeleton.ts",
  "type-contract.ts",
  "validation-surface.ts",
  "write-map-params.ts",
] as const;

type SchemaFile = (typeof EXPECTED_SCHEMA_FILES)[number];

interface PackageJson {
  files?: string[];
  exports?: Record<string, string>;
}

const ALLOWED_SCHEMA_IMPORTS: ReadonlyMap<SchemaFile, readonly SchemaFile[]> = new Map([
  ["artifact-intents.ts", ["primitives.ts"]],
  ["codebase-map.ts", [
    "artifact-intents.ts",
    "conventions.ts",
    "coverage.ts",
    "evidence.ts",
    "meta.ts",
    "module-graph.ts",
    "operational-surface.ts",
    "pitfalls.ts",
    "primitives.ts",
    "security-surface.ts",
    "skeleton.ts",
    "type-contract.ts",
    "validation-surface.ts",
  ]],
  ["conventions.ts", []],
  ["coverage.ts", ["primitives.ts"]],
  ["evidence.ts", []],
  ["index.ts", [
    "artifact-intents.ts",
    "codebase-map.ts",
    "evidence.ts",
    "primitives.ts",
    "write-map-params.ts",
  ]],
  ["meta.ts", []],
  ["module-graph.ts", []],
  ["operational-surface.ts", []],
  ["pitfalls.ts", []],
  ["primitives.ts", []],
  ["security-surface.ts", []],
  ["skeleton.ts", []],
  ["type-contract.ts", []],
  ["validation-surface.ts", []],
  ["write-map-params.ts", []],
]);

const ALLOWED_EXTERNAL_RELATIVE_IMPORTS: ReadonlyMap<SchemaFile, readonly string[]> = new Map([
  ["codebase-map.ts", ["../coverage.ts"]],
  ["write-map-params.ts", ["../coverage.ts"]],
]);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gs;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticImport)) specifiers.push(match[1]);
  for (const match of source.matchAll(dynamicImport)) specifiers.push(match[1]);
  return specifiers;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

test("audit-map TypeBox declarations have explicit domain owners", () => {
  const schemaFiles = fs.readdirSync(SCHEMA_ROOT)
    .filter((entry) => entry.endsWith(".ts"))
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(schemaFiles, EXPECTED_SCHEMA_FILES);

  const facade = read("src/core/audit/schema.ts");
  assert.doesNotMatch(facade, /from ["']typebox(?:\/[^"']*)?["']/);
  assert.doesNotMatch(facade, /from ["']@earendil-works\/pi-ai["']/);
  assert.doesNotMatch(facade, /\bType\./);
  assert.doesNotMatch(facade, /\bStringEnum\s*\(/);
  assert.doesNotMatch(facade, /\b(?:const|let|var)\s+\w+Schema\s*=/);
  assert.match(facade, /from ["']\.\/schema\/index\.ts["']/);

  const index = read("src/core/audit/schema/index.ts");
  assert.doesNotMatch(index, /from ["']typebox(?:\/[^"']*)?["']/);
  assert.doesNotMatch(index, /\bType\./);
  assert.doesNotMatch(index, /\bStringEnum\s*\(/);
  assert.doesNotMatch(index, /\b(?:const|let|var)\s+\w+Schema\s*=/);

  for (const algorithm of ["coverage.ts", "map-defaults.ts", "schema-compatibility.ts"]) {
    const source = fs.readFileSync(path.join(AUDIT_ROOT, algorithm), "utf8");
    assert.doesNotMatch(source, /from ["']typebox(?:\/[^"']*)?["']/, `${algorithm} must stay algorithm-only`);
    assert.doesNotMatch(source, /\bType\./, `${algorithm} must not declare TypeBox schemas`);
    assert.doesNotMatch(source, /\bStringEnum\s*\(/, `${algorithm} must not declare enum schemas`);
  }
});

test("schema module imports follow the downward-only ownership graph", () => {
  for (const file of EXPECTED_SCHEMA_FILES) {
    const source = fs.readFileSync(path.join(SCHEMA_ROOT, file), "utf8");
    const relativeImports = importSpecifiers(source).filter((specifier) => specifier.startsWith("."));
    const localSchemaImports: string[] = [];
    const externalRelativeImports: string[] = [];

    for (const specifier of relativeImports) {
      const resolved = path.resolve(SCHEMA_ROOT, path.dirname(file), specifier);
      const relativeToSchema = path.relative(SCHEMA_ROOT, resolved).split(path.sep).join("/");
      if (!relativeToSchema.startsWith("../") && !path.isAbsolute(relativeToSchema)) {
        localSchemaImports.push(relativeToSchema);
      } else {
        externalRelativeImports.push(specifier);
      }
    }

    assert.deepEqual(
      sorted(new Set(localSchemaImports)),
      sorted(ALLOWED_SCHEMA_IMPORTS.get(file) ?? []),
      `${file} crossed its declared schema ownership boundary`,
    );
    assert.deepEqual(
      sorted(new Set(externalRelativeImports)),
      sorted(ALLOWED_EXTERNAL_RELATIVE_IMPORTS.get(file) ?? []),
      `${file} introduced an undeclared upward or lateral dependency`,
    );
  }
});

test("package confinement remains unchanged by schema ownership enforcement", () => {
  const packageJson = JSON.parse(read("package.json")) as PackageJson;
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
  assert.ok(!(packageJson.files ?? []).includes("src"), "raw source must remain unpublished");
});
