import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import * as coverageModule from "../../src/core/audit/coverage.ts";
import * as defaultsModule from "../../src/core/audit/map-defaults.ts";
import * as compatibilityModule from "../../src/core/audit/schema-compatibility.ts";
import {
  CodebaseMapSchema,
  COVERAGE_DIMENSIONS,
  PartialCodebaseMapSchema,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
  applyMapDefaults,
  assessCoverageClosure,
  extractCoverageSummary,
  resolveApiContracts,
  resolveFrameworks,
  resolveLifecyclePresence,
  resolveProductionCredentials,
  resolveSyncedTypes,
  type CodebaseMap,
  type CoverageDimension,
} from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

interface SchemaNode {
  required?: string[];
  properties?: Record<string, SchemaNode>;
  enum?: string[];
  const?: unknown;
  default?: unknown;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

interface ContractFixture {
  serialization: Record<string, { sha256: string; bytes: number }>;
  required: Record<string, string[]>;
  properties: Record<string, string[]>;
  enums: Record<string, string[]>;
  defaults: Record<string, unknown>;
  bounds: {
    agent_guide_sections: { minItems: number; maxItems: number };
    feature_agents: { minItems: number; maxItems: number };
    write_map_file_description: string;
    write_mode_description: string;
    merge_strategy_description: string;
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "../fixtures/audit-schema-contract.json"), "utf8"),
) as ContractFixture;

function serializedNode(schema: unknown): SchemaNode {
  return JSON.parse(JSON.stringify(schema)) as SchemaNode;
}

function digest(schema: unknown): { sha256: string; bytes: number } {
  const serialized = JSON.stringify(schema);
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
}

function properties(node: SchemaNode): Record<string, SchemaNode> {
  assert.ok(node.properties, "schema node must expose properties");
  return node.properties;
}

function testSerializedSchemaContract(): void {
  const complete = serializedNode(CodebaseMapSchema);
  const partial = serializedNode(PartialCodebaseMapSchema);
  const writeMap = serializedNode(WriteMapParamsSchema);
  const writeDelta = serializedNode(WriteMapDeltaParamsSchema);

  assert.deepEqual(digest(CodebaseMapSchema), FIXTURE.serialization.codebase_map);
  assert.deepEqual(digest(PartialCodebaseMapSchema), FIXTURE.serialization.partial_codebase_map);
  assert.deepEqual(digest(WriteMapParamsSchema), FIXTURE.serialization.write_map_params);
  assert.deepEqual(digest(WriteMapDeltaParamsSchema), FIXTURE.serialization.write_map_delta_params);

  const completeProps = properties(complete);
  const partialProps = properties(partial);
  const writeProps = properties(writeMap);
  const deltaProps = properties(writeDelta);
  const coverageProps = properties(completeProps.coverage ?? {});
  const artifactProps = properties(completeProps.artifact_intents ?? {});
  const agentGuideProps = properties(artifactProps.agent_guide ?? {});

  assert.deepEqual(complete.required ?? [], FIXTURE.required.codebase_map);
  assert.deepEqual(partial.required ?? [], FIXTURE.required.partial_codebase_map);
  assert.deepEqual(writeMap.required ?? [], FIXTURE.required.write_map_params);
  assert.deepEqual(writeDelta.required ?? [], FIXTURE.required.write_map_delta_params);
  assert.deepEqual(completeProps.coverage?.required ?? [], FIXTURE.required.coverage);

  assert.deepEqual(Object.keys(completeProps), FIXTURE.properties.codebase_map);
  assert.deepEqual(Object.keys(partialProps), FIXTURE.properties.partial_codebase_map);
  assert.deepEqual(Object.keys(writeProps), FIXTURE.properties.write_map_params);
  assert.deepEqual(Object.keys(deltaProps), FIXTURE.properties.write_map_delta_params);

  assert.deepEqual(deltaProps.dimension?.enum, FIXTURE.enums.coverage_dimensions);
  assert.deepEqual(writeProps.mode?.enum, FIXTURE.enums.write_mode);
  assert.deepEqual(deltaProps.merge_strategy?.enum, FIXTURE.enums.merge_strategy);
  assert.deepEqual(deltaProps.confidence?.enum, FIXTURE.enums.delta_confidence);
  assert.deepEqual(
    properties(coverageProps.D1_topography ?? {}).status?.enum,
    FIXTURE.enums.coverage_status,
  );

  assert.equal(completeProps.schema_version?.const, FIXTURE.defaults.schema_version);
  assert.equal(writeProps.mode?.default, FIXTURE.defaults.write_mode);
  assert.equal(deltaProps.merge_strategy?.default, FIXTURE.defaults.merge_strategy);

  assert.deepEqual(
    {
      minItems: agentGuideProps.sections?.minItems,
      maxItems: agentGuideProps.sections?.maxItems,
    },
    FIXTURE.bounds.agent_guide_sections,
  );
  assert.deepEqual(
    {
      minItems: artifactProps.feature_agents?.minItems,
      maxItems: artifactProps.feature_agents?.maxItems,
    },
    FIXTURE.bounds.feature_agents,
  );
  assert.equal(writeProps.map_file?.description, FIXTURE.bounds.write_map_file_description);
  assert.equal(writeProps.mode?.description, FIXTURE.bounds.write_mode_description);
  assert.equal(
    deltaProps.merge_strategy?.description,
    FIXTURE.bounds.merge_strategy_description,
  );

  assert.equal(Object.keys(coverageProps).length, COVERAGE_DIMENSIONS.length);
}

