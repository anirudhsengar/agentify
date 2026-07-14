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

export function testExpertSurfaceCarriesActionableDomainKnowledge(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "billing-service",
      domain_hypothesis: "A recurring billing service with high-stakes payment retries.",
    },
    expert_evidence: {
      expert_domains: [
        {
          domain: "billing",
          rationale: "Billing changes are recurring and carry payment correctness invariants.",
          primary_paths: ["src/billing", "tests/billing"],
          entry_points: ["src/billing/index.ts"],
          test_paths: ["tests/billing/retry.test.ts"],
          key_files: [
            {
              path: "src/billing/index.ts",
              purpose: "Coordinates invoice authorization, capture, and retry behavior.",
              line_range: [1, 160],
            },
          ],
          key_types: [
            {
              name: "InvoiceState",
              path: "src/billing/types.ts:12",
              purpose: "State machine that prevents capture before authorization.",
            },
          ],
          patterns: [
            {
              name: "authorization-before-capture",
              description: "Invoices cannot be captured before authorization succeeds.",
              example_ref: "src/billing/index.ts:42",
            },
          ],
          pitfalls: [
            {
              risk: "Retry handlers can double-charge customers.",
              consequence: "A timed-out request and async retry can both capture the same invoice.",
              reference: "src/billing/retry.ts:88",
            },
          ],
          conventions: ["Amounts are stored in cents and never as floats."],
          stability: "high",
          recurrence: "high",
          test_command: "npm test -- tests/billing/retry.test.ts",
          last_updated: "2026-07-06T00:00:00.000Z",
        },
      ],
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const expertise = artifactContent(artifacts, ".pi/prompts/experts/billing/expertise.yaml");
  assertContains(expertise, /Billing changes are recurring/, "expert rationale");
  assertContains(expertise, /src\/billing\/index\.ts/, "expert key file");
  assertContains(expertise, /InvoiceState/, "expert key type");
  assertContains(expertise, /Invoices cannot be captured before authorization succeeds/, "expert pattern invariant");
  assertContains(expertise, /Retry handlers can double-charge customers/, "expert pitfall risk");
  assertContains(expertise, /Amounts are stored in cents/, "expert convention");
  assertContains(expertise, /npm test -- tests\/billing\/retry\.test\.ts/, "expert test command");

  const questionPrompt = artifactContent(artifacts, ".pi/prompts/experts/billing/question.md");
  assertContains(questionPrompt, /Read \.pi\/prompts\/experts\/billing\/expertise\.yaml first/, "expert question loads expertise");

  const selfImprovePrompt = artifactContent(artifacts, ".pi/prompts/experts/billing/self-improve.md");
  assertContains(selfImprovePrompt, /Preserve stable knowledge, remove stale claims/, "expert self-improve refresh discipline");
  assertContains(selfImprovePrompt, /npm test -- tests\/billing\/retry\.test\.ts/, "expert self-improve validation");
}

