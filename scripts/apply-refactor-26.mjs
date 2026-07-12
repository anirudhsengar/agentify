import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function write(relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`missing ${label}`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`non-unique ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceAllChecked(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected}, found ${count}`);
  return source.split(before).join(after);
}

let mapTool = read("src/core/audit/write-map-tool.ts");
mapTool = replaceOnce(
  mapTool,
  'import * as fs from "node:fs";\nimport * as path from "node:path";',
  'import { AsyncLocalStorage } from "node:async_hooks";\nimport * as fs from "node:fs";\nimport * as path from "node:path";',
  "async local storage import",
);
mapTool = replaceOnce(
  mapTool,
  "let currentSessionStateDir = LEGACY_PI_STATE_RELATIVE_DIR;",
  `interface MapToolExecutionContext {\n  stateDir: string;\n  mapFilename: string;\n}\n\nconst mapToolExecutionContext = new AsyncLocalStorage<MapToolExecutionContext>();\nlet currentSessionStateDir = LEGACY_PI_STATE_RELATIVE_DIR;\n\nfunction activeMapPathConfig(): MapToolExecutionContext {\n  return mapToolExecutionContext.getStore() ?? {\n    stateDir: currentSessionStateDir,\n    mapFilename: MAP_FILENAME,\n  };\n}`,
  "legacy state global",
);
mapTool = replaceOnce(
  mapTool,
  "/**\n * Set the per-session state dir that the legacy `writeMapTool` and",
  "/**\n * @deprecated Production callers must use `createWriteMapTools({ stateDir })`.\n * Set the per-session state dir that the legacy `writeMapTool` and",
  "setter deprecation",
);
mapTool = replaceOnce(
  mapTool,
  "  canonicalMapRelative: string;\n}",
  `  canonicalMapRelative: string;\n  /** Selected-state draft directory. The final draft file remains the legacy\n   * path until Issue #31 resolves migration behavior. */\n  draftDirectoryRelative: string;\n  /** Historical provider-agnostic draft file path, preserved for parity. */\n  draftPathRelative: string;\n  /** Selected-state previous-map history directory. */\n  historyRelative: string;\n}`,
  "MapTools path surface",
);
mapTool = replaceOnce(
  mapTool,
  "function writeCanonicalMap(cwd: string, map: CodebaseMap): { path: string; size_bytes: number } {\n    const dir = path.join(cwd, currentSessionStateDir);",
  "function writeCanonicalMap(cwd: string, map: CodebaseMap): { path: string; size_bytes: number } {\n    const config = activeMapPathConfig();\n    const dir = path.join(cwd, config.stateDir);",
  "canonical write context",
);
mapTool = replaceOnce(mapTool, "const existingPath = path.join(dir, MAP_FILENAME);", "const existingPath = path.join(dir, config.mapFilename);", "existing canonical path");
mapTool = replaceOnce(mapTool, "const filePath = path.join(dir, MAP_FILENAME);", "const filePath = path.join(dir, config.mapFilename);", "canonical output path");
mapTool = replaceOnce(
  mapTool,
  'const dir = path.join(cwd, currentSessionStateDir, ".agentify");',
  'const dir = path.join(cwd, activeMapPathConfig().stateDir, ".agentify");',
  "draft directory context",
);
mapTool = replaceOnce(
  mapTool,
  "function readCanonicalMap(cwd: string): CodebaseMap | null {\n    const filePath = path.join(cwd, AGENTIFY_OUTPUT_DIR, MAP_FILENAME);",
  `function readCanonicalMap(cwd: string): CodebaseMap | null {\n    // Factory-bound tools read their captured state. Deprecated singleton tools\n    // retain the historical legacy read path even when their write setter moves.\n    const scoped = mapToolExecutionContext.getStore();\n    const filePath = scoped\n      ? path.join(cwd, scoped.stateDir, scoped.mapFilename)\n      : path.join(cwd, AGENTIFY_OUTPUT_DIR, MAP_FILENAME);`,
  "canonical read context",
);
const factoryBlock = `\n\ntype ToolExecute = NonNullable<ToolDefinition["execute"]>;\n\nfunction bindToolToMapContext(\n  tool: ToolDefinition,\n  context: MapToolExecutionContext,\n): ToolDefinition {\n  const execute = tool.execute.bind(tool) as ToolExecute;\n  return {\n    ...tool,\n    execute: ((...args: Parameters<ToolExecute>) =>\n      mapToolExecutionContext.run(context, () => execute(...args))) as ToolExecute,\n  } as ToolDefinition;\n}\n\n/** Create state-directory-isolated write-map tools for one run. */\nexport function createWriteMapTools(config: MapPathConfig): MapTools {\n  const context: MapToolExecutionContext = Object.freeze({\n    stateDir: config.stateDir,\n    mapFilename: config.mapFilename ?? MAP_FILENAME,\n  });\n  const normalize = (value: string): string => value.replace(/\\\\/g, "/");\n  return {\n    writeMapTool: bindToolToMapContext(writeMapTool, context),\n    writeMapDeltaTool: bindToolToMapContext(writeMapDeltaTool, context),\n    canonicalMapPath: (cwd: string) => path.join(cwd, context.stateDir, context.mapFilename),\n    canonicalMapRelative: normalize(path.join(context.stateDir, context.mapFilename)),\n    draftDirectoryRelative: normalize(path.join(context.stateDir, ".agentify")),\n    // Preserve the mismatch tracked by Issue #31. Do not migrate silently here.\n    draftPathRelative: normalize(DRAFT_PATH),\n    historyRelative: normalize(path.join(context.stateDir, "history")),\n  };\n}\n`;
const lastToolEnd = mapTool.lastIndexOf("}) as unknown as ToolDefinition;");
if (lastToolEnd === -1) throw new Error("missing final tool definition");
const insertionPoint = lastToolEnd + "}) as unknown as ToolDefinition;".length;
mapTool = mapTool.slice(0, insertionPoint) + factoryBlock + mapTool.slice(insertionPoint);
write("src/core/audit/write-map-tool.ts", mapTool);

