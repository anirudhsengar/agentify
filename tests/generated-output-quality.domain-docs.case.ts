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

export function testStrongDomainDocsArePreservedAndRoutable(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "domain-heavy-service",
      domain_hypothesis: "A policy administration service with durable business invariants.",
      suggested_subagent_domains: ["policies"],
    },
    artifact_intents: {
      agent_guide: {
        title: "Agent Guide",
        sections: [
          { heading: "Build", body: "Run `npm test -- policies` before review." },
          { heading: "Domain", body: "Policy terms are governed by docs/domain/policies.md." },
        ],
      },
      always_on_docs: [
        { path: "specs/README.md", title: "Specs", body: "Specs must cite policy invariant docs." },
        { path: "ai_docs/README.md", title: "AI Docs", body: "Policy service context." },
        {
          path: "docs/domain/policies.md",
          title: "Policy Domain",
          body: "Aggregate invariants: endorsements cannot shorten active coverage without underwriting approval.",
        },
      ],
      feature_agents: [],
      prompt_templates: [],
      experts: [],
      extension_candidates: [],
      scaffold_runtime: { state_machine_notes: [] },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const domainDoc = artifactContent(artifacts, "docs/domain/policies.md");
  assertContains(domainDoc, /Aggregate invariants/, "domain doc body");
  assertContains(domainDoc, /underwriting approval/, "domain invariant detail");

  const conditionalDocs = artifactContent(artifacts, ".pi/conditional_docs.md");
  assertContains(conditionalDocs, /docs\/domain\/policies\.md/, "conditional docs domain path");
  assertContains(conditionalDocs, /Policy Domain/, "conditional docs domain title");
}

