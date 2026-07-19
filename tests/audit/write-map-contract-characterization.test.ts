import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  CodebaseMapSchema,
  COVERAGE_DIMENSIONS,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import {
  createWriteMapTools,
  getReserveCount,
  loadCanonicalMapAt,
  resetReserveCounters,
} from "../../src/core/audit/write-map-tool.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

const MAX_MAP_FILE_BYTES = 1_000_000;
const MAX_INLINE_MAP_BYTES = 100_000;

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-write-map-${name}-`));
}

function cloneMap(map: CodebaseMap = makeValidCodebaseMap()): CodebaseMap {
  return structuredClone(map);
}

async function executeTool(
  tool: ToolDefinition,
  params: unknown,
  cwd: string,
): Promise<Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>> {
  assert.ok(tool.execute, `${tool.name} must expose execute`);
  return tool.execute(
    `characterize-${tool.name}`,
    params as never,
    undefined,
    undefined,
    { cwd } as never,
  );
}

function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function resultText(result: Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>): string {
  const first = result.content?.[0];
  return first?.type === "text" ? first.text : "";
}

function resultDetails(
  result: Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>,
): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

function readJson(filePath: string): CodebaseMap {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as CodebaseMap;
}

function makeOversizedMap(): CodebaseMap {
  const map = cloneMap();
  map.meta.domain_hypothesis = "x".repeat(MAX_INLINE_MAP_BYTES + 1);
  return map;
}

function makeArtifactIntents(includeScaffoldRuntime: boolean): NonNullable<CodebaseMap["artifact_intents"]> {
  return {
    agent_guide: {
      title: "Agent guide",
      sections: [{ heading: "Scope", body: "Repository-specific guidance." }],
    },
    always_on_docs: [],
    feature_agents: [],
    prompt_templates: [],
    experts: [],
    extension_candidates: [],
    ...(includeScaffoldRuntime
      ? { scaffold_runtime: { state_machine_notes: ["preserve-me"] } }
      : {}),
  };
}

async function testToolDefinitionContract(): Promise<void> {
  const { writeMapTool, writeMapDeltaTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  assert.equal(writeMapTool.name, "write_map");
  assert.equal(writeMapTool.label, "Write Codebase Map");
  assert.equal(
    writeMapTool.description,
    "Persist the 10-dimension codebase map to ./.pi/agentify/codebase_map.json. " +
      "Schema-enforced via TypeBox. Every write, including the first checkpoint, requires the complete top-level map; " +
      "use honest empty sections and `gap` coverage entries for unexplored areas. Submit the map inline with `mode: 'auto'`; " +
      "the tool safely creates its own draft transport when it exceeds 100KB. " +
      "Use `map_file` only for an already-existing JSON file. The tool reads, " +
      "validates, and writes the canonical map. Gap entries in the coverage block are " +
      "allowed in the data and reported in the result; weak `covered` entries are " +
      "also reported with the same closure rules as the final post-run gate. " +
      "Audit sessions do not have a general-purpose write tool, so do not attempt to " +
      "create a draft file yourself. " +
      "Call multiple times during exploration to persist progress; call once with the " +
      "final map before rendering the report.",
  );
  assert.strictEqual(writeMapTool.parameters, WriteMapParamsSchema);

  assert.equal(writeMapDeltaTool.name, "write_map_delta");
  assert.equal(writeMapDeltaTool.label, "Write Codebase Map Delta");
  assert.equal(
    writeMapDeltaTool.description,
    "Merge a partial delta into the canonical codebase map. Used by `gap_filler` " +
      "sub-agents to close a single dimension's gap without re-persisting the entire " +
      "map. The delta is schema-validated via PartialCodebaseMapSchema. The merge " +
      "strategy controls how delta fields are combined with the existing map " +
      "(`shallow_overwrite` = default, `deep_merge` = recursive merge, `append` = " +
      "push onto arrays). If `dimension` is provided, the corresponding coverage " +
      "entry is set to `covered` with the delta's `confidence` and `evidence_summary`. " +
      "Per-dimension gap_filler count is tracked (soft ceiling of 3, no hard cap; observability only).",
  );
  assert.strictEqual(writeMapDeltaTool.parameters, WriteMapDeltaParamsSchema);
  assert.ok(CodebaseMapSchema);
}

async function testNullableObjectTransportCompatibility(): Promise<void> {
  const { writeMapTool, writeMapDeltaTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const map = cloneMap() as CodebaseMap & Record<string, unknown>;
  (map.module_graph as Record<string, unknown>).client_server_split = {};
  (map.module_graph as Record<string, unknown>).monorepo_workspace = {};
  (map.type_contract_surface as Record<string, unknown>).openapi_or_graphql = {};
  (map.type_contract_surface as Record<string, unknown>).one_type_trace = {};
  (map.conventions as Record<string, unknown>).versioning = {};
  (map.conventions as Record<string, unknown>).db_migration = {};
  (map.operational_surface as Record<string, unknown>).deploy = {};

  assert.ok(writeMapTool.prepareArguments);
  const preparedMap = writeMapTool.prepareArguments({ map });
  assert.equal(Value.Check(WriteMapParamsSchema, preparedMap), true);
  const normalizedMap = (preparedMap as { map: CodebaseMap }).map;
  assert.equal(normalizedMap.module_graph.client_server_split, null);
  assert.equal(normalizedMap.module_graph.monorepo_workspace, null);
  assert.equal(normalizedMap.type_contract_surface.openapi_or_graphql, null);
  assert.equal(normalizedMap.type_contract_surface.one_type_trace, null);
  assert.equal(normalizedMap.conventions.versioning, null);
  assert.equal(normalizedMap.conventions.db_migration, null);
  assert.equal(normalizedMap.operational_surface.deploy, null);

  assert.ok(writeMapDeltaTool.prepareArguments);
  const preparedDelta = writeMapDeltaTool.prepareArguments({
    delta: { module_graph: { ...map.module_graph, client_server_split: {} } },
  });
  assert.equal(Value.Check(WriteMapDeltaParamsSchema, preparedDelta), true);
  assert.equal(
    (preparedDelta as { delta: { module_graph: { client_server_split: unknown } } })
      .delta.module_graph.client_server_split,
    null,
  );
}

async function testRepairsProviderMisnestedInlineMap(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const map = cloneMap();
  const { meta, skeleton, module_graph, ...remaining } = map;
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({
    map: { meta },
    skeleton,
    module_graph,
    ...remaining,
    mode: "auto",
  }) as { map: CodebaseMap; mode: string };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.deepEqual(prepared.map.skeleton, skeleton);
  assert.deepEqual(prepared.map.module_graph, module_graph);
  assert.equal(prepared.mode, "auto");
}

async function testRepairsProviderUnwrappedInlineMap(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const map = cloneMap() as CodebaseMap & Record<string, unknown>;
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ ...map, mode: "auto" }) as { map: CodebaseMap; mode: string };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
  assert.equal(prepared.mode, "auto");
}

async function testDropsWhollyEmptyPrematureArtifactIntents(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const map = cloneMap() as CodebaseMap & Record<string, unknown>;
  map.artifact_intents = {
    agent_guide: { title: "Not ready", sections: [] },
    always_on_docs: [],
    feature_agents: [],
    prompt_templates: [],
    experts: [],
    extension_candidates: [],
  };
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.artifact_intents, undefined);
}

async function testCompletesIncrementalArtifactIntentLists(): Promise<void> {
  const { writeMapDeltaTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  assert.ok(writeMapDeltaTool.prepareArguments);
  const prepared = writeMapDeltaTool.prepareArguments({
    delta: { artifact_intents: { agent_guide: { title: "Guide", sections: [{ heading: "Scope", body: "Details." }] } } },
  }) as { delta: { artifact_intents: Record<string, unknown> } };
  assert.equal(Value.Check(WriteMapDeltaParamsSchema, prepared), true);
  for (const key of ["always_on_docs", "feature_agents", "prompt_templates", "experts", "extension_candidates"]) {
    assert.deepEqual(prepared.delta.artifact_intents[key], []);
  }
}

async function testNormalizesNumericValidationEvidence(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const map = cloneMap();
  (map.validation_surface as Record<string, unknown>).test_count = "12";
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.validation_surface.test_count, 12);
}

async function testRepairsSerializedInlineMap(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map: JSON.stringify(cloneMap()) }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
}

async function testRepairsDoubleSerializedInlineMap(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map: JSON.stringify(JSON.stringify(cloneMap())) }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
}

async function testExecutesSerializedInlineMapAfterTransportValidation(): Promise<void> {
  const cwd = tempDir("serialized-transport");
  const { writeMapTool } = createWriteMapTools({ stateDir: ".pi/agentify" });
  const serialized = JSON.stringify(JSON.stringify(cloneMap()));
  assert.equal(Value.Check(WriteMapParamsSchema, { map: serialized }), true);
  const result = await executeTool(writeMapTool, { map: serialized }, cwd);
  assert.equal(isToolError(result), false);
  assert.equal(readJson(path.join(cwd, ".pi/agentify/codebase_map.json")).meta.project_type, "test-fixture");
}

async function testInlineDefaultsCoverageAndStorageContract(): Promise<void> {
  const cwd = tempDir("inline");
  const tools = createWriteMapTools({ stateDir: ".claude/agentify" });
  const map = cloneMap() as CodebaseMap & Record<string, unknown>;
  delete map.schema_version;
  delete map.generated_at;

  const result = await executeTool(tools.writeMapTool, { map }, cwd);
  assert.equal(isToolError(result), false);

  const canonical = tools.canonicalMapPath(cwd);
  const persisted = readJson(canonical);
  const content = JSON.stringify(persisted, null, 2);
  const size = Buffer.byteLength(content, "utf8");
  assert.equal(
    resultText(result),
    `Wrote codebase map to ${canonical} (${size} bytes). Source: (inline). ` +
      "Injected defaults: schema_version, generated_at. All 10 coverage dimensions closed.",
  );
  assert.equal(fs.readFileSync(canonical, "utf8"), content);
  assert.equal(fs.statSync(canonical).mode & 0o777, 0o644);
  assert.equal(persisted.schema_version, "1");
  assert.match(persisted.generated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const details = resultDetails(result);
  assert.deepEqual(details.injected_defaults, ["schema_version", "generated_at"]);
  assert.equal(details.path, canonical);
  assert.equal(details.size_bytes, size);
  assert.equal(details.source_path, "(inline)");
  assert.deepEqual(details.coverage_summary, {
    covered: [...COVERAGE_DIMENSIONS],
    gap: [],
    total: COVERAGE_DIMENSIONS.length,
  });
  assert.deepEqual(details.gap_warning, null);
}

async function testInputLoadingAndDraftContract(): Promise<void> {
  const cwd = tempDir("input");
  const tools = createWriteMapTools({ stateDir: ".agents/agentify" });
  const map = cloneMap();

  const relativeInput = "inputs/bom-map.json";
  fs.mkdirSync(path.join(cwd, "inputs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, relativeInput), `\ufeff${JSON.stringify(map)}`);
  const relativeResult = await executeTool(
    tools.writeMapTool,
    { map_file: relativeInput, mode: "file" },
    cwd,
  );
  assert.equal(resultDetails(relativeResult).source_path, path.join(cwd, relativeInput));

  const absoluteCwd = tempDir("absolute");
  const absoluteTools = createWriteMapTools({ stateDir: ".claude/agentify" });
  const absoluteInput = path.join(absoluteCwd, "absolute.json");
  fs.writeFileSync(absoluteInput, JSON.stringify(map));
  const absoluteResult = await executeTool(
    absoluteTools.writeMapTool,
    { map_file: absoluteInput, mode: "file" },
    absoluteCwd,
  );
  assert.equal(resultDetails(absoluteResult).source_path, absoluteInput);

  const missing = path.join(cwd, "missing.json");
  const missingResult = await executeTool(tools.writeMapTool, { map_file: missing }, cwd);
  assert.equal(isToolError(missingResult), true);
  assert.equal(
    resultText(missingResult),
    `Error: map_file at ${missing} does not exist. Audit sessions cannot create this file; ` +
      "submit the map inline with `mode: \"auto\"` instead.",
  );

  const malformed = path.join(cwd, "malformed.json");
  fs.writeFileSync(malformed, "{ nope");
  const malformedResult = await executeTool(tools.writeMapTool, { map_file: malformed }, cwd);
  assert.equal(isToolError(malformedResult), true);
  assert.match(
    resultText(malformedResult),
    new RegExp(
      `^Error: map_file at ${malformed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON: .+\\. ` +
        "Check encoding \\(UTF-8 expected, no BOM\\) and that the file is fully written\\.$",
    ),
  );

  const oversizedFile = path.join(cwd, "oversized.json");
  fs.writeFileSync(oversizedFile, Buffer.alloc(MAX_MAP_FILE_BYTES + 1, 0x20));
  const oversizedFileResult = await executeTool(
    tools.writeMapTool,
    { map_file: oversizedFile },
    cwd,
  );
  assert.equal(
    resultText(oversizedFileResult),
    `Error: failed to read map_file at ${oversizedFile}: map_file is ${MAX_MAP_FILE_BYTES + 1} bytes, ` +
      `exceeds ${MAX_MAP_FILE_BYTES} byte cap. Likely a duplicated section; review the JSON and re-write.`,
  );

  const unreadable = path.join(cwd, "directory-input");
  fs.mkdirSync(unreadable);
  const unreadableResult = await executeTool(tools.writeMapTool, { map_file: unreadable }, cwd);
  assert.match(
    resultText(unreadableResult),
    new RegExp(`^Error: failed to read map_file at ${unreadable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
  );

  const oversizedMap = makeOversizedMap();
  const inlineSize = Buffer.byteLength(JSON.stringify(oversizedMap), "utf8");
  const strictResult = await executeTool(
    tools.writeMapTool,
    { map: oversizedMap, mode: "inline" },
    cwd,
  );
  assert.equal(
    resultText(strictResult),
    `Error: inline map is ${inlineSize} bytes, exceeds the ${MAX_INLINE_MAP_BYTES} byte cap. ` +
      "Retry with `mode: \"auto\"` so agentify can create a private draft.",
  );

  const autoCwd = tempDir("auto");
  const autoTools = createWriteMapTools({ stateDir: ".agents/agentify" });
  const autoResult = await executeTool(autoTools.writeMapTool, { map: oversizedMap }, autoCwd);
  const draftPath = path.join(autoCwd, autoTools.draftPathRelative);
  assert.equal(resultDetails(autoResult).source_path, `auto-fallback:${draftPath}`);
  assert.ok(fs.existsSync(draftPath));
  assert.equal(fs.statSync(draftPath).mode & 0o777, 0o644);
  assert.deepEqual(
    fs.readdirSync(path.dirname(draftPath)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.ok(fs.existsSync(autoTools.canonicalMapPath(autoCwd)));

  const fileModeInline = await executeTool(tools.writeMapTool, { map, mode: "file" }, cwd);
  assert.equal(
    resultText(fileModeInline),
    "Error: write_map called with `mode: 'file'` and inline `map`. " +
      "Use inline `map` with `mode: \"auto\"`; audit sessions cannot create a map file.",
  );

  const emptyResult = await executeTool(tools.writeMapTool, {}, cwd);
  assert.equal(
    resultText(emptyResult),
    "Error: write_map called with empty arguments. Provide either `map` (inline object) or " +
      "`map_file` (path to a JSON file). Audit sessions cannot create a map file; submit inline `map` with " +
      "`mode: \"auto\"` for large maps.",
  );

  const bothResult = await executeTool(
    tools.writeMapTool,
    { map, map_file: relativeInput },
    cwd,
  );
  assert.equal(
    resultText(bothResult),
    "Error: write_map called with both `map` and `map_file`. Provide exactly one.",
  );
}

async function testHistoryValidationCoverageAndMergeContract(): Promise<void> {
  const historyCwd = tempDir("history");
  const historyTools = createWriteMapTools({ stateDir: ".claude/agentify" });
  const firstMap = cloneMap();
  await executeTool(historyTools.writeMapTool, { map: firstMap }, historyCwd);
  const firstBytes = fs.readFileSync(historyTools.canonicalMapPath(historyCwd), "utf8");

  const secondMap = cloneMap(firstMap);
  secondMap.meta.domain_hypothesis = "Second persisted map.";
  await executeTool(historyTools.writeMapTool, { map: secondMap }, historyCwd);
  const historyDir = path.join(historyCwd, historyTools.historyRelative);
  const historyFiles = fs.readdirSync(historyDir);
  assert.equal(historyFiles.length, 1);
  assert.match(historyFiles[0] ?? "", /^codebase_map\.\d{4}-\d{2}-\d{2}T.*\.previous\.json$/);
  assert.equal(fs.readFileSync(path.join(historyDir, historyFiles[0]!), "utf8"), firstBytes);

  const invalidCwd = tempDir("invalid");
  const invalidTools = createWriteMapTools({ stateDir: ".agents/agentify" });
  const invalidResult = await executeTool(invalidTools.writeMapTool, { map: {} }, invalidCwd);
  assert.equal(isToolError(invalidResult), true);
  assert.equal(
    resultText(invalidResult),
    "Error: Schema validation failed with 1 error(s):\n" +
      "  - (root): must have required properties meta, skeleton, module_graph, " +
      "type_contract_surface, conventions, pitfalls, validation_surface, " +
      "operational_surface, security_surface, coverage, open_questions, exploration_log, " +
      "expected unknown",
  );

  const partialCwd = tempDir("partial-invalid");
  const partialTools = createWriteMapTools({ stateDir: ".claude/agentify" });
  await executeTool(partialTools.writeMapTool, { map: cloneMap() }, partialCwd);
  const partialResult = await executeTool(
    partialTools.writeMapDeltaTool,
    { delta: { pitfalls: [{}] } },
    partialCwd,
  );
  assert.equal(isToolError(partialResult), true);
  assert.equal(
    resultText(partialResult),
    "Error: Partial schema validation failed with 1 error(s):\n" +
      "  - /pitfalls/0: must have required properties module, what, consequence, line_ref, " +
      "expected unknown",
  );

  const coverageCwd = tempDir("coverage");
  const coverageTools = createWriteMapTools({ stateDir: ".agents/agentify" });
  const coverageMap = cloneMap();
  coverageMap.validation_surface.test_command = "";
  const coverageResult = await executeTool(coverageTools.writeMapTool, { map: coverageMap }, coverageCwd);
  const coverageCanonical = coverageTools.canonicalMapPath(coverageCwd);
  const coverageSize = Buffer.byteLength(fs.readFileSync(coverageCanonical, "utf8"), "utf8");
  assert.equal(
    resultText(coverageResult),
    `Wrote codebase map to ${coverageCanonical} (${coverageSize} bytes). Source: (inline). ` +
      "9/10 coverage dimensions closed. Unresolved: D6_validation: covered but test/validation command evidence is empty.",
  );
  assert.deepEqual(resultDetails(coverageResult).gap_warning, [
    "D6_validation: covered but test/validation command evidence is empty",
  ]);

  const newPitfall = {
    module: "src/new.ts",
    what: "New pitfall.",
    consequence: "Characterizes array merge behavior.",
    line_ref: 2,
  };

  const shallowCwd = tempDir("merge-shallow");
  const shallowTools = createWriteMapTools({ stateDir: ".claude/agentify" });
  await executeTool(shallowTools.writeMapTool, { map: cloneMap() }, shallowCwd);
  const shallowResult = await executeTool(
    shallowTools.writeMapDeltaTool,
    { delta: { pitfalls: [newPitfall] } },
    shallowCwd,
  );
  assert.equal(resultDetails(shallowResult).merge_strategy, "shallow_overwrite");
  assert.deepEqual(readJson(shallowTools.canonicalMapPath(shallowCwd)).pitfalls, [newPitfall]);

  const appendCwd = tempDir("merge-append");
  const appendTools = createWriteMapTools({ stateDir: ".agents/agentify" });
  const appendBase = cloneMap();
  await executeTool(appendTools.writeMapTool, { map: appendBase }, appendCwd);
  await executeTool(
    appendTools.writeMapDeltaTool,
    { delta: { pitfalls: [newPitfall] }, merge_strategy: "append" },
    appendCwd,
  );
  assert.deepEqual(readJson(appendTools.canonicalMapPath(appendCwd)).pitfalls, [
    ...appendBase.pitfalls,
    newPitfall,
  ]);

  const deepCwd = tempDir("merge-deep");
  const deepTools = createWriteMapTools({ stateDir: ".claude/agentify" });
  const deepBase = cloneMap();
  deepBase.artifact_intents = makeArtifactIntents(true);
  await executeTool(deepTools.writeMapTool, { map: deepBase }, deepCwd);
  const deltaIntents = makeArtifactIntents(false);
  deltaIntents.agent_guide.title = "Updated guide";
  await executeTool(
    deepTools.writeMapDeltaTool,
    { delta: { artifact_intents: deltaIntents }, merge_strategy: "deep_merge" },
    deepCwd,
  );
  const deepMap = readJson(deepTools.canonicalMapPath(deepCwd));
  assert.equal(deepMap.artifact_intents?.agent_guide.title, "Updated guide");
  assert.deepEqual(deepMap.artifact_intents?.scaffold_runtime, {
    state_machine_notes: ["preserve-me"],
  });
}

async function testObservabilityAndFactoryContract(): Promise<void> {
  resetReserveCounters();
  const cwd = tempDir("reserve");
  const tools = createWriteMapTools({
    stateDir: ".claude/agentify",
    mapFilename: "custom-map.json",
  });
  assert.equal(tools.canonicalMapRelative, ".claude/agentify/custom-map.json");
  assert.equal(tools.draftDirectoryRelative, ".claude/agentify/.agentify");
  assert.equal(tools.draftPathRelative, ".claude/agentify/.agentify/draft.json");
  assert.equal(tools.historyRelative, ".claude/agentify/history");
  assert.equal(tools.canonicalMapPath(cwd), path.join(cwd, ".claude/agentify/custom-map.json"));

  await executeTool(tools.writeMapTool, { map: cloneMap() }, cwd);
  let fourthText = "";
  for (let count = 1; count <= 4; count += 1) {
    const result = await executeTool(
      tools.writeMapDeltaTool,
      {
        delta: {},
        dimension: "D1_topography",
        confidence: "high",
        evidence_summary: "Reconfirmed topography evidence.",
      },
      cwd,
    );
    assert.equal(resultDetails(result).gap_filler_count, count);
    if (count === 4) fourthText = resultText(result);
  }
  assert.equal(getReserveCount("D1_topography"), 4);
  assert.match(
    fourthText,
    /Note: gap_filler dispatched 4x for D1_topography \(beyond soft ceiling of 3; LLM should consider a different angle or mark honest null\)$/,
  );
  resetReserveCounters();
  assert.equal(getReserveCount("D1_topography"), 0);

  const piTools = createWriteMapTools({ stateDir: ".pi/agentify" });
  assert.equal(piTools.canonicalMapRelative, ".pi/agentify/codebase_map.json");
  assert.equal(piTools.draftDirectoryRelative, ".pi/agentify/.agentify");
  assert.equal(piTools.draftPathRelative, ".pi/agentify/.agentify/draft.json");
  assert.equal(piTools.historyRelative, ".pi/agentify/history");

  const piCwd = tempDir("pi-explicit");
  const piPath = piTools.canonicalMapPath(piCwd);
  fs.mkdirSync(path.dirname(piPath), { recursive: true });
  fs.writeFileSync(piPath, `\ufeff${JSON.stringify(cloneMap())}`);
  assert.ok(loadCanonicalMapAt(piCwd, ".pi/agentify"));
  assert.equal(loadCanonicalMapAt(piCwd, ".agents/agentify"), null);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "tool definition contract", fn: testToolDefinitionContract },
  { name: "nullable object transport compatibility", fn: testNullableObjectTransportCompatibility },
  { name: "provider misnested inline map repair", fn: testRepairsProviderMisnestedInlineMap },
  { name: "provider unwrapped inline map repair", fn: testRepairsProviderUnwrappedInlineMap },
  { name: "premature empty artifact intents are dropped", fn: testDropsWhollyEmptyPrematureArtifactIntents },
  { name: "incremental artifact intent lists are completed", fn: testCompletesIncrementalArtifactIntentLists },
  { name: "numeric validation evidence is normalized", fn: testNormalizesNumericValidationEvidence },
  { name: "provider serialized inline map repair", fn: testRepairsSerializedInlineMap },
  { name: "provider double-serialized inline map repair", fn: testRepairsDoubleSerializedInlineMap },
  { name: "serialized map executes after transport validation", fn: testExecutesSerializedInlineMapAfterTransportValidation },
  { name: "inline defaults coverage and storage contract", fn: testInlineDefaultsCoverageAndStorageContract },
  { name: "input loading and draft contract", fn: testInputLoadingAndDraftContract },
  { name: "history validation coverage and merge contract", fn: testHistoryValidationCoverageAndMergeContract },
  { name: "observability and explicit factory contract", fn: testObservabilityAndFactoryContract },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}

console.log(`write-map contract characterization tests passed (${passed}/${tests.length}).`);