let renderers = read("src/core/artifacts/renderers.ts");
renderers = replaceOnce(
  renderers,
  "export function renderValidatedBrownfieldArtifacts(input: unknown): ValidatedRenderResult {",
  "export function renderValidatedBrownfieldArtifacts(\n  input: unknown,\n  context?: RenderContext | { stateDir?: string },\n): ValidatedRenderResult {",
  "validated renderer signature",
);
renderers = replaceOnce(
  renderers,
  "  return { ...renderBrownfieldArtifacts(map), validationErrors: [] };",
  "  return { ...renderBrownfieldArtifacts(map, context), validationErrors: [] };",
  "validated renderer delegation",
);
renderers = replaceOnce(
  renderers,
  `// Session-scoped state dir. The audit resolves its state dir at the\n// top of every run; the renderer helpers consult this via the\n// \`stateDirFor\` getter so the legacy literal doesn't need to be threaded\n// through every helper signature. Defaults to \`.pi\` — the same root\n// that hosts \`.pi/agents/\`, \`.pi/prompts/\`, etc. — so direct callers\n// (tests) get the historical paths. Production runs override this via\n// \`setRendererStateDir\` once the orchestrator has resolved the canonical\n// state dir for the current target set.\nlet currentRendererStateDir = ".pi";\n\n/** Set the per-session state dir used by the artifact renderers. */\nexport function setRendererStateDir(stateDir: string): void {\n  currentRendererStateDir = stateDir;\n}\n\nfunction stateDirFor(): string {\n  return currentRendererStateDir;\n}`,
  `export interface RenderContext {\n  stateDir: string;\n}\n\n// Deprecated direct callers retain the historical mutable default. Supported\n// production orchestration always supplies an explicit RenderContext.\nlet legacyRendererStateDir = ".pi";\n\n/** @deprecated Pass an explicit RenderContext to render functions. */\nexport function setRendererStateDir(stateDir: string): void {\n  legacyRendererStateDir = stateDir;\n}\n\nfunction resolveRenderContext(\n  context?: RenderContext | { stateDir?: string },\n): RenderContext {\n  return { stateDir: context?.stateDir ?? legacyRendererStateDir };\n}`,
  "renderer legacy context block",
);
renderers = replaceOnce(renderers, "function renderFallbackFeatureAgents(map: CodebaseMap): RenderedArtifact[] {", "function renderFallbackFeatureAgents(map: CodebaseMap, context: RenderContext): RenderedArtifact[] {", "fallback agent context");
renderers = replaceOnce(
  renderers,
  "function renderProjectWorkflowArtifacts(\n  map: CodebaseMap,\n  intents: ArtifactIntents | undefined,\n  errors: string[],\n): RenderedArtifact[] {",
  "function renderProjectWorkflowArtifacts(\n  map: CodebaseMap,\n  intents: ArtifactIntents | undefined,\n  errors: string[],\n  context: RenderContext,\n): RenderedArtifact[] {",
  "workflow context",
);
renderers = replaceOnce(renderers, "function renderSkillCandidate(skill: SkillCandidateIntent): RenderedArtifact {", "function renderSkillCandidate(skill: SkillCandidateIntent, context: RenderContext): RenderedArtifact {", "skill context");
renderers = replaceOnce(
  renderers,
  "function renderSkillCandidateArtifacts(map: CodebaseMap, errors: string[]): RenderedArtifact[] {",
  "function renderSkillCandidateArtifacts(map: CodebaseMap, errors: string[], context: RenderContext): RenderedArtifact[] {",
  "skill collection context",
);
renderers = replaceOnce(renderers, "artifacts.push(renderSkillCandidate(skill));", "artifacts.push(renderSkillCandidate(skill, context));", "skill context call");
renderers = replaceOnce(renderers, "function renderCustomToolCandidate(tool: CustomToolCandidateIntent): RenderedArtifact | null {", "function renderCustomToolCandidate(tool: CustomToolCandidateIntent, context: RenderContext): RenderedArtifact | null {", "custom tool context");
renderers = replaceOnce(
  renderers,
  "function renderCustomToolCandidateArtifacts(map: CodebaseMap, errors: string[]): RenderedArtifact[] {",
  "function renderCustomToolCandidateArtifacts(map: CodebaseMap, errors: string[], context: RenderContext): RenderedArtifact[] {",
  "custom tool collection context",
);
renderers = replaceOnce(renderers, "const artifact = renderCustomToolCandidate(tool);", "const artifact = renderCustomToolCandidate(tool, context);", "custom tool context call");
renderers = replaceAllChecked(renderers, "stateDirFor()", "context.stateDir", 4, "renderer state getter uses");
renderers = replaceOnce(
  renderers,
  "export function renderBrownfieldArtifacts(\n  map: CodebaseMap,\n  options?: { stateDir?: string },\n): RenderArtifactsResult {",
  "export function renderBrownfieldArtifacts(\n  map: CodebaseMap,\n  context?: RenderContext | { stateDir?: string },\n): RenderArtifactsResult {",
  "brownfield renderer signature",
);
renderers = replaceOnce(
  renderers,
  "  const intents = map.artifact_intents;\n  const stateDir = options?.stateDir ?? \".pi\";",
  "  const intents = map.artifact_intents;\n  const renderContext = resolveRenderContext(context);\n  const stateDir = renderContext.stateDir;",
  "brownfield context resolution",
);
renderers = replaceOnce(renderers, "renderProjectWorkflowArtifacts(map, intents, errors)", "renderProjectWorkflowArtifacts(map, intents, errors, renderContext)", "workflow context delegation");
renderers = replaceOnce(renderers, "renderFallbackFeatureAgents(map)", "renderFallbackFeatureAgents(map, renderContext)", "fallback context delegation");
renderers = replaceOnce(renderers, "renderSkillCandidateArtifacts(map, errors)", "renderSkillCandidateArtifacts(map, errors, renderContext)", "skill context delegation");
renderers = replaceOnce(renderers, "renderCustomToolCandidateArtifacts(map, errors)", "renderCustomToolCandidateArtifacts(map, errors, renderContext)", "custom tool context delegation");
write("src/core/artifacts/renderers.ts", renderers);

