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
import { createGapDraftMap } from "../../src/core/audit/map-draft.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

const MAX_MAP_FILE_BYTES = 1_000_000;
const MAX_INLINE_MAP_BYTES = 100_000;

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-write-map-${name}-`));
  fs.writeFileSync(path.join(dir, "README.md"), "Test fixture evidence citation.");
  return dir;
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
  const { writeMapTool, writeMapDeltaTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  assert.equal(writeMapTool.name, "write_map");
  assert.equal(writeMapTool.label, "Write Codebase Map");
  assert.equal(
    writeMapTool.description,
    "Persist the 10-dimension codebase map to ./.agentify/runtime/audit/codebase_map.json. " +
      "Schema-enforced via TypeBox. Every write, including the first checkpoint, requires the complete top-level map; " +
      "use honest empty sections and `gap` coverage entries for unexplored areas. Submit the map inline with `mode: 'auto'`; " +
      "the tool safely creates its own draft transport when it exceeds 100KB. " +
      "Use `map_file` only for an already-existing JSON file. The tool reads, " +
      "validates, and writes the canonical map. Gap entries in the coverage block are " +
      "allowed in the data and reported in the result; weak `covered` entries are " +
      "also reported with the same closure rules as the final post-run gate. " +
      "Every `covered` dimension must include `evidence`: an array of `{ path, excerpt, kind }` " +
      "citations to real repository paths; the gate rejects covered claims that cannot be grounded. " +
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
    "Merge a partial delta into the canonical codebase map. Each call should close one dimension by including both the dimension data AND the matching coverage entry. Merging does not silently strip or invent arrays: the arrays and objects you provide overwrite the matching fields in the map. If a field is still empty after the merge, your delta did not include it. Use `shallow_overwrite` (default) for a clean top-level replacement, `deep_merge` to merge nested objects recursively, or `append` to concatenate arrays. When `dimension` is provided, the coverage entry is proposed as `covered`; Agentify downgrades it to `gap` only if the evidence or substance check fails. Every `covered` claim must include `evidence`: an array of `{ path, excerpt, kind }` citations to real repository paths. D1 example: `delta: { skeleton: { top_level_tree: ['README.md', 'get.sh', 'compile.sh'], entry_points: [{ path: 'get.sh', role: 'SDK acquisition script', language: 'bash', run_command: 'bash get.sh' }], first_5_files_for_fresh_agent: [{ path: 'README.md', why: 'project overview' }] }, coverage: { D1_topography: { status: 'covered', confidence: 'high', evidence_summary: 'Topography anchored to real root files.', evidence: [{ path: 'README.md', excerpt: 'Adoptium AQAvit test suite', kind: 'positive' }] } } }`. D3 example: `delta: { observed_type_contract: { kind: 'typescript_interface', path: 'src/types.ts', name: 'Observed', fields: ['id', 'name'] }, coverage: { D3_type_contract: { status: 'covered', ... } } }` or `delta: { type_contract_surface: { stable_types: [{ path: 'src/types.ts', name: 'BuildEnv', purpose: 'shared make vars' }] }, coverage: { D3_type_contract: { ... } } }`. D8 example: `delta: { security_surface: { paths: { zero_access: ['.env', '*.pem', 'secrets.*'] }, bash_blocked_patterns: ['rm -rf /', 'eval $(aws sts assume-role ...)'] }, coverage: { D8_security: { ... } } }`. Keep the delta small but complete for the one dimension you are closing.",
  );
  assert.strictEqual(writeMapDeltaTool.parameters, WriteMapDeltaParamsSchema);
  assert.ok(CodebaseMapSchema);
}

async function testNullableObjectTransportNormalization(): Promise<void> {
  const { writeMapTool, writeMapDeltaTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const map = cloneMap() as CodebaseMap & Record<string, unknown>;
  (map.module_graph as Record<string, unknown>).client_server_split = {};
  (map.module_graph as Record<string, unknown>).monorepo_workspace = {};
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
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
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
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const map = cloneMap() as CodebaseMap & Record<string, unknown>;
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ ...map, mode: "auto" }) as { map: CodebaseMap; mode: string };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
  assert.equal(prepared.mode, "auto");
}

async function testAcceptsCodebaseMapTransportAlias(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ codebase_map: cloneMap() }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
}

async function testDropsWhollyEmptyPrematureArtifactIntents(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
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
  const { writeMapDeltaTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
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
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const map = cloneMap();
  (map.validation_surface as Record<string, unknown>).test_count = "12";
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.validation_surface.test_count, 12);
}

async function testNormalizesPitfallLineReferences(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const map = cloneMap();
  (map.pitfalls[0] as Record<string, unknown>).line_ref = "line 42";
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map }) as { map: CodebaseMap };
  assert.equal(prepared.map.pitfalls[0]?.line_ref, 42);
}

async function testRepairsSerializedInlineMap(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map: JSON.stringify(cloneMap()) }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
}

async function testRepairsDoubleSerializedInlineMap(): Promise<void> {
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  assert.ok(writeMapTool.prepareArguments);
  const prepared = writeMapTool.prepareArguments({ map: JSON.stringify(JSON.stringify(cloneMap())) }) as { map: CodebaseMap };
  assert.equal(Value.Check(WriteMapParamsSchema, prepared), true);
  assert.equal(prepared.map.meta.project_type, "test-fixture");
}

async function testExecutesSerializedInlineMapAfterTransportValidation(): Promise<void> {
  const cwd = tempDir("serialized-transport");
  const { writeMapTool } = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const serialized = JSON.stringify(JSON.stringify(cloneMap()));
  assert.equal(Value.Check(WriteMapParamsSchema, { map: serialized }), true);
  const result = await executeTool(writeMapTool, { map: serialized }, cwd);
  assert.equal(isToolError(result), false);
  assert.equal(readJson(path.join(cwd, ".agentify/runtime/audit/codebase_map.json")).meta.project_type, "test-fixture");
}

async function testInlineDefaultsCoverageAndStorageContract(): Promise<void> {
  const cwd = tempDir("inline");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
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
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(canonical).mode & 0o777, 0o644);
  }
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
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
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
  const absoluteTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
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
  const autoTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  const autoResult = await executeTool(autoTools.writeMapTool, { map: oversizedMap }, autoCwd);
  const draftPath = path.join(autoCwd, autoTools.draftPathRelative);
  assert.equal(resultDetails(autoResult).source_path, `auto-fallback:${draftPath}`);
  assert.ok(fs.existsSync(draftPath));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(draftPath).mode & 0o777, 0o644);
  }
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
  const historyTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
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

  const draftCwd = tempDir("draft-bootstrap");
  const draftTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  const draftResult = await executeTool(draftTools.writeMapTool, { map: {} }, draftCwd);
  assert.equal(isToolError(draftResult), false);
  assert.match(resultText(draftResult), /Source: \(inline\):draft-merged/);
  assert.equal(
    Object.values(readJson(draftTools.canonicalMapPath(draftCwd)).coverage)
      .filter((entry) => entry.status === "covered").length,
    0,
  );

  const malformedCwd = tempDir("draft-sanitize");
  const malformedResult = await executeTool(draftTools.writeMapTool, {
    map: { meta: { project_type: "research", languages: ["python"], lifecycle: "invalid" }, skeleton: { top_level_tree: ["src/"] } },
  }, malformedCwd);
  assert.equal(isToolError(malformedResult), false);
  const malformedMap = readJson(draftTools.canonicalMapPath(malformedCwd));
  assert.equal(malformedMap.meta.project_type, "research");
  assert.equal(malformedMap.skeleton.top_level_tree[0], "src/");
  assert.equal(malformedMap.meta.lifecycle.documentation_loop.present, false);
  assert.ok(malformedMap.exploration_log.some((entry) => entry.action === "draft_bootstrap"));

  const replacementCwd = tempDir("draft-marker-replacement");
  await executeTool(draftTools.writeMapTool, { map: {} }, replacementCwd);
  await executeTool(draftTools.writeMapTool, { map: cloneMap() }, replacementCwd);
  const replacementMap = readJson(draftTools.canonicalMapPath(replacementCwd));
  assert.ok(replacementMap.exploration_log.some((entry) => entry.action === "draft_bootstrap"));
  const malformedReplacementDelta = await executeTool(
    draftTools.writeMapDeltaTool,
    { delta: { type_contract_surface: { one_type_trace: { name: "Incomplete trace" } } } },
    replacementCwd,
  );
  assert.equal(isToolError(malformedReplacementDelta), false);

  const partialCwd = tempDir("partial-invalid");
  const partialTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
  await executeTool(partialTools.writeMapTool, { map: cloneMap() }, partialCwd);
  const partialResult = await executeTool(
    partialTools.writeMapDeltaTool,
    { delta: { pitfalls: [{}] } },
    partialCwd,
  );
  assert.equal(isToolError(partialResult), true);
  assert.equal(
    resultText(partialResult),
    "Error: merged map failed schema validation. Correct the reported delta fields and retry. Schema validation failed with 1 error(s):\n" +
      "  - /pitfalls/0: must have required properties module, what, consequence, line_ref, " +
      "expected unknown",
  );

  const coverageCwd = tempDir("coverage");
  const coverageTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  const coverageMap = cloneMap();
  coverageMap.validation_surface.test_command = "";
  const coverageResult = await executeTool(coverageTools.writeMapTool, { map: coverageMap }, coverageCwd);
  const coverageCanonical = coverageTools.canonicalMapPath(coverageCwd);
  const coverageSize = Buffer.byteLength(fs.readFileSync(coverageCanonical, "utf8"), "utf8");
  assert.equal(
    resultText(coverageResult),
    `Wrote codebase map to ${coverageCanonical} (${coverageSize} bytes). Source: (inline). ` +
      "9/10 coverage dimensions closed. Unresolved: D6_validation: covered but test/validation command evidence is empty. " +
      "Unsupported covered claims persisted as gap: D6_validation. " +
      "Repair guidance: D6_validation: covered but test/validation command evidence is empty " +
      "(include validation_surface.test_command and per_change_type.chore/bug/feature.mandatory arrays).",
  );
  assert.equal(readJson(coverageCanonical).coverage.D6_validation.status, "gap");
  assert.deepEqual(resultDetails(coverageResult).downgraded_dimensions, ["D6_validation"]);
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
  const shallowTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
  await executeTool(shallowTools.writeMapTool, { map: cloneMap() }, shallowCwd);
  const shallowResult = await executeTool(
    shallowTools.writeMapDeltaTool,
    { delta: { pitfalls: [newPitfall] } },
    shallowCwd,
  );
  assert.equal(resultDetails(shallowResult).merge_strategy, "shallow_overwrite");
  assert.deepEqual(readJson(shallowTools.canonicalMapPath(shallowCwd)).pitfalls, [newPitfall]);

  const partialNestedCwd = tempDir("merge-partial-nested");
  const partialNestedTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
  await executeTool(partialNestedTools.writeMapTool, { map: cloneMap() }, partialNestedCwd);
  const partialNestedResult = await executeTool(
    partialNestedTools.writeMapDeltaTool,
    { delta: { skeleton: { top_level_tree: ["src/"] } } },
    partialNestedCwd,
  );
  assert.equal(isToolError(partialNestedResult), false);
  assert.equal(resultDetails(partialNestedResult).merge_strategy, "deep_merge");
  const partialNestedMap = readJson(partialNestedTools.canonicalMapPath(partialNestedCwd));
  assert.deepEqual(partialNestedMap.skeleton.top_level_tree, ["src/"]);
  assert.equal(partialNestedMap.skeleton.code_test_mirror.observed, true);

  const bootstrapDeltaCwd = tempDir("bootstrap-delta-sanitize");
  const bootstrapDeltaTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  await executeTool(bootstrapDeltaTools.writeMapTool, { map: {} }, bootstrapDeltaCwd);
  const bootstrapDeltaResult = await executeTool(
    bootstrapDeltaTools.writeMapDeltaTool,
    {
      delta: { skeleton: { entry_points: ["src/cli.py"] } },
      dimension: "D1_topography",
      confidence: "high",
      evidence_summary: "Examined the repository tree and command entry points.",
    },
    bootstrapDeltaCwd,
  );
  assert.equal(isToolError(bootstrapDeltaResult), false);
  assert.match(resultText(bootstrapDeltaResult), /top_level_tree: \["src\/"\], entry_points: \[\{ path: "path\/to\/entry", role:/);
  const bootstrapDeltaMap = readJson(bootstrapDeltaTools.canonicalMapPath(bootstrapDeltaCwd));
  assert.deepEqual(bootstrapDeltaMap.skeleton.entry_points, []);
  assert.equal(bootstrapDeltaMap.coverage.D1_topography.status, "gap");
  assert.match(bootstrapDeltaMap.coverage.D1_topography.evidence_summary, /skeleton\.entry_points/);

  const validTopographyResult = await executeTool(
    bootstrapDeltaTools.writeMapDeltaTool,
    {
      delta: {
        skeleton: {
          top_level_tree: ["src/"],
          entry_points: [{
            path: "src/cli.py",
            role: "Command-line entry point",
            language: "python",
            run_command: "uv run package",
          }],
          first_5_files_for_fresh_agent: [{
            path: "README.md",
            why: "Explains the project entry point.",
          }],
        },
      },
      dimension: "D1_topography",
      confidence: "high",
      evidence_summary: "Confirmed the command-line entry point.",
      evidence: [{ path: "README.md", excerpt: "Fixture evidence for D1_topography.", kind: "positive" }],
    },
    bootstrapDeltaCwd,
  );
  assert.equal(isToolError(validTopographyResult), false);
  assert.equal(
    readJson(bootstrapDeltaTools.canonicalMapPath(bootstrapDeltaCwd)).coverage.D1_topography.status,
    "covered",
  );

  const malformedLogResult = await executeTool(
    bootstrapDeltaTools.writeMapDeltaTool,
    {
      delta: {
        exploration_log: { invalid: "provider-shaped object" },
        type_contract_surface: { one_type_trace: { name: "Incomplete trace" } },
      },
      dimension: "D3_type_contract",
      confidence: "medium",
      evidence_summary: "Attempted a partial type trace.",
    },
    bootstrapDeltaCwd,
  );
  assert.equal(isToolError(malformedLogResult), false);
  const malformedLogMap = readJson(bootstrapDeltaTools.canonicalMapPath(bootstrapDeltaCwd));
  assert.ok(Array.isArray(malformedLogMap.exploration_log));
  assert.ok(malformedLogMap.exploration_log.some((entry) => entry.action === "gap_filler_delta"));

  const appendCwd = tempDir("merge-append");
  const appendTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
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
  const deepTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
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

async function testSubstanceFailuresPersistAsGapsWithRepairGuidance(): Promise<void> {
  const cwd = tempDir("substance-feedback");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  const map = cloneMap();
  map.type_contract_surface.pydantic_models = [];
  map.type_contract_surface.typescript_interfaces = [];
  map.type_contract_surface.db_models = [];
  map.type_contract_surface.idks = [];
  map.type_contract_surface.stable_types = [];
  map.type_contract_surface.one_type_trace = null;
  map.security_surface.bash_blocked_patterns = [];
  map.security_surface.damage_control_rules = [];

  const result = await executeTool(tools.writeMapTool, { map }, cwd);
  const persisted = readJson(tools.canonicalMapPath(cwd));
  assert.equal(persisted.coverage.D3_type_contract.status, "gap");
  assert.equal(persisted.coverage.D8_security.status, "gap");
  assert.deepEqual(resultDetails(result).downgraded_dimensions, ["D3_type_contract", "D8_security"]);
  assert.match(resultText(result), /D3_type_contract:/);
  assert.match(resultText(result), /observed_type_contract/);
  assert.match(resultText(result), /One real type is sufficient in a small repository/);
  assert.match(resultText(result), /D8_security:/);
  assert.match(resultText(result), /paths\.zero_access/);
  assert.match(resultText(result), /damage_control_rules/);

  const typeResult = await executeTool(
    tools.writeMapDeltaTool,
    {
      dimension: "D3_type_contract",
      confidence: "high",
      evidence_summary: "Observed the AddInput interface in the typed public contract.",
      evidence: [{ path: "README.md", excerpt: "Fixture evidence for D3_type_contract.", kind: "positive" }],
      merge_strategy: "deep_merge",
      observed_type_contract: {
        kind: "typescript_interface",
        path: "src/types.ts",
        name: "AddInput",
        fields: ["left", "right"],
      },
      delta: {},
    },
    cwd,
  );
  assert.equal(isToolError(typeResult), false);
  const typeRepaired = readJson(tools.canonicalMapPath(cwd));
  assert.equal(typeRepaired.coverage.D3_type_contract.status, "covered");
  assert.deepEqual(typeRepaired.type_contract_surface.typescript_interfaces, [{
    path: "src/types.ts",
    name: "AddInput",
    fields: ["left", "right"],
  }]);

  const misplacedContractResult = await executeTool(
    tools.writeMapDeltaTool,
    {
      dimension: "D8_security",
      observed_type_contract: {
        kind: "typescript_interface",
        path: "src/types.ts",
        name: "AddInput",
        fields: ["left", "right"],
      },
      delta: {},
    },
    cwd,
  );
  assert.equal(isToolError(misplacedContractResult), true);
  assert.match(resultText(misplacedContractResult), /valid only with dimension=D3_type_contract/);

  const securityResult = await executeTool(
    tools.writeMapDeltaTool,
    {
      dimension: "D8_security",
      confidence: "high",
      evidence_summary: "SECURITY.md forbids reading or committing credential files.",
      evidence: [{ path: "README.md", excerpt: "Fixture evidence for D8_security.", kind: "positive" }],
      merge_strategy: "deep_merge",
      delta: {
        security_surface: {
          damage_control_rules: ["Never read or commit .env files or credentials."],
        },
      },
    },
    cwd,
  );
  assert.equal(isToolError(securityResult), false);
  const repaired = readJson(tools.canonicalMapPath(cwd));
  assert.equal(repaired.coverage.D3_type_contract.status, "covered");
  assert.equal(repaired.coverage.D8_security.status, "covered");
  assert.match(resultText(securityResult), /All 10 coverage dimensions closed/);
}

async function testObservabilityAndFactoryContract(): Promise<void> {
  resetReserveCounters();
  const cwd = tempDir("reserve");
  const tools = createWriteMapTools({
    stateDir: ".agentify/runtime/audit-b",
    mapFilename: "custom-map.json",
  });
  assert.equal(tools.canonicalMapRelative, ".agentify/runtime/audit-b/custom-map.json");
  assert.equal(tools.draftDirectoryRelative, ".agentify/runtime/audit-b/.agentify");
  assert.equal(tools.draftPathRelative, ".agentify/runtime/audit-b/.agentify/draft.json");
  assert.equal(tools.historyRelative, ".agentify/runtime/audit-b/history");
  assert.equal(tools.canonicalMapPath(cwd), path.join(cwd, ".agentify/runtime/audit-b/custom-map.json"));

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

  const piTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  assert.equal(piTools.canonicalMapRelative, ".agentify/runtime/audit/codebase_map.json");
  assert.equal(piTools.draftDirectoryRelative, ".agentify/runtime/audit/.agentify");
  assert.equal(piTools.draftPathRelative, ".agentify/runtime/audit/.agentify/draft.json");
  assert.equal(piTools.historyRelative, ".agentify/runtime/audit/history");

  const piCwd = tempDir("pi-explicit");
  const piPath = piTools.canonicalMapPath(piCwd);
  fs.mkdirSync(path.dirname(piPath), { recursive: true });
  fs.writeFileSync(piPath, `\ufeff${JSON.stringify(cloneMap())}`);
  assert.ok(loadCanonicalMapAt(piCwd, ".agentify/runtime/audit"));
  assert.equal(loadCanonicalMapAt(piCwd, ".agentify/runtime/audit-a"), null);
}

async function testBootstrapMapRejectsRegressiveFullWrite(): Promise<void> {
  const cwd = tempDir("bootstrap-regression");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  const accumulated = cloneMap();
  accumulated.exploration_log.unshift({
    ts: new Date().toISOString(),
    action: "draft_bootstrap",
    target: ".",
    observation: "Initial gap-marked audit map.",
  });
  const initial = await executeTool(tools.writeMapTool, { map: accumulated }, cwd);
  assert.equal(isToolError(initial), false);

  const rejected = await executeTool(tools.writeMapTool, { map: createGapDraftMap() }, cwd);
  assert.equal(isToolError(rejected), true);
  assert.match(resultText(rejected), /would discard previously recorded audit evidence/);
  assert.equal(readJson(tools.canonicalMapPath(cwd)).coverage.D1_topography.status, "covered");
}

async function testRepairsDoubleWrappedAndBatchedTransports(): Promise<void> {
  const cwd = tempDir("transport-wrap");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });

  // A full map nested one level deep (`map.map`) is unwrapped and written.
  const wrapped = await executeTool(
    tools.writeMapTool,
    { map: { map: cloneMap() } },
    cwd,
  );
  assert.equal(isToolError(wrapped), false, resultText(wrapped));
  assert.equal(readJson(tools.canonicalMapPath(cwd)).meta.project_type, "test-fixture");

  // A delta nested as `delta.delta` is unwrapped.
  const nestedDelta = await executeTool(
    tools.writeMapDeltaTool,
    { delta: { delta: { open_questions: ["unwrapped transport"] } } },
    cwd,
  );
  assert.equal(isToolError(nestedDelta), false, resultText(nestedDelta));
  assert.ok(readJson(tools.canonicalMapPath(cwd)).open_questions.includes("unwrapped transport"));

  // Several dimension deltas batched as an array are deep-merged in order.
  const batched = await executeTool(
    tools.writeMapDeltaTool,
    {
      delta: [
        { open_questions: ["batched-one"] },
        { open_questions: ["batched-two"], pitfalls: [{
          module: "src/index.ts",
          what: "Batched delta pitfall.",
          consequence: "None; transport repair test.",
          line_ref: 7,
        }] },
      ],
    },
    cwd,
  );
  assert.equal(isToolError(batched), false, resultText(batched));
  const mergedMap = readJson(tools.canonicalMapPath(cwd));
  assert.ok(mergedMap.open_questions.includes("batched-two"));
  assert.ok(mergedMap.pitfalls.some((pitfall) => pitfall.what === "Batched delta pitfall."));

  // Non-object array entries still fail with the documented delta error, now
  // with a compact description of what was actually received.
  const invalid = await executeTool(
    tools.writeMapDeltaTool,
    { delta: ["not-an-object"] },
    cwd,
  );
  assert.equal(isToolError(invalid), true);
  assert.match(resultText(invalid), /requires `delta` to be a JSON object/);
  assert.match(resultText(invalid), /Received: an array of 1 item\(s\)/);

  const invalidString = await executeTool(
    tools.writeMapDeltaTool,
    { delta: "not json at all" },
    cwd,
  );
  assert.equal(isToolError(invalidString), true);
  assert.match(resultText(invalidString), /Received: a string \(15 chars\) starting with "not json at all"/);

  // A markdown-fenced JSON delta is unwrapped before parsing.
  const fenced = await executeTool(
    tools.writeMapDeltaTool,
    { delta: "```json\n{\"open_questions\": [\"fenced transport\"]}\n```" },
    cwd,
  );
  assert.equal(isToolError(fenced), false, resultText(fenced));
  assert.ok(readJson(tools.canonicalMapPath(cwd)).open_questions.includes("fenced transport"));

  // A delta whose quotes were escaped one level too many (the payload arrived
  // as the content of a JSON string literal) is decoded one layer and parsed.
  const overEscaped = await executeTool(
    tools.writeMapDeltaTool,
    { delta: '{\\"open_questions\\": [\\"over-escaped transport\\"]}' },
    cwd,
  );
  assert.equal(isToolError(overEscaped), false, resultText(overEscaped));
  assert.ok(readJson(tools.canonicalMapPath(cwd)).open_questions.includes("over-escaped transport"));

  // A delta string with a raw newline inside a string value is repaired by
  // escaping control characters inside string literals only.
  const rawNewline = await executeTool(
    tools.writeMapDeltaTool,
    { delta: "{\"open_questions\": [\"first line\nsecond line\"]}" },
    cwd,
  );
  assert.equal(isToolError(rawNewline), false, resultText(rawNewline));
  assert.ok(readJson(tools.canonicalMapPath(cwd)).open_questions.includes("first line\nsecond line"));

  // A full map wrapped in a single-item array is unwrapped.
  const arrayCwd = tempDir("transport-array-map");
  const arrayTools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const arrayWrapped = await executeTool(
    arrayTools.writeMapTool,
    { map: [cloneMap()] },
    arrayCwd,
  );
  assert.equal(isToolError(arrayWrapped), false, resultText(arrayWrapped));
  assert.equal(readJson(arrayTools.canonicalMapPath(arrayCwd)).meta.project_type, "test-fixture");

  // A delta with a dangling comma before a closing delimiter is repaired
  // outside string literals only.
  const trailingComma = await executeTool(
    tools.writeMapDeltaTool,
    { delta: '{"open_questions": ["trailing comma"],}' },
    cwd,
  );
  assert.equal(isToolError(trailingComma), false, resultText(trailingComma));
  assert.ok(readJson(tools.canonicalMapPath(cwd)).open_questions.includes("trailing comma"));
}

