import type { GreenfieldFormation } from "../../src/core/greenfield-artifacts.ts";

export function makeGreenfieldFormation(): GreenfieldFormation {
  return {
    schema_version: "1",
    stop_at: "spec",
    project_name: "InvoiceFlow",
    context: {
      summary:
        "InvoiceFlow is a local-first invoice processing CLI for operators who need deterministic imports, idempotent payment attempts, and reviewable reconciliation reports before any hosted payment integration exists.",
      domain_terms: [
        {
          name: "Invoice",
          meaning:
            "A customer billing document imported from a local fixture and normalized before any payment attempt is created.",
        },
        {
          name: "Payment attempt",
          meaning:
            "One idempotent attempt to settle an invoice, tracked separately from the invoice so retries are explicit and auditable.",
        },
        {
          name: "Reconciliation report",
          meaning:
            "A deterministic output summarizing imported invoices, attempted payments, skipped duplicates, and unresolved items.",
        },
      ],
    },
    final_system_goal:
      "Build a local-first invoice processing CLI that can import invoice fixtures, execute idempotent payment attempts, and produce deterministic reconciliation reports that operators can review before connecting external payment providers.",
    phases: [
      {
        title: "Core Invoice Loop",
        goals: [
          {
            title: "Process invoices end to end",
            status: "planned",
            mode: "Sequential",
            objective:
              "Create the first complete invoice workflow from fixture import through idempotent payment attempt and reconciliation output.",
            sub_goals: [
              "Import a small invoice fixture and normalize the customer, amount, due date, and invoice identifier fields.",
              "Execute one idempotent payment attempt per invoice using a stable key derived from invoice identity.",
            ],
            required_artifacts: [
              "A PRD that defines the operator-facing invoice processing behavior.",
              "A plan, executable issue slice, and build spec for the first vertical import path.",
            ],
            dependencies: [
              "None. The first phase can start with local fixtures and no external provider integration.",
            ],
            definition_of_done: [
              "An operator can run the CLI against a fixture invoice and see a deterministic reconciliation report.",
              "Repeated runs with the same fixture do not create duplicate payment attempts.",
            ],
            spawned: [
              "docs/prds/first.md",
              "docs/plans/first.md",
              "docs/issues/001-import-invoices.md",
              "specs/feature-first.md",
            ],
            next_action:
              "Review docs/plans/first.md, then run `/to-issues docs/plans/first.md` if the ordering still matches the product goal.",
          },
        ],
      },
    ],
    prds: [
      {
        slug: "first",
        title: "Invoice Processing PRD",
        problem_statement:
          "Operators need a reliable local workflow for importing invoice data and attempting payment without accidentally duplicating work when the same fixture is processed more than once.",
        solution:
          "Provide a CLI-centered workflow that imports invoice fixtures, derives idempotency keys, records payment attempts, and writes a deterministic reconciliation report.",
        user_stories: [
          "As an operator, I want to import an invoice fixture, so that I can process billing work locally before adding integrations.",
          "As an operator, I want repeated runs to reuse idempotency keys, so that duplicate payment attempts are prevented.",
          "As a reviewer, I want a deterministic reconciliation report, so that I can compare behavior across implementation slices.",
        ],
        implementation_decisions: [
          "Keep the first slice local-only and defer hosted payment provider integration until the reconciliation loop is proven.",
          "Model payment attempts separately from invoices so idempotency behavior can be tested without external services.",
          "Expose behavior through the CLI because that is the user-facing seam for the first release.",
        ],
        testing_decisions: [
          "Test through the CLI boundary using fixture invoices instead of asserting parser internals.",
          "Include a repeated-run case to prove the idempotency key prevents duplicate payment attempts.",
        ],
        out_of_scope: [
          "Hosted provider integration, dashboards, background jobs, and multi-tenant account management are not part of this first PRD.",
        ],
        further_notes: [
          "The reconciliation report should be stable enough to snapshot or compare as plain text in tests.",
        ],
      },
    ],
    plans: [
      {
        slug: "first",
        title: "Invoice Processing Plan",
        prd: "docs/prds/first.md",
        ordering: [
          {
            slice: "Import an invoice fixture and print a deterministic invoice summary.",
            rationale:
              "This validates the CLI boundary and fixture parsing before payment attempt state is introduced.",
          },
          {
            slice: "Add idempotent payment attempt recording for repeated invoice imports.",
            rationale:
              "This retires the central duplicate-payment risk after the import path is observable.",
          },
        ],
        open_risks: [
          "The exact idempotency key shape may need one more review once fixture identity fields are finalized.",
        ],
      },
    ],
    issues: [
      {
        slug: "001-import-invoices",
        title: "Import invoices",
        parent: "docs/plans/first.md",
        what_to_build:
          "Create the first vertical slice that accepts one invoice fixture path at the CLI boundary and prints a deterministic invoice summary suitable for reconciliation review.",
        acceptance_criteria: [
          "The CLI accepts a path to one invoice fixture.",
          "The command prints invoice identifier, customer, amount, and due date in a deterministic order.",
          "The behavior is covered by a test that invokes the public CLI seam.",
        ],
        blocked_by: [
          "None - can start immediately.",
        ],
      },
    ],
    specs: [
      {
        slug: "first",
        title: "Feature Spec: Import invoices",
        change_type: "feature",
        relevant_files: [
          {
            path: "src/cli.ts",
            purpose:
              "Public CLI entry point where the fixture import command should become visible to users.",
          },
          {
            path: "tests/import.test.ts",
            purpose:
              "Behavior-level test file for invoking the CLI with a fixture invoice.",
          },
        ],
        steps: [
          "Add a fixture parser that extracts invoice identifier, customer, amount, and due date.",
          "Expose the parser through a CLI command that accepts one invoice fixture path.",
          "Print a deterministic invoice summary so later reconciliation behavior has a stable baseline.",
        ],
        validation_commands: [
          "npm test",
        ],
      },
    ],
  };
}