let brownfield = read("src/core/runs/brownfield-run.ts");
brownfield = replaceOnce(
  brownfield,
  "import {\n  renderValidatedBrownfieldArtifacts,\n  setRendererStateDir,\n} from \"../artifacts/renderers.ts\";",
  "import { renderValidatedBrownfieldArtifacts } from \"../artifacts/renderers.ts\";",
  "renderer imports",
);
brownfield = replaceOnce(
  brownfield,
  "import {\n  loadCanonicalMapAt,\n  setMapSessionStateDir,\n  writeMapDeltaTool,\n  writeMapTool,\n} from \"../audit/write-map-tool.ts\";",
  "import {\n  createWriteMapTools,\n  loadCanonicalMapAt,\n} from \"../audit/write-map-tool.ts\";",
  "map tool imports",
);
brownfield = replaceOnce(
  brownfield,
  `  // Pin structured writers and deterministic renderers before moving state.\n  // These setters are process-local and do not mutate the repository.\n  setMapSessionStateDir(stateDir);\n  setRendererStateDir(stateDir);`,
  `  // Capture the resolved state directory in run-owned tools and rendering context.\n  // Deprecated mutable adapters remain available only for direct legacy callers.\n  const mapTools = createWriteMapTools({ stateDir });`,
  "production state setters",
);
brownfield = replaceOnce(
  brownfield,
  "      customTools: [\n        writeMapTool,\n        writeMapDeltaTool,",
  "      customTools: [\n        mapTools.writeMapTool,\n        mapTools.writeMapDeltaTool,",
  "factory custom tools",
);
brownfield = replaceOnce(
  brownfield,
  "        ? renderValidatedBrownfieldArtifacts(map)",
  "        ? renderValidatedBrownfieldArtifacts(map, { stateDir })",
  "explicit renderer context",
);
write("src/core/runs/brownfield-run.ts", brownfield);

