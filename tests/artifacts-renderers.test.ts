import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { CodebaseMapSchema } from "../src/core/audit/schema.ts";
import { renderBrownfieldArtifacts, renderValidatedBrownfieldArtifacts } from "../src/core/artifacts/renderers.ts";
import { AGENTIFY_MANAGED_MARKERS } from "../src/core/artifact-exporters.ts";
import { ExpertRegistry } from "../src/core/agent-expert.ts";
import { WorkflowRegistry } from "../src/core/orchestrator/workflow-registry.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";
import { makeRendererIntentMap } from "./fixtures/renderer-maps.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeArtifacts(cwd: string, result: ReturnType<typeof renderBrownfieldArtifacts>): void {
  for (const artifact of result.artifacts) {
    const filePath = path.join(cwd, artifact.relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, artifact.content);
  }
}

function testRendersIntentBundleDeterministically(): void {
  const map = makeRendererIntentMap();
  const first = renderBrownfieldArtifacts(map);
  const second = renderBrownfieldArtifacts(map);
  assert.deepEqual(second, first);
  assert.deepEqual(first.errors, []);
  const paths = first.artifacts.map((artifact) => artifact.relativePath).sort();
  assert.ok(paths.includes("AGENTS.md"));
  assert.ok(paths.includes("specs/README.md"));
  assert.ok(paths.includes("ai_docs/README.md"));
  assert.ok(paths.includes(".pi/agents/payments.md"));
  assert.ok(paths.includes(".pi/prompts/db-migration.md"));
  assert.ok(paths.includes(".pi/prompts/experts/billing/expertise.yaml"));
  assert.ok(paths.includes(".pi/prompts/experts/billing/question.md"));
  assert.ok(paths.includes(".pi/prompts/experts/billing/self-improve.md"));
  assert.ok(paths.includes(".pi/extensions/migration-check.ts"));
  assert.ok(paths.includes(".pi/workflows/payments-plan-build-review-fix.json"));
  assert.ok(first.artifacts.every((artifact) =>
    artifact.marker === "sha256" || artifact.content.includes(artifact.marker)
  ));
}