async function testHoistsMetaNestedEvidenceSections(): Promise<void> {
  const cwd = tempDir("meta-nested-evidence");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const base = cloneMap();
  delete base.expert_evidence;
  const initial = await executeTool(tools.writeMapTool, { map: base }, cwd);
  assert.equal(isToolError(initial), false);
  assert.match(resultText(initial), /Concern evidence is not recorded yet/);

  const wellFormedDomain = {
    domain: "billing",
    rationale: "Recurring payment invariants.",
    primary_paths: ["src/billing"],
    entry_points: ["src/billing/index.ts"],
    test_paths: ["tests/billing.test.ts"],
    key_files: [{ path: "src/billing/index.ts", purpose: "Billing entry point.", line_range: [1, 120] }],
    key_types: [{ name: "Invoice", path: "src/billing/types.ts:1", purpose: "Stable billing contract." }],
    patterns: [{ name: "idempotency", description: "Writes must be idempotent.", example_ref: "src/billing/index.ts:42" }],
    pitfalls: [{ risk: "Double charging on retry.", consequence: "Customers can be charged twice.", reference: "src/billing/index.ts:55" }],
    conventions: ["Amounts are stored in cents."],
    stability: "high",
    recurrence: "high",
    test_command: "npm test -- tests/billing.test.ts",
    last_updated: "2026-08-20T00:00:00.000Z",
  };
  const hoisted = await executeTool(
    tools.writeMapDeltaTool,
    { delta: { meta: { expert_evidence: { expert_domains: [wellFormedDomain] } } } },
    cwd,
  );
  assert.equal(isToolError(hoisted), false, resultText(hoisted));
  const repaired = readJson(tools.canonicalMapPath(cwd));
  assert.equal(repaired.expert_evidence?.expert_domains.length, 1);
  assert.equal(repaired.expert_evidence?.expert_domains[0]?.domain, "billing");
  assert.equal((repaired.meta as Record<string, unknown>).expert_evidence, undefined);
  assert.equal(resultDetails(hoisted).specialist_evidence_recorded, true);
  assert.ok(!resultText(hoisted).includes("Concern evidence is not recorded yet"));

  // A misplaced but malformed section is hoisted into the real schema gate,
  // which rejects it with an actionable error instead of silently keeping it.
  const malformed = await executeTool(
    tools.writeMapDeltaTool,
    { delta: { meta: { customization_evidence: { custom_tool_candidates: [{ wrong: true }] } } } },
    cwd,
  );
  assert.equal(isToolError(malformed), true);
  assert.match(resultText(malformed), /failed schema validation/i);
  const afterMalformed = readJson(tools.canonicalMapPath(cwd));
  assert.equal((afterMalformed.meta as Record<string, unknown>).customization_evidence, undefined);
  assert.equal(afterMalformed.customization_evidence, undefined);
}