write("tests/core/state-directory-isolation.test.ts", `import assert from "node:assert/strict";\nimport * as fs from "node:fs";\nimport * as os from "node:os";\nimport * as path from "node:path";\nimport {\n  DRAFT_PATH,\n  createWriteMapTools,\n  setMapSessionStateDir,\n} from "../../src/core/audit/write-map-tool.ts";\nimport {\n  renderValidatedBrownfieldArtifacts,\n  setRendererStateDir,\n} from "../../src/core/artifacts/renderers.ts";\nimport { LEGACY_PI_STATE_RELATIVE_DIR } from "../../src/core/state-dir.ts";\nimport { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";\n\nfunction tempDir(name: string): string {\n  return fs.mkdtempSync(path.join(os.tmpdir(), \`agentify-\${name}-\`));\n}\n\nasync function executeWrite(\n  tool: ReturnType<typeof createWriteMapTools>["writeMapTool"],\n  cwd: string,\n  hypothesis: string,\n) {\n  const map = makeValidCodebaseMap();\n  map.meta.domain_hypothesis = hypothesis;\n  return tool.execute(\n    hypothesis,\n    { map } as never,\n    undefined,\n    undefined,\n    { cwd } as never,\n  );\n}\n\nasync function testFactoryPathsAndSameProcessIsolation(): Promise<void> {\n  const cwd = tempDir("map-factory-isolation");\n  const claude = createWriteMapTools({ stateDir: ".claude/agentify" });\n  const codex = createWriteMapTools({ stateDir: ".codex/agentify" });\n  try {\n    assert.equal(claude.canonicalMapRelative, ".claude/agentify/codebase_map.json");\n    assert.equal(claude.draftDirectoryRelative, ".claude/agentify/.agentify");\n    assert.equal(claude.draftPathRelative, DRAFT_PATH);\n    assert.equal(claude.historyRelative, ".claude/agentify/history");\n    assert.equal(\n      claude.canonicalMapPath(cwd),\n      path.join(cwd, ".claude/agentify", "codebase_map.json"),\n    );\n\n    setMapSessionStateDir(".pi/should-not-affect-factories");\n    const [claudeResult, codexResult] = await Promise.all([\n      executeWrite(claude.writeMapTool, cwd, "claude isolated"),\n      executeWrite(codex.writeMapTool, cwd, "codex isolated"),\n    ]);\n    assert.notEqual(claudeResult.isError, true);\n    assert.notEqual(codexResult.isError, true);\n\n    const claudeMap = JSON.parse(fs.readFileSync(claude.canonicalMapPath(cwd), "utf8"));\n    const codexMap = JSON.parse(fs.readFileSync(codex.canonicalMapPath(cwd), "utf8"));\n    assert.equal(claudeMap.meta.domain_hypothesis, "claude isolated");\n    assert.equal(codexMap.meta.domain_hypothesis, "codex isolated");\n  } finally {\n    setMapSessionStateDir(LEGACY_PI_STATE_RELATIVE_DIR);\n    fs.rmSync(cwd, { recursive: true, force: true });\n  }\n}\n\nasync function testFailureDoesNotLeakIntoAnotherFactory(): Promise<void> {\n  const cwd = tempDir("map-factory-failure");\n  const failed = createWriteMapTools({ stateDir: ".claude/agentify" });\n  const healthy = createWriteMapTools({ stateDir: ".codex/agentify" });\n  try {\n    const invalid = await failed.writeMapTool.execute(\n      "invalid",\n      { map: {} } as never,\n      undefined,\n      undefined,\n      { cwd } as never,\n    );\n    assert.equal(invalid.isError, true);\n\n    const result = await executeWrite(healthy.writeMapTool, cwd, "healthy after failure");\n    assert.notEqual(result.isError, true);\n    assert.ok(fs.existsSync(healthy.canonicalMapPath(cwd)));\n    assert.ok(!fs.existsSync(failed.canonicalMapPath(cwd)));\n  } finally {\n    fs.rmSync(cwd, { recursive: true, force: true });\n  }\n}\n\nfunction testExplicitRendererContextsAreIsolated(): void {\n  const map = makeValidCodebaseMap();\n  delete map.artifact_intents;\n  map.meta.suggested_subagent_domains = ["payments"];\n\n  setRendererStateDir(".pi/should-not-affect-explicit-contexts");\n  try {\n    const claude = renderValidatedBrownfieldArtifacts(map, { stateDir: ".claude/agentify" });\n    const codex = renderValidatedBrownfieldArtifacts(map, { stateDir: ".codex/agentify" });\n    assert.equal(claude.errors.length, 0, claude.errors.join("\\n"));\n    assert.equal(codex.errors.length, 0, codex.errors.join("\\n"));\n    assert.ok(claude.artifacts.some((artifact) => artifact.relativePath === ".claude/agentify/agents/payments.md"));\n    assert.ok(codex.artifacts.some((artifact) => artifact.relativePath === ".codex/agentify/agents/payments.md"));\n    assert.ok(!claude.artifacts.some((artifact) => artifact.relativePath.startsWith(".codex/agentify/")));\n    assert.ok(!codex.artifacts.some((artifact) => artifact.relativePath.startsWith(".claude/agentify/")));\n  } finally {\n    setRendererStateDir(".pi");\n  }\n}\n\nawait testFactoryPathsAndSameProcessIsolation();\nawait testFailureDoesNotLeakIntoAnotherFactory();\ntestExplicitRendererContextsAreIsolated();\nconsole.log("explicit state-directory isolation tests passed.");\n`);

