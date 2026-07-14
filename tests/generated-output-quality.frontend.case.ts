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

export function testFrontendFallbackSurfaceKeepsUserWorkflowValidation(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "vite-react-app",
      languages: ["typescript"],
      frameworks: ["react", "vite", "playwright"],
      domain_hypothesis: "A dashboard frontend where filters, URL state, and data refresh must stay synchronized.",
      suggested_subagent_domains: ["routes", "state", "components"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["src/routes/", "src/state/", "src/components/", "tests/e2e/"],
      entry_points: [
        { path: "src/routes/dashboard.tsx", role: "dashboard route", language: "typescript", run_command: "npm run dev" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "src/routes/dashboard.tsx", why: "Primary user workflow and data loading boundary." },
        { path: "src/state/use-dashboard-store.ts", why: "URL/query state synchronization." },
        { path: "src/components/filter-panel.tsx", why: "User-facing filter controls." },
        { path: "tests/e2e/dashboard.spec.ts", why: "Browser-level dashboard workflow coverage." },
      ],
    },
    pitfalls: [
      {
        module: "src/state/use-dashboard-store.ts",
        what: "Filter state must round-trip through the URL query string.",
        consequence: "Users lose shareable dashboard links and browser navigation becomes inconsistent.",
        line_ref: 33,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "npm run test -- dashboard",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: "npm run e2e -- dashboard",
      per_change_type: {
        chore: { mandatory: ["npm run lint", "npm run typecheck"], optional: [] },
        bug: { mandatory: ["npm run test -- dashboard"], optional: ["npm run e2e -- dashboard"] },
        feature: { mandatory: ["npm run test -- dashboard", "npm run e2e -- dashboard"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /npm run e2e -- dashboard/, "frontend e2e command");
  assertContains(agentsMd, /Filter state must round-trip/, "frontend URL-state pitfall");

  const stateSpecialist = artifactContent(artifacts, ".pi/agents/state.md");
  assertContains(stateSpecialist, /src\/state\/use-dashboard-store\.ts/, "state specialist first file");
  assertContains(stateSpecialist, /browser navigation becomes inconsistent/, "state specialist pitfall consequence");

  const featurePrompt = artifactContent(artifacts, ".pi/prompts/feature.md");
  assertContains(featurePrompt, /E2E: npm run e2e -- dashboard/, "feature prompt e2e validation");
  assertContains(featurePrompt, /MUST cite concrete repository paths/, "feature prompt path requirement");
}

