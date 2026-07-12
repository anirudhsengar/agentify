import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
  CodebaseMapSchema,
  PartialCodebaseMapSchema,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
} from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type SchemaName =
  | "codebase_map"
  | "partial_codebase_map"
  | "write_map_params"
  | "write_map_delta_params";

type InputName =
  | "complete_valid"
  | "partial_coverage_only"
  | "complete_missing_meta"
  | "complete_invalid_coverage_status"
  | "empty_object"
  | "minimal_delta";

interface ExpectedError {
  keyword: string;
  instancePath: string;
  requiredProperties?: string[];
}

interface ValidationCase {
  name: string;
  input: InputName;
  schema: SchemaName;
  valid: boolean;
  errors: ExpectedError[];
}

interface ValidationFixture {
  baseline_commit: string;
  normalization: string;
  cases: ValidationCase[];
}

interface ActualError {
  keyword?: string;
  instancePath?: string;
  params?: {
    requiredProperties?: string[];
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "../fixtures/audit-schema-validation-contract.json"), "utf8"),
) as ValidationFixture;

const SCHEMAS = {
  codebase_map: CodebaseMapSchema,
  partial_codebase_map: PartialCodebaseMapSchema,
  write_map_params: WriteMapParamsSchema,
  write_map_delta_params: WriteMapDeltaParamsSchema,
} as const;

function buildInput(name: InputName): unknown {
  const valid = makeValidCodebaseMap();

  switch (name) {
    case "complete_valid":
      return valid;
    case "partial_coverage_only":
      return { coverage: valid.coverage };
    case "complete_missing_meta": {
      const input = structuredClone(valid) as Record<string, unknown>;
      delete input.meta;
      return input;
    }
    case "complete_invalid_coverage_status": {
      const input = structuredClone(valid);
      (input.coverage.D1_topography as { status: string }).status = "unknown";
      return input;
    }
    case "empty_object":
      return {};
    case "minimal_delta":
      return { delta: {} };
  }
}

assert.equal(FIXTURE.normalization, "none-exact-typebox-serialization");
assert.match(FIXTURE.baseline_commit, /^[0-9a-f]{40}$/);

for (const testCase of FIXTURE.cases) {
  const errors = Value.Errors(SCHEMAS[testCase.schema], buildInput(testCase.input)) as ActualError[];
  assert.equal(errors.length === 0, testCase.valid, `${testCase.name}: validity drifted`);
  assert.equal(
    errors.length,
    testCase.errors.length,
    `${testCase.name}: validation error count or ordering drifted`,
  );

  for (const [index, expected] of testCase.errors.entries()) {
    const actual = errors[index];
    assert.ok(actual, `${testCase.name}: missing error ${index}`);
    assert.equal(actual.keyword, expected.keyword, `${testCase.name}: keyword ${index}`);
    assert.equal(actual.instancePath, expected.instancePath, `${testCase.name}: path ${index}`);
    if (expected.requiredProperties) {
      assert.deepEqual(
        actual.params?.requiredProperties,
        expected.requiredProperties,
        `${testCase.name}: required properties ${index}`,
      );
    }
  }

  console.log(`  ok ${testCase.name}`);
}

console.log(`schema validation golden tests passed (${FIXTURE.cases.length}/${FIXTURE.cases.length}).`);
