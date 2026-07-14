import assert from "node:assert/strict";
import { renderBrownfieldArtifacts as renderBrownfieldWithContext, type RenderedArtifact } from "../src/core/artifacts/renderers.ts";
import type { CodebaseMap } from "../src/core/audit/schema.ts";

const renderBrownfieldArtifacts = (map: CodebaseMap) => renderBrownfieldWithContext(map, { stateDir: ".pi" });
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";

function byPath(artifacts: RenderedArtifact[]): Map<string, RenderedArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
}


function assertContains(content: string, pattern: RegExp, label: string): void {
  assert.match(content, pattern, `missing ${label}`);
}

function artifactContent(artifacts: Map<string, RenderedArtifact>, relativePath: string): string {
  const artifact = artifacts.get(relativePath);
  assert.ok(artifact, `missing artifact ${relativePath}`);
  return artifact.content;
}

export function testGeneratedCodeSurfacePreservesSourceOfTruthBoundaries(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "next-graphql-generated-code",
      languages: ["typescript", "graphql"],
      frameworks: ["next", "graphql-codegen", "zod"],
      domain_hypothesis: "A dashboard app where GraphQL schema and generated TypeScript clients must stay in sync.",
      suggested_subagent_domains: ["graphql", "generated-client"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["src/graphql/", "src/generated/", "src/features/orders/", "codegen.ts"],
      entry_points: [
        { path: "src/features/orders/order-dashboard.tsx", role: "orders dashboard route", language: "typescript", run_command: "npm run dev" },
        { path: "src/graphql/schema.graphql", role: "GraphQL source schema", language: "graphql", run_command: "npm run codegen" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "src/graphql/schema.graphql", why: "Source of truth for generated GraphQL operation and type outputs." },
        { path: "src/graphql/operations/orders.graphql", why: "Order dashboard operation definitions consumed by codegen." },
        { path: "codegen.ts", why: "Code generator config and output ownership rules." },
        { path: "src/generated/graphql.ts", why: "Generated client output; inspect but do not hand-edit." },
        { path: "src/features/orders/order-dashboard.tsx", why: "User-facing dashboard consuming generated query types." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "src/graphql/schema.graphql", to: "src/generated/graphql.ts", kind: "codegen source" },
        { from: "src/graphql/operations/orders.graphql", to: "src/generated/graphql.ts", kind: "operation codegen" },
        { from: "src/generated/graphql.ts", to: "src/features/orders/order-dashboard.tsx", kind: "typed generated client import" },
      ],
      shared_abstractions: [
        "src/generated/graphql.ts is derived output; schema and operation files are the editable source of truth.",
      ],
    },
    pitfalls: [
      {
        module: "src/generated/graphql.ts",
        what: "Never hand-edit generated GraphQL client types.",
        consequence: "The next codegen run will erase manual fixes and can leave UI code compiled against phantom fields.",
        line_ref: 1,
      },
      {
        module: "src/graphql/schema.graphql",
        what: "Schema changes must be paired with operation updates and regenerated TypeScript.",
        consequence: "Runtime queries can drift from generated types even while local UI code appears type-safe.",
        line_ref: 12,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "npm run test -- orders-dashboard",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: "npm run e2e -- orders",
      per_change_type: {
        chore: { mandatory: ["npm run codegen", "npm run typecheck"], optional: ["npm run lint"] },
        bug: { mandatory: ["npm run codegen", "npm run typecheck", "npm run test -- orders-dashboard"], optional: [] },
        feature: { mandatory: ["npm run codegen", "npm run typecheck", "npm run e2e -- orders"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /src\/graphql\/schema\.graphql/, "generated-code source schema first file");
  assertContains(agentsMd, /Never hand-edit generated GraphQL client types/, "generated-code no-hand-edit pitfall");
  assertContains(agentsMd, /feature: `npm run codegen`, `npm run typecheck`, `npm run e2e -- orders`/, "generated-code feature validation");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /src\/graphql\/schema\.graphql.*src\/generated\/graphql\.ts/, "generated-code schema to output edge");
  assertContains(aiDocs, /src\/generated\/graphql\.ts.*src\/features\/orders\/order-dashboard\.tsx/, "generated-code output to UI edge");

  const graphqlSpecialist = artifactContent(artifacts, ".pi/agents/graphql.md");
  assertContains(graphqlSpecialist, /src\/graphql\/schema\.graphql/, "graphql specialist source schema");
  assertContains(graphqlSpecialist, /npm run codegen/, "graphql specialist codegen validation");
  assertContains(graphqlSpecialist, /Schema changes must be paired with operation updates/, "graphql specialist schema pitfall");

  const generatedSpecialist = artifactContent(artifacts, ".pi/agents/generated-client.md");
  assertContains(generatedSpecialist, /src\/generated\/graphql\.ts/, "generated client specialist output path");
  assertContains(generatedSpecialist, /inspect but do not hand-edit/, "generated client specialist no-edit guidance");

  const featurePrompt = artifactContent(artifacts, ".pi/prompts/feature.md");
  assertContains(featurePrompt, /feature: `npm run codegen`, `npm run typecheck`, `npm run e2e -- orders`/, "generated-code feature prompt per-change validation");
  assertContains(featurePrompt, /MUST cite concrete repository paths/, "generated-code feature prompt path requirement");
}

