import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { digestCanonical } from "../../src/core/memory/serialization.ts";
import { discoverSpecialistPortfolio } from "../../src/core/specialists/discovery.ts";
import { readInstalledTrustedValidationArgv } from "../../src/core/specialists/trusted-commands.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

const COMMIT = "a".repeat(40);


test("installed trusted commands require an intact policy digest and repository source", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-trusted-policy-"));
  try {
    fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".github"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".agentify", "manifest.json"), "{}\n");
    assert.deepEqual(readInstalledTrustedValidationArgv(cwd), []);

    const draft = {
      policy_digest: "",
      approval_required: true,
      approval_ttl_ms: 60_000,
      maximum_cost_usd: 1,
      maximum_runtime_ms: 60_000,
      maximum_model_calls: 1,
      maximum_fix_cycles: 1,
      protected_paths: [".git"],
      allowed_write_paths: ["src"],
      validation_commands: [{
        command_id: "test-go-test",
        argv: ["go", "test", "./..."],
        cwd: ".",
        timeout_ms: 60_000,
        required: true,
        mutation_allowed: false,
        source: "repository-policy",
      }],
      forbidden_actions: ["application merge"],
    };
    const policy = {
      ...draft,
      policy_digest: digestCanonical({ ...draft, policy_digest: undefined }),
    };
    const configuration = {
      format: "agentify_task_policy_configuration",
      schema_version: "2",
      configured: true,
      policy,
    };
    const policyPath = path.join(cwd, ".github", "agentify-task-policy.json");
    fs.writeFileSync(policyPath, `${JSON.stringify(configuration)}\n`);
    assert.deepEqual(readInstalledTrustedValidationArgv(cwd), [["go", "test", "./..."]]);

    policy.validation_commands[0]!.argv = ["go", "test", "./...", "-run", "Injected"];
    fs.writeFileSync(policyPath, `${JSON.stringify(configuration)}\n`);
    assert.deepEqual(readInstalledTrustedValidationArgv(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("specialist and procedure commands are intersected with the trusted task policy", () => {
  const map = makeSpecialistFixtureMap();
  const portfolio = discoverSpecialistPortfolio(
    map,
    COMMIT,
    SPECIALIST_FIXTURE_TRACKED_FILES,
    { trustedValidationArgv: [["npm", "run", "test"]] },
  );

  const persistedCommands = [
    ...portfolio.specialists.flatMap((specialist) => specialist.validation_commands),
    ...portfolio.procedures.flatMap((procedure) => [
      ...procedure.allowed_commands,
      ...procedure.validation_commands,
    ]),
  ];
  assert.ok(persistedCommands.length > 0);
  assert.deepEqual([...new Set(persistedCommands)], ["npm run test"]);
  assert.ok(portfolio.warnings.some((warning) =>
    warning.includes("Ignored executable but unverified validation command")
    && warning.includes("tsc --noEmit")
  ));
  assert.ok(portfolio.warnings.some((warning) =>
    warning.includes("npm test -- tests/auth.test.ts")
  ));
});

test("shared type dependencies become context touchpoints and specialist relationships", () => {
  const map = makeSpecialistFixtureMap();
  const billing = map.concern_evidence!.concerns.find((concern) => concern.concern === "billing")!;
  billing.touchpoints = billing.touchpoints.filter((touchpoint) =>
    touchpoint.path !== "src/middleware/session.ts"
  );
  map.type_contract_surface.type_definitions = [{
    path: "src/contracts/session.ts",
    name: "Session",
    kind: "interface",
    language: "TypeScript",
    fields: ["subject", "expiresAt"],
  }];
  map.type_contract_surface.one_type_trace = {
    name: "Session",
    flow: [
      "src/auth/verify.ts:12 verifies and issues the session",
      "src/billing/charge.ts:8 attributes the charge to the session subject",
    ],
  };

  const tracked = [
    ...SPECIALIST_FIXTURE_TRACKED_FILES,
    "src/contracts/session.ts",
  ];
  const portfolio = discoverSpecialistPortfolio(map, COMMIT, tracked);
  const auth = portfolio.specialists.find((specialist) =>
    specialist.specialist_id === "specialist-authentication"
  )!;
  const billingSpecialist = portfolio.specialists.find((specialist) =>
    specialist.specialist_id === "specialist-billing"
  )!;

  for (const specialist of [auth, billingSpecialist]) {
    assert.ok(specialist.context_paths.includes("src/contracts/session.ts"));
    assert.ok(specialist.evidence_paths.includes("src/contracts/session.ts"));
    assert.ok(specialist.freshness_dependencies.includes("src/contracts/session.ts"));
    assert.ok(specialist.touchpoints.some((touchpoint) =>
      touchpoint.path === "src/contracts/session.ts"
      && touchpoint.centrality === "supporting"
      && touchpoint.role.includes("Shared Session contract")
    ));
  }
  assert.deepEqual(auth.related_specialists, ["specialist-billing"]);
  assert.deepEqual(billingSpecialist.related_specialists, ["specialist-authentication"]);
});

test("audited module dependencies create overlapping context without merging concerns", () => {
  const map = makeSpecialistFixtureMap();
  for (const concern of map.concern_evidence!.concerns) {
    concern.touchpoints = concern.touchpoints.filter((touchpoint) =>
      touchpoint.path !== "src/middleware/session.ts"
    );
  }
  map.module_graph.edges = [
    { from: "src/auth/verify.ts", to: "src/shared/session.ts", kind: "import" },
    { from: "src/billing/charge.ts", to: "src/shared/session.ts", kind: "import" },
  ];

  const portfolio = discoverSpecialistPortfolio(map, COMMIT, [
    ...SPECIALIST_FIXTURE_TRACKED_FILES,
    "src/shared/session.ts",
  ]);
  const auth = portfolio.specialists.find((specialist) =>
    specialist.specialist_id === "specialist-authentication"
  )!;
  const billing = portfolio.specialists.find((specialist) =>
    specialist.specialist_id === "specialist-billing"
  )!;

  assert.ok(auth.context_paths.includes("src/shared/session.ts"));
  assert.ok(billing.context_paths.includes("src/shared/session.ts"));
  assert.ok(auth.touchpoints.some((touchpoint) =>
    touchpoint.path === "src/shared/session.ts"
    && touchpoint.role.includes("audited module graph")
  ));
  assert.deepEqual(auth.related_specialists, ["specialist-billing"]);
  assert.deepEqual(billing.related_specialists, ["specialist-authentication"]);
});