write("tests/core/state-context-production-ownership.test.ts", `import assert from "node:assert/strict";\nimport * as fs from "node:fs";\n\nconst brownfield = fs.readFileSync("src/core/runs/brownfield-run.ts", "utf8");\nconst mapTool = fs.readFileSync("src/core/audit/write-map-tool.ts", "utf8");\nconst renderers = fs.readFileSync("src/core/artifacts/renderers.ts", "utf8");\n\nassert.doesNotMatch(brownfield, /setMapSessionStateDir/);\nassert.doesNotMatch(brownfield, /setRendererStateDir/);\nassert.match(brownfield, /createWriteMapTools\\(\\{ stateDir \\}\\)/);\nassert.match(brownfield, /mapTools\\.writeMapTool/);\nassert.match(brownfield, /mapTools\\.writeMapDeltaTool/);\nassert.match(brownfield, /renderValidatedBrownfieldArtifacts\\(map, \\{ stateDir \\}\\)/);\n\nassert.match(mapTool, /AsyncLocalStorage<MapToolExecutionContext>/);\nassert.match(mapTool, /export function createWriteMapTools/);\nassert.match(mapTool, /@deprecated Production callers must use/);\nassert.match(renderers, /export interface RenderContext/);\nassert.match(renderers, /@deprecated Pass an explicit RenderContext/);\nassert.doesNotMatch(renderers, /stateDirFor\\(\\)/);\n\nconsole.log("production state-context ownership tests passed.");\n`);

console.log("Issue #26 explicit state-context extraction applied.");
