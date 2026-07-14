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

export function testSparseTestRepoIsHonestAboutMissingValidation(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "small-python-script",
      languages: ["python"],
      frameworks: [],
      domain_hypothesis: "A small automation script with no discovered automated test command.",
      suggested_subagent_domains: ["automation"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["scripts/", "README.md"],
      entry_points: [
        { path: "scripts/sync_reports.py", role: "report sync script", language: "python", run_command: "python scripts/sync_reports.py --dry-run" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "scripts/sync_reports.py", why: "Only executable path found by the audit." },
      ],
    },
    validation_surface: {
      ...base.validation_surface,
      test_command: "",
      lint_command: null,
      typecheck_command: null,
      e2e_command: null,
      per_change_type: {
        chore: { mandatory: [], optional: [] },
        bug: { mandatory: [], optional: [] },
        feature: { mandatory: [], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /No validation commands were identified/, "honest missing-validation note");

  const specs = artifactContent(artifacts, "specs/README.md");
  assertContains(specs, /feature: none/, "sparse validation by change type");

  const automationSpecialist = artifactContent(artifacts, ".pi/agents/automation.md");
  assertContains(automationSpecialist, /Use the repository validation surface from `AGENTS.md`/, "sparse specialist validation fallback");

  const featurePrompt = artifactContent(artifacts, ".pi/prompts/feature.md");
  assertContains(featurePrompt, /Test: not configured/, "sparse feature prompt test fallback");
  assertContains(featurePrompt, /Typecheck: not configured/, "sparse feature prompt typecheck fallback");
}

