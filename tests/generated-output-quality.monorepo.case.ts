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

export function testMonorepoFallbackSurfaceKeepsPackageBoundaries(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "pnpm-monorepo",
      languages: ["typescript"],
      frameworks: ["react", "fastify"],
      domain_hypothesis: "A monorepo with a web app, API service, and shared contract package.",
      suggested_subagent_domains: ["web", "api", "shared"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["apps/web/", "packages/api/", "packages/shared/"],
      entry_points: [
        { path: "apps/web/src/app.tsx", role: "frontend app", language: "typescript", run_command: "pnpm --filter web dev" },
        { path: "packages/api/src/server.ts", role: "api server", language: "typescript", run_command: "pnpm --filter api dev" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "apps/web/src/app.tsx", why: "Frontend route composition and data loading." },
        { path: "packages/api/src/server.ts", why: "API entry point and request lifecycle." },
        { path: "packages/shared/src/contracts.ts", why: "Shared request/response contracts used by web and API." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "apps/web/src/app.tsx", to: "packages/shared/src/contracts.ts", kind: "workspace import" },
        { from: "packages/api/src/server.ts", to: "packages/shared/src/contracts.ts", kind: "workspace import" },
      ],
      shared_abstractions: [
        "packages/shared/src/contracts.ts is used by both apps/web and packages/api; contract drift breaks both package boundaries.",
      ],
    },
    pitfalls: [
      {
        module: "packages/shared/src/contracts.ts",
        what: "Changing shared DTOs must update both callers in the same slice.",
        consequence: "Web and API can compile independently but fail at runtime with incompatible payloads.",
        line_ref: 12,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "pnpm -r test",
      lint_command: "pnpm -r lint",
      typecheck_command: "pnpm -r typecheck",
      e2e_command: "pnpm --filter web e2e",
      per_change_type: {
        chore: { mandatory: ["pnpm -r test"], optional: ["pnpm -r lint"] },
        bug: { mandatory: ["pnpm -r test", "pnpm -r typecheck"], optional: [] },
        feature: { mandatory: ["pnpm -r test", "pnpm --filter web e2e"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /pnpm -r typecheck/, "monorepo typecheck command");
  assertContains(agentsMd, /pnpm --filter web e2e/, "monorepo e2e command");
  assertContains(agentsMd, /Changing shared DTOs/, "shared-contract pitfall");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /apps\/web\/src\/app\.tsx.*packages\/shared\/src\/contracts\.ts/, "web to shared edge");
  assertContains(aiDocs, /packages\/api\/src\/server\.ts.*packages\/shared\/src\/contracts\.ts/, "api to shared edge");

  const webSpecialist = artifactContent(artifacts, ".pi/agents/web.md");
  assertContains(webSpecialist, /apps\/web\/src\/app\.tsx/, "web specialist first file");
  const apiSpecialist = artifactContent(artifacts, ".pi/agents/api.md");
  assertContains(apiSpecialist, /packages\/api\/src\/server\.ts/, "api specialist first file");
  const sharedSpecialist = artifactContent(artifacts, ".pi/agents/shared.md");
  assertContains(sharedSpecialist, /packages\/shared\/src\/contracts\.ts/, "shared specialist first file");
  assertContains(sharedSpecialist, /Web and API can compile independently/, "shared specialist pitfall consequence");
}

