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

export function testGeneratedSkillsFeedbackDocsAndPitfallsAreOperational(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "search-service",
      domain_hypothesis: "A search service with cache reseeding and review-heavy operational changes.",
      suggested_subagent_domains: ["search"],
    },
    skeleton: {
      ...base.skeleton,
      first_5_files_for_fresh_agent: [
        { path: "src/search/index.ts", why: "Search query entry point." },
        { path: "src/search/cache.ts", why: "Cache population and invalidation boundary." },
        { path: "scripts/reseed-search-index.sh", why: "Operational reseed script wrapped by generated skill." },
      ],
    },
    pitfalls: [
      {
        module: "src/search/cache.ts",
        what: "Cache reseeds must be idempotent and scoped to one tenant.",
        consequence: "A broad reseed can overwrite unrelated tenant search results.",
        line_ref: 77,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "npm test -- search",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: null,
      per_change_type: {
        chore: { mandatory: ["npm run lint", "npm run typecheck"], optional: [] },
        bug: { mandatory: ["npm test -- search"], optional: [] },
        feature: { mandatory: ["npm test -- search", "npm run typecheck"], optional: [] },
      },
    },
    customization_evidence: {
      skill_candidates: [
        {
          name: "reseed-search",
          purpose: "Safely reseed the search index for one tenant after schema or analyzer changes.",
          steps_or_script_path: "scripts/reseed-search-index.sh",
        },
      ],
      custom_tool_candidates: [],
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /src\/search\/cache\.ts:77/, "line-cited AGENTS pitfall");
  assertContains(agentsMd, /A broad reseed can overwrite unrelated tenant search results/, "AGENTS pitfall consequence");

  const skill = artifactContent(artifacts, ".pi/skills/reseed-search/SKILL.md");
  assertContains(skill, /## When To Use/, "generated skill usage boundary");
  assertContains(skill, /Safely reseed the search index for one tenant/, "generated skill purpose");
  assertContains(skill, /## Preconditions/, "generated skill preconditions");
  assertContains(skill, /scripts\/reseed-search-index\.sh <args>/, "generated skill command");
  assertContains(skill, /## Validation/, "generated skill validation section");
  assertContains(skill, /Inspect the exit code/, "generated skill exit-code discipline");
  assertContains(skill, /## Report/, "generated skill report section");
  assertContains(skill, /residual risk/, "generated skill residual-risk report");

  const appReview = artifactContent(artifacts, "app_review/README.md");
  assertContains(appReview, /TestResult/, "app review test result guidance");
  assertContains(appReview, /ReviewResult/, "app review review result guidance");
  assertContains(appReview, /validation commands/, "app review validation command field");
  assertContains(appReview, /screenshots or logs/, "app review evidence field");

  const appDocs = artifactContent(artifacts, "app_docs/README.md");
  assertContains(appDocs, /What changed/, "app docs durable change prompt");
  assertContains(appDocs, /When to load/, "app docs conditional loading prompt");

  const fixReports = artifactContent(artifacts, "app_fix_reports/README.md");
  assertContains(fixReports, /blocker fixed/, "fix reports blocker field");
  assertContains(fixReports, /residual risk/, "fix reports residual risk field");
}