function testFacadeIdentity(): void {
  assert.strictEqual(COVERAGE_DIMENSIONS, coverageModule.COVERAGE_DIMENSIONS);
  assert.strictEqual(assessCoverageClosure, coverageModule.assessCoverageClosure);
  assert.strictEqual(extractCoverageSummary, coverageModule.extractCoverageSummary);
  assert.strictEqual(applyMapDefaults, defaultsModule.applyMapDefaults);
  assert.strictEqual(resolveLifecyclePresence, compatibilityModule.resolveLifecyclePresence);
  assert.strictEqual(resolveFrameworks, compatibilityModule.resolveFrameworks);
  assert.strictEqual(resolveApiContracts, compatibilityModule.resolveApiContracts);
  assert.strictEqual(resolveSyncedTypes, compatibilityModule.resolveSyncedTypes);
  assert.strictEqual(
    resolveProductionCredentials,
    compatibilityModule.resolveProductionCredentials,
  );
}

function testMapDefaults(): void {
  const completeInput = makeValidCodebaseMap();
  delete completeInput.schema_version;
  delete completeInput.generated_at;
  const completeMeta = completeInput.meta;
  const completeResult = applyMapDefaults(completeInput);
  assert.notStrictEqual(completeResult.map, completeInput);
  assert.strictEqual(completeResult.map.meta, completeMeta);
  assert.equal(completeInput.schema_version, undefined);
  assert.equal(completeInput.generated_at, undefined);
  assert.deepEqual(completeResult.injectedDefaults, ["schema_version", "generated_at"]);

  const nested = { marker: "same-reference" };
  const input: Record<string, unknown> = { nested };
  const before = Date.now();
  const result = applyMapDefaults(input);
  const after = Date.now();

  assert.notStrictEqual(result.map, input);
  assert.strictEqual((result.map as unknown as Record<string, unknown>).nested, nested);
  assert.equal(input.schema_version, undefined);
  assert.equal(input.generated_at, undefined);
  assert.deepEqual(result.injectedDefaults, ["schema_version", "generated_at"]);
  assert.equal(result.map.schema_version, "1");
  assert.ok(result.map.generated_at);
  const generatedAt = Date.parse(result.map.generated_at);
  assert.ok(generatedAt >= before && generatedAt <= after);

  const existing = applyMapDefaults({ schema_version: "1", generated_at: "fixed" });
  assert.deepEqual(existing.injectedDefaults, []);
  assert.equal(existing.map.generated_at, "fixed");

  const partial = { coverage: { D1_topography: { status: "gap" } } };
  const partialResult = applyMapDefaults(partial);
  assert.notStrictEqual(partialResult.map, partial);
  assert.strictEqual(
    (partialResult.map as unknown as Record<string, unknown>).coverage,
    partial.coverage,
  );
  assert.deepEqual(partialResult.injectedDefaults, ["schema_version", "generated_at"]);

  const explicitNulls = applyMapDefaults({ schema_version: null, generated_at: null });
  assert.deepEqual(explicitNulls.injectedDefaults, []);
  assert.equal((explicitNulls.map as unknown as Record<string, unknown>).schema_version, null);
  assert.equal((explicitNulls.map as unknown as Record<string, unknown>).generated_at, null);
}

interface CoverageCase {
  dimension: CoverageDimension;
  mutate: (map: CodebaseMap) => void;
  reason: string;
}

