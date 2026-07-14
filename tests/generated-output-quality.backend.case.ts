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

export function testBackendServiceSurfaceKeepsOperationalBoundaries(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "fastify-api",
      languages: ["typescript"],
      frameworks: ["fastify", "postgres", "bullmq"],
      domain_hypothesis: "An order fulfillment API with transactional writes and background shipment jobs.",
      suggested_subagent_domains: ["orders", "persistence"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["src/routes/", "src/orders/", "src/db/", "src/jobs/"],
      entry_points: [
        { path: "src/server.ts", role: "HTTP server", language: "typescript", run_command: "npm run dev" },
        { path: "src/jobs/shipment-worker.ts", role: "shipment worker", language: "typescript", run_command: "npm run worker:shipments" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "src/routes/orders.ts", why: "Order route and request validation boundary." },
        { path: "src/orders/order-service.ts", why: "Coordinates order state transitions." },
        { path: "src/db/order-repository.ts", why: "Owns transactional persistence." },
        { path: "src/jobs/shipment-worker.ts", why: "Processes asynchronous shipment work." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "src/routes/orders.ts", to: "src/orders/order-service.ts", kind: "calls service" },
        { from: "src/orders/order-service.ts", to: "src/db/order-repository.ts", kind: "transactional write" },
      ],
      shared_state: ["Postgres orders table is shared by HTTP requests and shipment jobs."],
    },
    pitfalls: [
      {
        module: "src/orders/order-service.ts",
        what: "Database writes must be transactional across order and shipment records.",
        consequence: "A failed shipment enqueue can leave paid orders permanently unshipped.",
        line_ref: 88,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "npm run test:integration -- orders",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: null,
      per_change_type: {
        chore: { mandatory: ["npm run lint", "npm run typecheck"], optional: [] },
        bug: { mandatory: ["npm run test:integration -- orders"], optional: [] },
        feature: { mandatory: ["npm run test:integration -- orders"], optional: ["npm run worker:test"] },
      },
    },
    security_surface: {
      ...base.security_surface,
      damage_control_rules: ["Never print DATABASE_URL or queue credentials in logs."],
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /npm run test:integration -- orders/, "backend integration validation");
  assertContains(agentsMd, /Database writes must be transactional/, "backend transaction pitfall");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /src\/routes\/orders\.ts.*src\/orders\/order-service\.ts/, "route to service edge");
  assertContains(aiDocs, /src\/orders\/order-service\.ts.*src\/db\/order-repository\.ts/, "service to repository edge");
  assertContains(aiDocs, /Never print DATABASE_URL/, "backend credential damage-control rule");

  const ordersSpecialist = artifactContent(artifacts, ".pi/agents/orders.md");
  assertContains(ordersSpecialist, /src\/routes\/orders\.ts/, "orders specialist route file");
  assertContains(ordersSpecialist, /failed shipment enqueue/, "orders specialist pitfall");

  const workflow = artifactContent(artifacts, ".pi/workflows/orders-plan-build-review-fix.json");
  assertContains(workflow, /"subagent_template": "orders"/, "orders workflow specialist step");
  assertContains(workflow, /"workflow_type": "plan_build_review_fix"/, "orders workflow AIW step");
}