function testRenderedExpertsAreDiscoverableByRuntime(): void {
  const cwd = tempDir("agentify-rendered-experts-");
  try {
    const result = renderBrownfieldArtifacts(makeRendererIntentMap());
    assert.deepEqual(result.errors, []);
    writeArtifacts(cwd, result);

    const registry = ExpertRegistry.fromCwd(cwd);
    const expert = registry.get("billing");
    assert.ok(expert);
    assert.equal(expert.domain, "billing");
    assert.ok(expert.expertisePath.endsWith(".pi/prompts/experts/billing/expertise.yaml"));
    assert.ok(expert.questionPath.endsWith(".pi/prompts/experts/billing/question.md"));
    assert.ok(expert.selfImprovePath.endsWith(".pi/prompts/experts/billing/self-improve.md"));
    assert.equal(expert.lastUpdated, "2026-07-05T00:00:00.000Z");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function testRenderedProjectWorkflowsAreDiscoverableByRuntime(): void {
  const cwd = tempDir("agentify-rendered-workflows-");
  const configDir = tempDir("agentify-rendered-workflows-config-");
  try {
    const result = renderBrownfieldArtifacts(makeRendererIntentMap());
    assert.deepEqual(result.errors, []);
    writeArtifacts(cwd, result);

    const workflowArtifact = result.artifacts.find((artifact) =>
      artifact.relativePath === ".pi/workflows/payments-plan-build-review-fix.json"
    );
    assert.ok(workflowArtifact, "expected payments project workflow to be rendered");
    assert.equal(workflowArtifact.kind, "workflow");

    const registry = WorkflowRegistry.fromCwd(cwd, configDir);
    const workflow = registry.get("payments_plan_build_review_fix");
    assert.ok(workflow, "expected generated workflow to be discoverable");
    assert.equal(workflow?.steps.length, 2);
    assert.equal(workflow?.steps[0]?.handler, "subagent");
    assert.equal(workflow?.steps[0]?.subagent_template, "payments");
    assert.equal(workflow?.steps[1]?.handler, "aiw");
    assert.equal(workflow?.steps[1]?.workflow_type, "plan_build_review_fix");
    assert.match(workflow?.steps[1]?.prompt ?? "", /\$\{agents\[scout\]\.result_text\}/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function testRendersFeedbackLoopStorageAndSkillCandidates(): void {
  const result = renderBrownfieldArtifacts(makeRendererIntentMap());
  assert.deepEqual(result.errors, []);
  const byPath = new Map(result.artifacts.map((artifact) => [artifact.relativePath, artifact]));

  for (const requiredPath of [
    "app_review/README.md",
    "app_docs/README.md",
    "app_fix_reports/README.md",
    "app_docs/agentic_kpis.md",
    ".pi/conditional_docs.md",
    ".pi/skills/prime-db/SKILL.md",
  ]) {
    assert.ok(byPath.has(requiredPath), `expected ${requiredPath} to be rendered`);
    assert.ok(byPath.get(requiredPath)?.content.includes(byPath.get(requiredPath)!.marker));
  }

  const skill = byPath.get(".pi/skills/prime-db/SKILL.md")!;
  assert.equal(skill.kind, "skill");
  assert.match(skill.content, /^---\nname: prime-db\n/m);
  assert.match(skill.content, /Prime the local database before integration tests\./);
  assert.match(skill.content, /scripts\/prime-db\.sh <args>/);
}

function testRendersCustomToolCandidatesAsExtensions(): void {
  const result = renderBrownfieldArtifacts(makeRendererIntentMap());
  assert.deepEqual(result.errors, []);
  const extension = result.artifacts.find((artifact) => artifact.relativePath === ".pi/extensions/run-tests.ts");
  assert.ok(extension, "expected custom tool candidate to render as an extension");
  assert.equal(extension.kind, "extension");
  assert.match(extension.content, /const TOOL_NAME = "run-tests";/);
  assert.match(extension.content, /const COMMAND = "npm";/);
  assert.match(extension.content, /const ARGS = \["test"\];/);
  assert.match(extension.content, /execFileAsync/);
}

function testRendersLifecyclePromptTemplates(): void {
  const result = renderBrownfieldArtifacts(makeRendererIntentMap());
  assert.deepEqual(result.errors, []);
  const byPath = new Map(result.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  for (const promptPath of [
    ".pi/prompts/feature.md",
    ".pi/prompts/bug.md",
    ".pi/prompts/api-endpoint.md",
  ]) {
    assert.ok(byPath.has(promptPath), `expected ${promptPath} to be rendered`);
    assert.equal(byPath.get(promptPath)?.kind, "prompt");
  }
  assert.match(byPath.get(".pi/prompts/feature.md")!.content, /specs\/feature-<slug>\.md/);
  assert.match(byPath.get(".pi/prompts/api-endpoint.md")!.content, /api-endpoint-specific feature template/);
  assert.match(byPath.get(".pi/prompts/api-endpoint.md")!.content, /\.pi\/agents\/payments\.md/);
}

function testSchemaRejectsUnsafeIntentNamesAndPaths(): void {
  const unsafe = makeRendererIntentMap() as unknown as { artifact_intents: { feature_agents: Array<{ name: string; globs: string[] }> } };
  unsafe.artifact_intents.feature_agents[0].name = "bad/name";
  unsafe.artifact_intents.feature_agents[0].globs = ["../secrets"];
  assert.equal(Value.Check(CodebaseMapSchema, unsafe), false);
}

function testRendererRejectsOversizedAgentsMd(): void {
  const map = makeRendererIntentMap();
  map.artifact_intents!.agent_guide.sections = [
    { heading: "Too Long", body: Array.from({ length: 220 }, (_, index) => `line ${index}`).join("\n") },
  ];
  const result = renderBrownfieldArtifacts(map);
  assert.ok(result.errors.some((error) => error.includes("AGENTS.md would be")));
}

function testFallbackRendererProducesManagedCoreFiles(): void {
  const result = renderBrownfieldArtifacts(makeValidCodebaseMap());
  assert.deepEqual(result.errors, []);
  const agents = result.artifacts.find((artifact) => artifact.relativePath === "AGENTS.md");
  assert.ok(agents);
  assert.ok(agents.content.includes(AGENTIFY_MANAGED_MARKERS.markdown));
  assert.ok(result.artifacts.some((artifact) => artifact.relativePath === ".pi/agents/payments.md"));
  assert.ok(result.artifacts.some((artifact) => artifact.relativePath === ".pi/workflows/payments-plan-build-review-fix.json"));
}

function testMatchesGoldenRendererOutputs(): void {
  const golden = JSON.parse(fs.readFileSync(
    new URL("./fixtures/renderer-golden.json", import.meta.url),
    "utf8",
  ));
  const full = makeRendererIntentMap();
  const sparse = makeValidCodebaseMap();
  const coverageIncomplete = makeValidCodebaseMap();
  const firstCoverageKey = Object.keys(coverageIncomplete.coverage)[0] as keyof typeof coverageIncomplete.coverage;
  coverageIncomplete.coverage[firstCoverageKey] = {
    ...coverageIncomplete.coverage[firstCoverageKey],
    status: "gap",
  };
  const unsafe = makeRendererIntentMap() as any;
  unsafe.artifact_intents.feature_agents[0].name = "bad/name";
  unsafe.artifact_intents.extension_candidates[0].name = "bad extension";
  unsafe.artifact_intents.always_on_docs.push({ path: "../escape.md", title: "Escape", body: "Unsafe." });
  const duplicate = makeRendererIntentMap() as any;
  duplicate.artifact_intents.extension_candidates.push({
    name: "run-tests",
    description: "Conflicts with the generated custom tool extension.",
    body: "export const duplicate = true;",
  });
  assert.deepEqual(renderBrownfieldArtifacts(full), golden.full);
  assert.deepEqual(renderBrownfieldArtifacts(sparse), golden.sparse);
  assert.deepEqual(renderValidatedBrownfieldArtifacts({}), golden.invalidSchema);
  assert.deepEqual(renderValidatedBrownfieldArtifacts(coverageIncomplete), golden.coverageIncomplete);
  assert.deepEqual(renderBrownfieldArtifacts(unsafe), golden.unsafe);
  assert.deepEqual(renderBrownfieldArtifacts(duplicate), golden.duplicate);
}

const tests: Array<{ name: string; fn: () => void }> = [
  { name: "matchesGoldenRendererOutputs", fn: testMatchesGoldenRendererOutputs },
  { name: "rendersIntentBundleDeterministically", fn: testRendersIntentBundleDeterministically },
  { name: "renderedExpertsAreDiscoverableByRuntime", fn: testRenderedExpertsAreDiscoverableByRuntime },
  { name: "renderedProjectWorkflowsAreDiscoverableByRuntime", fn: testRenderedProjectWorkflowsAreDiscoverableByRuntime },
  { name: "rendersFeedbackLoopStorageAndSkillCandidates", fn: testRendersFeedbackLoopStorageAndSkillCandidates },
  { name: "rendersCustomToolCandidatesAsExtensions", fn: testRendersCustomToolCandidatesAsExtensions },
  { name: "rendersLifecyclePromptTemplates", fn: testRendersLifecyclePromptTemplates },
  { name: "schemaRejectsUnsafeIntentNamesAndPaths", fn: testSchemaRejectsUnsafeIntentNamesAndPaths },
  { name: "rendererRejectsOversizedAgentsMd", fn: testRendererRejectsOversizedAgentsMd },
  { name: "fallbackRendererProducesManagedCoreFiles", fn: testFallbackRendererProducesManagedCoreFiles },
];

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`artifact renderer tests passed (${passed}/${tests.length}).`);
