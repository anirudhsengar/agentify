import { makeValidCodebaseMap } from "./codebase-map.ts";

export function makeSpecialistFixtureMap() {
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
    concern_evidence: {
      concerns: [
        {
          concern: "authentication",
          one_line: "Owns how a caller proves identity and how that proof is checked.",
          covers: "Login, session issue and renewal, and every enforcement point.",
          excludes: "Authorization, which decides what an identified caller may do.",
          flows: [
            {
              name: "user login",
              description: "Credential submission through session establishment.",
              steps: [
                { path: "src/routes/login.ts", what_happens: "Accepts the credential payload." },
                { path: "src/auth/verify.ts", what_happens: "Compares the hash and issues a session." },
                { path: "src/middleware/session.ts", what_happens: "Stores the session for later requests." },
              ],
            },
          ],
          touchpoints: [
            {
              path: "src/auth/verify.ts",
              symbol: "verifyCredential",
              role: "The only credential comparison in the codebase.",
              line_range: [12, 61] as [number, number],
              centrality: "core" as const,
            },
            {
              path: "src/routes/login.ts",
              symbol: null,
              role: "Entry point for credential submission.",
              line_range: null,
              centrality: "core" as const,
            },
            {
              path: "src/middleware/session.ts",
              symbol: "requireSession",
              role: "Rejects unauthenticated requests before any handler runs.",
              line_range: null,
              centrality: "core" as const,
            },
            {
              path: "tests/auth.test.ts",
              symbol: null,
              role: "Covers credential comparison and session expiry.",
              line_range: null,
              centrality: "supporting" as const,
            },
          ],
          invariants: [
            {
              rule: "Credentials are never written to logs.",
              why: "Log shipping would export secrets off-host.",
              reference: "src/auth/verify.ts",
            },
          ],
          pitfalls: [
            {
              risk: "Session renewal skips re-validation.",
              consequence: "A revoked account keeps access until expiry.",
              reference: "src/middleware/session.ts",
            },
          ],
          entry_questions: ["Does this change alter who is considered authenticated?"],
          validation: ["npm test -- tests/auth.test.ts"],
          spans_subtrees: ["src", "tests"],
          stability: "high" as const,
          recurrence: "high" as const,
          confidence: "high" as const,
          last_updated: "2026-07-05T00:00:00.000Z",
        },
        {
          concern: "billing",
          one_line: "Owns charging a customer exactly once.",
          covers: "Invoice construction, charge submission, and retry behaviour.",
          excludes: "Who is allowed to be charged, which authentication owns.",
          flows: [
            {
              name: "charge a cart",
              description: "Invoice construction through settled charge.",
              steps: [
                { path: "src/billing/index.ts", what_happens: "Builds the invoice from the cart." },
                { path: "src/billing/charge.ts", what_happens: "Submits the charge with an idempotency key." },
              ],
            },
            {
              name: "synthetic package entry",
              description: "The shared test fixture models two ordered operations at its tracked public entry.",
              steps: [
                { path: "src/index.ts", what_happens: "Exports the synthetic package entry used by installer fixtures." },
                { path: "src/index.ts", what_happens: "Provides the public-entry operation exercised by repository validation." },
              ],
            },
          ],
          touchpoints: [
            {
              path: "src/billing/index.ts",
              symbol: "buildInvoice",
              role: "Converts a cart into an invoice in cents.",
              line_range: [1, 120] as [number, number],
              centrality: "core" as const,
            },
            {
              path: "src/billing/charge.ts",
              symbol: null,
              role: "The single charge submission path.",
              line_range: null,
              centrality: "core" as const,
            },
            {
              path: "src/index.ts",
              symbol: null,
              role: "Synthetic public package entry used by installer boundary fixtures.",
              line_range: null,
              centrality: "core" as const,
            },
            {
              path: "src/lib.ts",
              symbol: null,
              role: "Synthetic public library facade used by packed-installation fixtures.",
              line_range: null,
              centrality: "core" as const,
            },
            {
              // Deliberately shared with authentication: the same file serves
              // two concerns for different reasons, which must produce a
              // related-specialist link rather than a merge.
              path: "src/middleware/session.ts",
              symbol: "currentCustomer",
              role: "Supplies the customer identity a charge is attributed to.",
              line_range: null,
              centrality: "supporting" as const,
            },
            {
              path: "tests/billing.test.ts",
              symbol: null,
              role: "Covers double-charge protection on retry.",
              line_range: null,
              centrality: "supporting" as const,
            },
          ],
          invariants: [
            {
              rule: "Amounts are stored in cents.",
              why: "Float arithmetic drifts across currency conversion.",
              reference: "src/billing/index.ts",
            },
          ],
          pitfalls: [
            {
              risk: "Double charging on retry.",
              consequence: "Customers can be charged twice.",
              reference: "src/billing/charge.ts",
            },
          ],
          entry_questions: ["Is this write idempotent under retry?"],
          validation: ["npm test -- tests/billing.test.ts"],
          spans_subtrees: ["src", "tests"],
          stability: "high" as const,
          recurrence: "high" as const,
          confidence: "high" as const,
          last_updated: "2026-07-05T00:00:00.000Z",
        },
      ],
      not_concerns: [
        {
          candidate: "utils",
          why_rejected: "A directory, not a specialty; its files belong to the concerns that use them.",
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

/** Every tracked path the concern fixture cites, for evidence verification. */
export const SPECIALIST_FIXTURE_TRACKED_FILES = [
  "src/auth/verify.ts",
  "src/billing/charge.ts",
  "src/billing/index.ts",
  "src/middleware/session.ts",
  "src/routes/login.ts",
  "tests/auth.test.ts",
  "tests/billing.test.ts",
];

/** Minimal immutable source for the concrete symbols claimed by this fixture. */
export const SPECIALIST_FIXTURE_SOURCES: Record<string, string> = {
  "src/auth/verify.ts": "export function verifyCredential() {}\n",
  "src/middleware/session.ts": "export function requireSession() {}\nexport function currentCustomer() {}\n",
  "src/billing/index.ts": "export function buildInvoice() {}\n",
};

/**
 * A map carrying only the superseded `expert_evidence` shape, for exercising
 * the migration path an installation predating the concern contract takes.
 */
export function makeLegacySpecialistFixtureMap() {
  const map = makeSpecialistFixtureMap();
  delete (map as { concern_evidence?: unknown }).concern_evidence;
  return map;
}
