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

export function testRailsStyleSurfacePreservesMvcAndJobBoundaries(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "rails-app",
      languages: ["ruby"],
      frameworks: ["rails", "active-record", "sidekiq", "rspec"],
      domain_hypothesis: "A subscription billing Rails app with controller, model, and background job boundaries.",
      suggested_subagent_domains: ["billing", "subscriptions"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["app/controllers/", "app/models/", "app/jobs/", "spec/"],
      entry_points: [
        { path: "app/controllers/subscriptions_controller.rb", role: "HTTP subscription controller", language: "ruby", run_command: "bin/rails server" },
        { path: "app/jobs/billing/retry_charge_job.rb", role: "background retry job", language: "ruby", run_command: "bundle exec sidekiq" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "app/controllers/subscriptions_controller.rb", why: "Request boundary for subscription changes." },
        { path: "app/models/subscription.rb", why: "Subscription state machine and persistence invariants." },
        { path: "app/services/billing/charge_customer.rb", why: "Coordinates external billing side effects." },
        { path: "app/jobs/billing/retry_charge_job.rb", why: "Retries failed billing attempts asynchronously." },
        { path: "spec/requests/subscriptions_spec.rb", why: "End-to-end request coverage for subscription changes." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "app/controllers/subscriptions_controller.rb", to: "app/models/subscription.rb", kind: "loads and mutates model" },
        { from: "app/models/subscription.rb", to: "app/services/billing/charge_customer.rb", kind: "billing side effect" },
        { from: "app/jobs/billing/retry_charge_job.rb", to: "app/services/billing/charge_customer.rb", kind: "async retry" },
      ],
      shared_state: ["subscriptions table is shared by controller requests and Sidekiq retry jobs."],
    },
    pitfalls: [
      {
        module: "app/services/billing/charge_customer.rb",
        what: "Retry jobs must be idempotent across Sidekiq retries and web retries.",
        consequence: "Customers can be double-charged when a request timeout races a retry job.",
        line_ref: 27,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "bundle exec rspec spec/requests/subscriptions_spec.rb",
      lint_command: "bundle exec rubocop",
      typecheck_command: null,
      e2e_command: "bin/rails test:system",
      per_change_type: {
        chore: { mandatory: ["bundle exec rubocop"], optional: [] },
        bug: { mandatory: ["bundle exec rspec spec/requests/subscriptions_spec.rb"], optional: [] },
        feature: { mandatory: ["bundle exec rspec spec/requests/subscriptions_spec.rb", "bin/rails test:system"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /bundle exec rspec spec\/requests\/subscriptions_spec\.rb/, "Rails request spec command");
  assertContains(agentsMd, /Retry jobs must be idempotent/, "Rails idempotency pitfall");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /subscriptions_controller\.rb.*subscription\.rb/, "Rails controller to model edge");
  assertContains(aiDocs, /retry_charge_job\.rb.*charge_customer\.rb/, "Rails async retry edge");

  const billingSpecialist = artifactContent(artifacts, ".pi/agents/billing.md");
  assertContains(billingSpecialist, /app\/services\/billing\/charge_customer\.rb/, "billing specialist service file");
  assertContains(billingSpecialist, /double-charged/, "billing specialist pitfall consequence");

  const featurePrompt = artifactContent(artifacts, ".pi/prompts/feature.md");
  assertContains(featurePrompt, /E2E: bin\/rails test:system/, "Rails system test prompt validation");
}

