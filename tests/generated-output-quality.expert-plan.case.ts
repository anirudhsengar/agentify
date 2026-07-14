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

export function testExpertPlanPromptForcesCitedRiskAwarePlanning(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "billing-service",
      domain_hypothesis: "A recurring billing service where planning must preserve retry and capture invariants.",
    },
    expert_evidence: {
      expert_domains: [
        {
          domain: "billing",
          rationale: "Billing plans need durable payment and retry knowledge.",
          primary_paths: ["src/billing", "tests/billing"],
          entry_points: ["src/billing/index.ts"],
          test_paths: ["tests/billing/retry.test.ts", "tests/billing/capture.test.ts"],
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

  const planPrompt = artifactContent(artifacts, ".pi/prompts/experts/billing/plan.md");
  assertContains(planPrompt, /Required planning output/, "expert plan required output section");
  assertContains(planPrompt, /cite the exact expertise entries or repository file:line refs/, "expert plan citations");
  assertContains(planPrompt, /Relevant expert knowledge/, "expert plan knowledge section");
  assertContains(planPrompt, /authorization-before-capture/, "expert plan includes pattern names");
  assertContains(planPrompt, /Retry handlers can double-charge customers/, "expert plan includes pitfall risks");
  assertContains(planPrompt, /InvoiceState/, "expert plan includes key types");
  assertContains(planPrompt, /npm test -- tests\/billing\/retry\.test\.ts/, "expert plan validation command");
  assertContains(planPrompt, /Staleness check/, "expert plan stale knowledge check");
  assertContains(planPrompt, /Do not edit files in this mode/, "expert plan remains read-only");

  const planBuildPrompt = artifactContent(artifacts, ".pi/prompts/experts/billing/plan_build_improve.md");
  assertContains(planBuildPrompt, /Before editing/, "plan-build prompt pre-edit discipline");
  assertContains(planBuildPrompt, /apply these expert constraints/, "plan-build prompt applies expert constraints");
  assertContains(planBuildPrompt, /Run `npm test -- tests\/billing\/retry\.test\.ts`/, "plan-build prompt validation command");
  assertContains(planBuildPrompt, /update `\.pi\/prompts\/experts\/billing\/expertise\.yaml`/, "plan-build prompt learn phase");
}

