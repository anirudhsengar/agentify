import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { CodebaseMapSchema } from "../src/core/audit/schema.ts";
import { renderBrownfieldArtifacts } from "../src/core/artifacts/renderers.ts";
import { AGENTIFY_MANAGED_MARKERS } from "../src/core/artifact-exporters.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";

function makeIntentMap() {
  return makeValidCodebaseMap({
    artifact_intents: {
      agent_guide: {
        title: "Agent Guide",
        sections: [
          { heading: "Build", body: "Run `npm test` before review." },
          { heading: "Pitfalls", body: "Do not edit generated files by hand." },
        ],
      },
      always_on_docs: [
        { path: "specs/README.md", title: "Specs", body: "Spec guidance." },
        { path: "ai_docs/README.md", title: "AI Docs", body: "AI context." },
      ],
      feature_agents: [
        {
          name: "payments",
          description: "Payments specialist.",
          globs: ["src/payments"],
          body: "Use payment invariants.",
        },
      ],
      prompt_templates: [
        {
          name: "db-migration",
          description: "Use for database migrations.",
          body: "Check migrations before app code.",
        },
      ],
      experts: [
        {
          name: "billing",
          domain: "Billing",
          body: "Ask billing questions.",
        },
      ],
      extension_candidates: [
        {
          name: "migration-check",
          description: "Checks migration safety.",
          body: "export const name = 'migration-check';\n",
        },
      ],
      scaffold_runtime: {
        state_machine_notes: ["Use the default state contract."],
      },
    },
  });
}

function testRendersIntentBundleDeterministically(): void {
  const map = makeIntentMap();
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
  assert.ok(paths.includes(".pi/prompts/experts/billing.md"));
  assert.ok(paths.includes(".pi/extensions/migration-check.ts"));
  assert.ok(first.artifacts.every((artifact) => artifact.content.includes(artifact.marker)));
}

function testSchemaRejectsUnsafeIntentNamesAndPaths(): void {
  const unsafe = makeIntentMap() as unknown as { artifact_intents: { feature_agents: Array<{ name: string; globs: string[] }> } };
  unsafe.artifact_intents.feature_agents[0].name = "bad/name";
  unsafe.artifact_intents.feature_agents[0].globs = ["../secrets"];
  assert.equal(Value.Check(CodebaseMapSchema, unsafe), false);
}

function testRendererRejectsOversizedAgentsMd(): void {
  const map = makeIntentMap();
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
}

const tests: Array<{ name: string; fn: () => void }> = [
  { name: "rendersIntentBundleDeterministically", fn: testRendersIntentBundleDeterministically },
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