function testCoverageReasonsAndOrder(): void {
  const cases: CoverageCase[] = [
    {
      dimension: "D1_topography",
      mutate: (map) => { map.skeleton.top_level_tree = []; },
      reason: "covered but top_level_tree is empty",
    },
    {
      dimension: "D2_module_boundaries",
      mutate: (map) => {
        map.module_graph.edges = [];
        map.module_graph.parallelizable_subtrees = [];
        map.module_graph.shared_abstractions = [];
        map.module_graph.shared_state = [];
        map.module_graph.client_server_split = null;
      },
      reason: "covered but no module boundary evidence was recorded",
    },
    {
      dimension: "D3_type_contract",
      mutate: (map) => {
        map.type_contract_surface.typescript_interfaces = [];
        map.type_contract_surface.pydantic_models = [];
        map.type_contract_surface.db_models = [];
        map.type_contract_surface.idks = [];
        map.type_contract_surface.stable_types = [];
        map.type_contract_surface.one_type_trace = null;
      },
      reason: "covered but no type or contract evidence was recorded",
    },
    {
      dimension: "D4_conventions",
      mutate: (map) => { map.conventions.naming.files = ""; },
      reason: "covered but naming convention evidence is incomplete",
    },
    {
      dimension: "D5_pitfalls",
      mutate: (map) => { map.pitfalls = []; },
      reason:
        "covered but only 0 substantive pitfall(s); need >= 1 with module, what, consequence, and line_ref",
    },
    {
      dimension: "D6_validation",
      mutate: (map) => { map.validation_surface.test_command = ""; },
      reason: "covered but test/validation command evidence is empty",
    },
    {
      dimension: "D7_operational",
      mutate: (map) => { map.operational_surface.build.command = ""; },
      reason: "covered but build command evidence is empty",
    },
    {
      dimension: "D8_security",
      mutate: (map) => { map.security_surface.paths.zero_access = []; },
      reason: "covered but zero-access security paths are empty",
    },
    {
      dimension: "D9_process",
      mutate: (map) => { map.meta.lifecycle.sdlc_model = ""; },
      reason: "covered but process lifecycle model is empty",
    },
    {
      dimension: "D10_documentation",
      mutate: (map) => {
        map.meta.documentation.agents_md = null;
        map.meta.documentation.has_ai_docs = false;
        map.meta.documentation.has_app_docs = false;
        map.meta.documentation.has_specs = false;
        map.meta.documentation.readme_metrics = {
          present: false,
          line_count: 0,
          section_count: 0,
        };
      },
      reason: "covered but no documentation surface was recorded",
    },
  ];

  for (const testCase of cases) {
    const map = makeValidCodebaseMap();
    testCase.mutate(map);
    const result = assessCoverageClosure(map);
    assert.deepEqual(result.unresolved, [testCase.dimension]);
    assert.equal(result.reasons[testCase.dimension], testCase.reason);
    assert.deepEqual(
      result.closed,
      COVERAGE_DIMENSIONS.filter((dimension) => dimension !== testCase.dimension),
    );
  }

  const gapMap = makeValidCodebaseMap();
  gapMap.coverage.D4_conventions.status = "gap";
  assert.equal(
    assessCoverageClosure(gapMap).reasons.D4_conventions,
    "coverage status is not 'covered'",
  );

  const emptyEvidence = makeValidCodebaseMap();
  emptyEvidence.coverage.D4_conventions.evidence_summary = "   ";
  assert.equal(
    assessCoverageClosure(emptyEvidence).reasons.D4_conventions,
    "covered but evidence_summary is empty",
  );

  const mandatoryCommands = makeValidCodebaseMap();
  mandatoryCommands.validation_surface.per_change_type.chore.mandatory = [];
  assert.equal(
    assessCoverageClosure(mandatoryCommands).reasons.D6_validation,
    "covered but mandatory per-change validation commands are incomplete",
  );

  const securityRules = makeValidCodebaseMap();
  securityRules.security_surface.bash_blocked_patterns = [];
  securityRules.security_surface.damage_control_rules = [];
  assert.equal(
    assessCoverageClosure(securityRules).reasons.D8_security,
    "covered but security damage-control evidence is empty",
  );

  const openQuestion = makeValidCodebaseMap();
  openQuestion.open_questions = ["Still unresolved outside the enforced coverage contract."];
  assert.deepEqual(assessCoverageClosure(openQuestion).unresolved, []);
}

function testCoverageSummary(): void {
  const map = makeValidCodebaseMap();
  map.coverage.D2_module_boundaries.status = "gap";
  map.coverage.D9_process.status = "gap";
  assert.deepEqual(extractCoverageSummary(map), {
    covered: COVERAGE_DIMENSIONS.filter(
      (dimension) => dimension !== "D2_module_boundaries" && dimension !== "D9_process",
    ),
    gap: ["D2_module_boundaries", "D9_process"],
    total: 10,
  });
}

