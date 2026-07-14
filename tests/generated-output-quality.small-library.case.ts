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

export function testSmallLibrarySurfacePreservesPublicApiCompatibility(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "small-typescript-library",
      languages: ["typescript"],
      frameworks: ["vitest", "tsup"],
      domain_hypothesis: "A small package that exposes a stable parser API to downstream applications.",
      suggested_subagent_domains: ["parser", "public-api"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["src/", "test/", "package.json"],
      entry_points: [
        { path: "src/index.ts", role: "public package entry", language: "typescript", run_command: "npm run build" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "src/index.ts", why: "Public exports and semver boundary." },
        { path: "src/parser.ts", why: "Parser behavior used by public consumers." },
        { path: "test/parser.test.ts", why: "Parser behavior coverage." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "src/index.ts", to: "src/parser.ts", kind: "public export" },
        { from: "test/parser.test.ts", to: "src/index.ts", kind: "consumer-facing test" },
      ],
      shared_abstractions: [
        "src/index.ts is the package contract; consumers should not import internal parser modules directly.",
      ],
    },
    pitfalls: [
      {
        module: "src/index.ts",
        what: "Public exports must remain backward compatible unless the slice explicitly changes semver.",
        consequence: "Downstream projects can compile against removed parser exports and fail during upgrade.",
        line_ref: 1,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "npm test -- parser",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: null,
      per_change_type: {
        chore: { mandatory: ["npm run lint", "npm run typecheck"], optional: [] },
        bug: { mandatory: ["npm test -- parser"], optional: [] },
        feature: { mandatory: ["npm test -- parser", "npm run build"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /npm run typecheck/, "library typecheck command");
  assertContains(agentsMd, /Public exports must remain backward compatible/, "library public API pitfall");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /src\/index\.ts.*src\/parser\.ts/, "library public export edge");
  assertContains(aiDocs, /consumer-facing test/, "library consumer-facing test edge");

  const publicApiSpecialist = artifactContent(artifacts, ".pi/agents/public-api.md");
  assertContains(publicApiSpecialist, /src\/index\.ts/, "public API specialist entry point");
  assertContains(publicApiSpecialist, /Downstream projects can compile/, "public API pitfall consequence");

  const workflow = artifactContent(artifacts, ".pi/workflows/public-api-plan-build-review-fix.json");
  assertContains(workflow, /"subagent_template": "public-api"/, "public API workflow specialist step");
}