async function testHoistsMetaLifecycleConcernsToCanonicalConcernEvidence(): Promise<void> {
  const cwd = tempDir("meta-lifecycle-concerns");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const base = cloneMap();
  delete base.expert_evidence;
  delete base.concern_evidence;
  await executeTool(tools.writeMapTool, { map: base }, cwd);

  // The aqa-tests failure: the model wrote a real, traced concerns array
  // under `meta.lifecycle.concerns`, with the wrapper as a sibling under
  // `meta.lifecycle.concern_evidence`. Neither layer matches the documented
  // misplacement path; the hoist must look one level deeper to recover the
  // concerns and the audit must close.
  const sample = {
    concern: "test SDK and tooling provisioning",
    one_line: "Bootstraps a test workspace with a JDK binary and TKG.",
    covers: "SDK download, testenv.properties round-trip, TKG compile.",
    excludes: "What runs after provisioning.",
    flows: [],
    touchpoints: [
      {
        path: "get.sh",
        symbol: "getBinaryOpenjdk",
        role: "Single entry point for SDK download.",
        line_range: [1, 970],
        centrality: "core",
      },
    ],
    invariants: [],
    pitfalls: [],
    entry_questions: ["Does this change SDK acquisition?"],
    validation: [],
    spans_subtrees: ["get.sh", "scripts/testenv", "testenv"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-24T00:00:00.000Z",
  };
  const misplacement = {
    meta: {
      lifecycle: {
        concerns: [sample],
        concern_evidence: {
          concerns: [{ ...sample, concern: "playlist-driven JVM test inventory" }],
        },
      },
    },
  };
  const result = await executeTool(tools.writeMapDeltaTool, { delta: misplacement }, cwd);
  assert.equal(isToolError(result), false, resultText(result));

  const repaired = readJson(tools.canonicalMapPath(cwd));
  assert.ok(repaired.concern_evidence, "concern_evidence was not hoisted");
  const names = (repaired.concern_evidence?.concerns ?? []).map((concern: { concern: string }) => concern.concern);
  // Order is not part of the contract — both misplaced sources are merged.
  assert.deepEqual(names.sort(), [
    "playlist-driven JVM test inventory",
    "test SDK and tooling provisioning",
  ].sort());
  const metaRecord = repaired.meta as Record<string, unknown>;
  const lifecycleRecord = metaRecord.lifecycle as Record<string, unknown>;
  assert.equal(lifecycleRecord.concerns, undefined);
  assert.equal(lifecycleRecord.concern_evidence, undefined);
  assert.equal(resultDetails(result).specialist_evidence_recorded, true);
  assert.ok(!resultText(result).includes("Concern evidence is not recorded yet"));
}

async function testPreventsPrototypePollutionInDottedKeyExpansion(): Promise<void> {
  const cwd = tempDir("proto-pollution");
  const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
  const maliciousDelta = {
    "__proto__.polluted": "yes",
    "constructor.prototype.polluted2": "yes",
    skeleton: {
      top_level_tree: ["src/"],
    },
  };
  await executeTool(tools.writeMapDeltaTool, { delta: maliciousDelta }, cwd);
  assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted2, undefined);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "tool definition contract", fn: testToolDefinitionContract },
  { name: "nullable object transport normalization", fn: testNullableObjectTransportNormalization },
  { name: "provider misnested inline map repair", fn: testRepairsProviderMisnestedInlineMap },
  { name: "provider unwrapped inline map repair", fn: testRepairsProviderUnwrappedInlineMap },
  { name: "codebase map transport alias", fn: testAcceptsCodebaseMapTransportAlias },
  { name: "premature empty artifact intents are dropped", fn: testDropsWhollyEmptyPrematureArtifactIntents },
  { name: "incremental artifact intent lists are completed", fn: testCompletesIncrementalArtifactIntentLists },
  { name: "numeric validation evidence is normalized", fn: testNormalizesNumericValidationEvidence },
  { name: "pitfall line references are normalized", fn: testNormalizesPitfallLineReferences },
  { name: "provider serialized inline map repair", fn: testRepairsSerializedInlineMap },
  { name: "provider double-serialized inline map repair", fn: testRepairsDoubleSerializedInlineMap },
  { name: "serialized map executes after transport validation", fn: testExecutesSerializedInlineMapAfterTransportValidation },
  { name: "inline defaults coverage and storage contract", fn: testInlineDefaultsCoverageAndStorageContract },
  { name: "input loading and draft contract", fn: testInputLoadingAndDraftContract },
  { name: "history validation coverage and merge contract", fn: testHistoryValidationCoverageAndMergeContract },
  { name: "observability and explicit factory contract", fn: testObservabilityAndFactoryContract },
  { name: "bootstrap map rejects regressive full write", fn: testBootstrapMapRejectsRegressiveFullWrite },
  { name: "double-wrapped and batched transports are repaired", fn: testRepairsDoubleWrappedAndBatchedTransports },
  { name: "meta-nested evidence sections are hoisted", fn: testHoistsMetaNestedEvidenceSections },
  { name: "meta-lifecycle concerns are hoisted to canonical concern_evidence", fn: testHoistsMetaLifecycleConcernsToCanonicalConcernEvidence },
  { name: "substance failures persist as gaps with repair guidance", fn: testSubstanceFailuresPersistAsGapsWithRepairGuidance },
  { name: "prevents prototype pollution in dotted key expansion", fn: testPreventsPrototypePollutionInDottedKeyExpansion },
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
