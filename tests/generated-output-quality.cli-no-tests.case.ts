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

export function testCliWithNoTestsKeepsTypecheckAsPrimaryValidation(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "typescript-cli-no-tests",
      languages: ["typescript"],
      frameworks: ["tsx"],
      domain_hypothesis: "A command-line tool with strong static contracts but no discovered test suite.",
      suggested_subagent_domains: ["cli", "config"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["src/", "package.json", "tsconfig.json"],
      entry_points: [
        { path: "src/cli.ts", role: "CLI entry point", language: "typescript", run_command: "npm run dev -- --help" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "src/cli.ts", why: "Argument parsing and command dispatch boundary." },
        { path: "src/config.ts", why: "Configuration schema and environment handling." },
        { path: "tsconfig.json", why: "Strict typecheck contract for this no-test CLI." },
      ],
    },
    pitfalls: [
      {
        module: "src/config.ts",
        what: "Environment variables must be parsed through the config schema before use.",
        consequence: "Commands can run with malformed paths or missing credentials.",
        line_ref: 18,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: null,
      per_change_type: {
        chore: { mandatory: ["npm run typecheck"], optional: ["npm run lint"] },
        bug: { mandatory: ["npm run typecheck"], optional: ["npm run dev -- --help"] },
        feature: { mandatory: ["npm run typecheck"], optional: ["npm run lint"] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /npm run typecheck/, "no-test CLI typecheck command");
  assert.doesNotMatch(agentsMd, /No validation commands were identified/, "typecheck should count as validation");
  assertContains(agentsMd, /Environment variables must be parsed through the config schema/, "no-test CLI config pitfall");

  const specs = artifactContent(artifacts, "specs/README.md");
  assertContains(specs, /bug: `npm run typecheck`/, "no-test CLI bug validation");
  assertContains(specs, /feature: `npm run typecheck`/, "no-test CLI feature validation");

  const cliSpecialist = artifactContent(artifacts, ".pi/agents/cli.md");
  assertContains(cliSpecialist, /src\/cli\.ts/, "no-test CLI specialist entry file");
  assertContains(cliSpecialist, /npm run typecheck/, "no-test CLI specialist validation");

  const featurePrompt = artifactContent(artifacts, ".pi/prompts/feature.md");
  assertContains(featurePrompt, /Typecheck: npm run typecheck/, "no-test CLI feature prompt typecheck");
  assertContains(featurePrompt, /Test: not configured/, "no-test CLI honest test absence");
}