function testCompatibilityPrecedence(): void {
  assert.deepEqual(
    resolveLifecyclePresence({
      review_loop: { present: false, kind: "none" },
      documentation_loop: { present: false, kind: "none" },
      conditional_docs: {
        present: false,
        path: null,
        last_updated: null,
        entries_count: 0,
      },
      has_review_loop: true,
      has_documentation_loop: true,
      has_conditional_docs: true,
    }),
    { reviewLoop: false, documentationLoop: false, conditionalDocs: false },
  );
  assert.deepEqual(
    resolveLifecyclePresence({
      has_review_loop: true,
      has_documentation_loop: false,
      has_conditional_docs: true,
    }),
    { reviewLoop: true, documentationLoop: false, conditionalDocs: true },
  );

  assert.deepEqual(
    resolveFrameworks({ frameworks: [] }, { frameworks: ["legacy"] }),
    { source: "meta", frameworks: [] },
  );
  assert.deepEqual(
    resolveFrameworks(undefined, { frameworks: ["legacy"] }),
    { source: "skeleton", frameworks: ["legacy"] },
  );

  const legacyContract = {
    path: "openapi.json",
    schema_kind: "openapi" as const,
    endpoint_count: 3,
  };
  assert.deepEqual(
    resolveApiContracts({ api_contracts: [], openapi_or_graphql: legacyContract }),
    { source: "typed", contracts: [] },
  );
  assert.deepEqual(
    resolveApiContracts({ openapi_or_graphql: legacyContract }),
    { source: "legacy", contracts: [legacyContract] },
  );

  assert.deepEqual(
    resolveSyncedTypes({
      synced_types: { synced: [], unsynced: [] },
      synced_types_observed: true,
    }),
    { source: "typed", synced: [], unsynced: [] },
  );
  assert.deepEqual(
    resolveSyncedTypes({ synced_types_observed: false }),
    { source: "legacy", observed: false },
  );

  assert.deepEqual(
    resolveProductionCredentials({
      production_credentials: [],
      production_credentials_v1: ["LEGACY_TOKEN"],
    }),
    [],
  );
  assert.deepEqual(
    resolveProductionCredentials({ production_credentials_v1: ["DATABASE_URL"] }),
    [{ source: "legacy", name: "DATABASE_URL", category: null }],
  );
  assert.deepEqual(
    resolveProductionCredentials({
      production_credentials: [{ name: "OPENAI_API_KEY", category: "llm" }],
    }),
    [{ source: "typed", name: "OPENAI_API_KEY", category: "llm" }],
  );
}

function testValidAndInvalidFixtures(): void {
  const valid = makeValidCodebaseMap();
  assert.equal(Value.Check(CodebaseMapSchema, valid), true);
  assert.equal(Value.Check(PartialCodebaseMapSchema, { coverage: valid.coverage }), true);

  const invalid = structuredClone(valid) as Record<string, unknown>;
  delete invalid.meta;
  const errors = Value.Errors(CodebaseMapSchema, invalid);
  assert.ok(errors.length > 0);
  const firstError = errors[0] as {
    keyword?: string;
    instancePath?: string;
    params?: { requiredProperties?: string[] };
  } | undefined;
  assert.equal(firstError?.keyword, "required");
  assert.equal(firstError?.instancePath, "");
  assert.deepEqual(firstError?.params?.requiredProperties, ["meta"]);

  assert.equal(Value.Check(WriteMapParamsSchema, {}), true);
  assert.equal(Value.Check(WriteMapDeltaParamsSchema, { delta: {} }), true);
  assert.equal(Value.Check(WriteMapDeltaParamsSchema, {}), false);
}

const tests: Array<{ name: string; run: () => void }> = [
  { name: "serialized schema contract", run: testSerializedSchemaContract },
  { name: "compatibility facade identity", run: testFacadeIdentity },
  { name: "map defaults", run: testMapDefaults },
  { name: "coverage reasons and order", run: testCoverageReasonsAndOrder },
  { name: "coverage summary", run: testCoverageSummary },
  { name: "compatibility precedence", run: testCompatibilityPrecedence },
  { name: "valid and invalid fixtures", run: testValidAndInvalidFixtures },
];

for (const testCase of tests) {
  testCase.run();
  console.log(`  ok ${testCase.name}`);
}
console.log(`schema contract characterization tests passed (${tests.length}/${tests.length}).`);
