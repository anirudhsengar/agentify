import assert from "node:assert/strict";
import { renderBrownfieldArtifacts, type RenderedArtifact } from "../src/core/artifacts/renderers.ts";
import { AGENTS_MD_MAX_LINES } from "../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";

function byPath(artifacts: RenderedArtifact[]): Map<string, RenderedArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
}

function lineCount(content: string): number {
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function assertContains(content: string, pattern: RegExp, label: string): void {
  assert.match(content, pattern, `missing ${label}`);
}

function artifactContent(artifacts: Map<string, RenderedArtifact>, relativePath: string): string {
  const artifact = artifacts.get(relativePath);
  assert.ok(artifact, `missing artifact ${relativePath}`);
  return artifact.content;
}

function testTypescriptCliFallbackSurfaceIsActionable(): void {
  const map = makeValidCodebaseMap({
    meta: {
      ...makeValidCodebaseMap().meta,
      project_type: "typescript-cli",
      domain_hypothesis: "A CLI that processes customer invoices.",
      suggested_subagent_domains: ["payments"],
    },
  });
  map.skeleton.first_5_files_for_fresh_agent = [
    { path: "src/index.ts", why: "CLI entry point." },
    { path: "src/payments/service.ts", why: "Payment orchestration." },
  ];
  map.validation_surface.test_command = "npm test -- payments";
  map.pitfalls = [
    {
      module: "src/payments/service.ts",
      what: "Retries must be idempotent.",
      consequence: "A retry can duplicate a charge.",
      line_ref: 42,
    },
  ];

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifacts.get("AGENTS.md")?.content ?? "";
  assert.ok(lineCount(agentsMd) <= AGENTS_MD_MAX_LINES, "AGENTS.md must stay under the hard cap");
  assertContains(agentsMd, /## Validation/, "AGENTS.md validation section");
  assertContains(agentsMd, /npm test -- payments/, "primary validation command");
  assertContains(agentsMd, /Retries must be idempotent/, "pitfall text");

  const specialist = artifacts.get(".pi/agents/payments.md")?.content ?? "";
  assertContains(specialist, /^## Scope$/m, "specialist scope section");
  assertContains(specialist, /^## First Files$/m, "specialist first-files section");
  assertContains(specialist, /^## Validation$/m, "specialist validation section");
  assertContains(specialist, /^## Pitfalls$/m, "specialist pitfalls section");
  assertContains(specialist, /src\/payments\/service\.ts/, "specialist domain file reference");
  assertContains(specialist, /npm test -- payments/, "specialist validation command");
  assertContains(specialist, /A retry can duplicate a charge/, "specialist pitfall consequence");
}

function testMonorepoFallbackSurfaceKeepsPackageBoundaries(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "pnpm-monorepo",
      languages: ["typescript"],
      frameworks: ["react", "fastify"],
      domain_hypothesis: "A monorepo with a web app, API service, and shared contract package.",
      suggested_subagent_domains: ["web", "api", "shared"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["apps/web/", "packages/api/", "packages/shared/"],
      entry_points: [
        { path: "apps/web/src/app.tsx", role: "frontend app", language: "typescript", run_command: "pnpm --filter web dev" },
        { path: "packages/api/src/server.ts", role: "api server", language: "typescript", run_command: "pnpm --filter api dev" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "apps/web/src/app.tsx", why: "Frontend route composition and data loading." },
        { path: "packages/api/src/server.ts", why: "API entry point and request lifecycle." },
        { path: "packages/shared/src/contracts.ts", why: "Shared request/response contracts used by web and API." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "apps/web/src/app.tsx", to: "packages/shared/src/contracts.ts", kind: "workspace import" },
        { from: "packages/api/src/server.ts", to: "packages/shared/src/contracts.ts", kind: "workspace import" },
      ],
      shared_abstractions: [
        "packages/shared/src/contracts.ts is used by both apps/web and packages/api; contract drift breaks both package boundaries.",
      ],
    },
    pitfalls: [
      {
        module: "packages/shared/src/contracts.ts",
        what: "Changing shared DTOs must update both callers in the same slice.",
        consequence: "Web and API can compile independently but fail at runtime with incompatible payloads.",
        line_ref: 12,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "pnpm -r test",
      lint_command: "pnpm -r lint",
      typecheck_command: "pnpm -r typecheck",
      e2e_command: "pnpm --filter web e2e",
      per_change_type: {
        chore: { mandatory: ["pnpm -r test"], optional: ["pnpm -r lint"] },
        bug: { mandatory: ["pnpm -r test", "pnpm -r typecheck"], optional: [] },
        feature: { mandatory: ["pnpm -r test", "pnpm --filter web e2e"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /pnpm -r typecheck/, "monorepo typecheck command");
  assertContains(agentsMd, /pnpm --filter web e2e/, "monorepo e2e command");
  assertContains(agentsMd, /Changing shared DTOs/, "shared-contract pitfall");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /apps\/web\/src\/app\.tsx.*packages\/shared\/src\/contracts\.ts/, "web to shared edge");
  assertContains(aiDocs, /packages\/api\/src\/server\.ts.*packages\/shared\/src\/contracts\.ts/, "api to shared edge");

  const webSpecialist = artifactContent(artifacts, ".pi/agents/web.md");
  assertContains(webSpecialist, /apps\/web\/src\/app\.tsx/, "web specialist first file");
  const apiSpecialist = artifactContent(artifacts, ".pi/agents/api.md");
  assertContains(apiSpecialist, /packages\/api\/src\/server\.ts/, "api specialist first file");
  const sharedSpecialist = artifactContent(artifacts, ".pi/agents/shared.md");
  assertContains(sharedSpecialist, /packages\/shared\/src\/contracts\.ts/, "shared specialist first file");
  assertContains(sharedSpecialist, /Web and API can compile independently/, "shared specialist pitfall consequence");
}

function testFrontendFallbackSurfaceKeepsUserWorkflowValidation(): void {
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

function testBackendServiceSurfaceKeepsOperationalBoundaries(): void {
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

function testSparseTestRepoIsHonestAboutMissingValidation(): void {
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

function testCliWithNoTestsKeepsTypecheckAsPrimaryValidation(): void {
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

function testSmallLibrarySurfacePreservesPublicApiCompatibility(): void {
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

function testGeneratedCodeSurfacePreservesSourceOfTruthBoundaries(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "next-graphql-generated-code",
      languages: ["typescript", "graphql"],
      frameworks: ["next", "graphql-codegen", "zod"],
      domain_hypothesis: "A dashboard app where GraphQL schema and generated TypeScript clients must stay in sync.",
      suggested_subagent_domains: ["graphql", "generated-client"],
    },
    skeleton: {
      ...base.skeleton,
      top_level_tree: ["src/graphql/", "src/generated/", "src/features/orders/", "codegen.ts"],
      entry_points: [
        { path: "src/features/orders/order-dashboard.tsx", role: "orders dashboard route", language: "typescript", run_command: "npm run dev" },
        { path: "src/graphql/schema.graphql", role: "GraphQL source schema", language: "graphql", run_command: "npm run codegen" },
      ],
      first_5_files_for_fresh_agent: [
        { path: "src/graphql/schema.graphql", why: "Source of truth for generated GraphQL operation and type outputs." },
        { path: "src/graphql/operations/orders.graphql", why: "Order dashboard operation definitions consumed by codegen." },
        { path: "codegen.ts", why: "Code generator config and output ownership rules." },
        { path: "src/generated/graphql.ts", why: "Generated client output; inspect but do not hand-edit." },
        { path: "src/features/orders/order-dashboard.tsx", why: "User-facing dashboard consuming generated query types." },
      ],
    },
    module_graph: {
      ...base.module_graph,
      edges: [
        { from: "src/graphql/schema.graphql", to: "src/generated/graphql.ts", kind: "codegen source" },
        { from: "src/graphql/operations/orders.graphql", to: "src/generated/graphql.ts", kind: "operation codegen" },
        { from: "src/generated/graphql.ts", to: "src/features/orders/order-dashboard.tsx", kind: "typed generated client import" },
      ],
      shared_abstractions: [
        "src/generated/graphql.ts is derived output; schema and operation files are the editable source of truth.",
      ],
    },
    pitfalls: [
      {
        module: "src/generated/graphql.ts",
        what: "Never hand-edit generated GraphQL client types.",
        consequence: "The next codegen run will erase manual fixes and can leave UI code compiled against phantom fields.",
        line_ref: 1,
      },
      {
        module: "src/graphql/schema.graphql",
        what: "Schema changes must be paired with operation updates and regenerated TypeScript.",
        consequence: "Runtime queries can drift from generated types even while local UI code appears type-safe.",
        line_ref: 12,
      },
    ],
    validation_surface: {
      ...base.validation_surface,
      test_command: "npm run test -- orders-dashboard",
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
      e2e_command: "npm run e2e -- orders",
      per_change_type: {
        chore: { mandatory: ["npm run codegen", "npm run typecheck"], optional: ["npm run lint"] },
        bug: { mandatory: ["npm run codegen", "npm run typecheck", "npm run test -- orders-dashboard"], optional: [] },
        feature: { mandatory: ["npm run codegen", "npm run typecheck", "npm run e2e -- orders"], optional: [] },
      },
    },
  });

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifactContent(artifacts, "AGENTS.md");
  assertContains(agentsMd, /src\/graphql\/schema\.graphql/, "generated-code source schema first file");
  assertContains(agentsMd, /Never hand-edit generated GraphQL client types/, "generated-code no-hand-edit pitfall");
  assertContains(agentsMd, /feature: `npm run codegen`, `npm run typecheck`, `npm run e2e -- orders`/, "generated-code feature validation");

  const aiDocs = artifactContent(artifacts, "ai_docs/README.md");
  assertContains(aiDocs, /src\/graphql\/schema\.graphql.*src\/generated\/graphql\.ts/, "generated-code schema to output edge");
  assertContains(aiDocs, /src\/generated\/graphql\.ts.*src\/features\/orders\/order-dashboard\.tsx/, "generated-code output to UI edge");

  const graphqlSpecialist = artifactContent(artifacts, ".pi/agents/graphql.md");
  assertContains(graphqlSpecialist, /src\/graphql\/schema\.graphql/, "graphql specialist source schema");
  assertContains(graphqlSpecialist, /npm run codegen/, "graphql specialist codegen validation");
  assertContains(graphqlSpecialist, /Schema changes must be paired with operation updates/, "graphql specialist schema pitfall");

  const generatedSpecialist = artifactContent(artifacts, ".pi/agents/generated-client.md");
  assertContains(generatedSpecialist, /src\/generated\/graphql\.ts/, "generated client specialist output path");
  assertContains(generatedSpecialist, /inspect but do not hand-edit/, "generated client specialist no-edit guidance");

  const featurePrompt = artifactContent(artifacts, ".pi/prompts/feature.md");
  assertContains(featurePrompt, /feature: `npm run codegen`, `npm run typecheck`, `npm run e2e -- orders`/, "generated-code feature prompt per-change validation");
  assertContains(featurePrompt, /MUST cite concrete repository paths/, "generated-code feature prompt path requirement");
}

function testGeneratedSkillsFeedbackDocsAndPitfallsAreOperational(): void {
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
    grade3_evidence: {
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

function testRailsStyleSurfacePreservesMvcAndJobBoundaries(): void {
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

function testStrongDomainDocsArePreservedAndRoutable(): void {
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

function testExpertSurfaceCarriesActionableDomainKnowledge(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "billing-service",
      domain_hypothesis: "A recurring billing service with high-stakes payment retries.",
    },
    grade7_evidence: {
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

function testExpertPlanPromptForcesCitedRiskAwarePlanning(): void {
  const base = makeValidCodebaseMap();
  const map = makeValidCodebaseMap({
    meta: {
      ...base.meta,
      project_type: "billing-service",
      domain_hypothesis: "A recurring billing service where planning must preserve retry and capture invariants.",
    },
    grade7_evidence: {
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

testTypescriptCliFallbackSurfaceIsActionable();
testMonorepoFallbackSurfaceKeepsPackageBoundaries();
testFrontendFallbackSurfaceKeepsUserWorkflowValidation();
testBackendServiceSurfaceKeepsOperationalBoundaries();
testSparseTestRepoIsHonestAboutMissingValidation();
testCliWithNoTestsKeepsTypecheckAsPrimaryValidation();
testSmallLibrarySurfacePreservesPublicApiCompatibility();
testGeneratedCodeSurfacePreservesSourceOfTruthBoundaries();
testGeneratedSkillsFeedbackDocsAndPitfallsAreOperational();
testRailsStyleSurfacePreservesMvcAndJobBoundaries();
testStrongDomainDocsArePreservedAndRoutable();
testExpertSurfaceCarriesActionableDomainKnowledge();
testExpertPlanPromptForcesCitedRiskAwarePlanning();

console.log("generated-output quality tests passed.");
