import { makeValidCodebaseMap } from "./codebase-map.ts";

export function makeRendererIntentMap() {
  const map = makeValidCodebaseMap({
    artifact_intents: {
      agent_guide: {
        title: "Agent Guide",
        sections: [
          { heading: "Build", body: "Run `npm test` before review." },
          { heading: "Pitfalls", body: "Do not edit generated files by hand." },
        ],
      },
      always_on_docs: [
        { path: "specs/README.md", title: "Specs", body: "Spec guidance." },
        { path: "ai_docs/README.md", title: "AI Docs", body: "AI context." },
      ],
      feature_agents: [
        {
          name: "payments",
          description: "Payments specialist.",
          globs: ["src/payments"],
          body: "Use payment invariants.",
        },
      ],
      prompt_templates: [
        {
          name: "db-migration",
          description: "Use for database migrations.",
          body: "Check migrations before app code.",
        },
      ],
      experts: [
        {
          name: "billing",
          domain: "Billing",
          body: "Ask billing questions.",
        },
      ],
      extension_candidates: [
        {
          name: "migration-check",
          description: "Checks migration safety.",
          body: "export const name = 'migration-check';\n",
        },
      ],
      scaffold_runtime: {
        state_machine_notes: ["Use the default state contract."],
      },
    },
    expert_evidence: {
      expert_domains: [
        {
          domain: "billing",
          rationale: "Billing carries recurring payment invariants.",
          primary_paths: ["src/billing"],
          entry_points: ["src/billing/index.ts"],
          test_paths: ["tests/billing.test.ts"],
          key_files: [
            {
              path: "src/billing/index.ts",
              purpose: "Billing entry point.",
              line_range: [1, 120],
            },
          ],
          key_types: [
            {
              name: "Invoice",
              path: "src/billing/types.ts:1",
              purpose: "Stable billing contract.",
            },
          ],
          patterns: [
            {
              name: "idempotency",
              description: "Billing writes must be idempotent.",
              example_ref: "src/billing/index.ts:42",
            },
          ],
          pitfalls: [
            {
              risk: "Double charging on retry.",
              consequence: "Customers can be charged twice.",
              reference: "src/billing/index.ts:55",
            },
          ],
          conventions: ["Amounts are stored in cents."],
          stability: "high",
          recurrence: "high",
          test_command: "npm test -- tests/billing.test.ts",
          last_updated: "2026-07-05T00:00:00.000Z",
        },
      ],
    },
    customization_evidence: {
      custom_tool_candidates: [
        {
          name: "run-tests",
          existing_command: "npm test",
          purpose: "Run the repository test suite.",
          source_path: "package.json#scripts.test",
        },
      ],
      skill_candidates: [
        {
          name: "prime-db",
          purpose: "Prime the local database before integration tests.",
          steps_or_script_path: "scripts/prime-db.sh",
        },
      ],
    },
  });
  map.meta.lifecycle.per_area_template_candidates = [
    {
      area_name: "api-endpoint",
      issue_type: "feature",
      trigger_phrases: ["new API route", "endpoint change"],
      rationale: "API endpoint work is recurring and benefits from local routing conventions.",
      source_feature_agent: ".pi/agents/payments.md",
    },
  ];
  return map;
}
