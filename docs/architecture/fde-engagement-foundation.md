# FDE engagement foundation

## Purpose

The engagement domain is a private internal foundation for recording a typed
Forward Deployed Engineering charter and moving it through a controlled delivery
lifecycle. It does not add a CLI or model-backed behavior.

## Storage and ownership

The caller supplies Agentify's resolved provider-scoped state directory. Each
charter is stored at `engagements/<engagementId>/charter.json` beneath that
directory. `src/core/engagement/schema/` owns the charter and status TypeBox
contracts; `state.ts` owns validated persistence and optimistic concurrency;
`transitions.ts` owns lifecycle rules.

## Lifecycle

The forward path is draft, qualified, auditing, mapped, prioritized, designing,
building, evaluating, shadow, draft pilot, pilot, measuring, and completed.
Evaluation and later rollout phases may return to the documented build or pilot
stage. Every active stage may stop, with a required reason. Completed and stopped
are terminal.

## Concurrency and persistence

Creation starts at revision 1. Updates and transitions require the expected
revision, increment it, and update the timestamp using an injectable clock.
Charters are schema-validated before writes and after reads. Persistence writes a
durable same-directory temporary file and atomically renames it, preserving the
previous charter if preparation fails. Malformed data is reported and never
silently repaired.

## Security boundaries

Engagement IDs use a narrow ASCII allowlist and reject absolute, separator,
traversal, and encoded forms. Resolved paths are checked to remain under the
supplied state directory. The domain performs no network access, model calls, or
writes outside established Agentify state. It is not exported by the package or
reachable through the public CLI and does not depend on experimental runtimes.

## Deterministic engagement artifacts

An engagement may additionally persist `stakeholders.json`,
`current-workflow.json`, `target-workflow.json`, `opportunity-matrix.json`,
`automation-decisions.json`, `risk-register.json`, and `qualification.json` in
the same engagement directory. All files are strict TypeBox contracts with
unknown properties rejected. Current and target maps share one schema and each
ordered workflow step has a stable ID. Cross-artifact validators reject
duplicate IDs and references to missing workflow steps, stakeholders, or
workflows. Evidence is recorded only as caller-supplied references; this layer
does not collect, synthesize, or infer evidence.

## Supported CLI boundary

`agentify engage init`, `status`, `validate`, and `report` are the supported
record-and-analysis interface. `init` accepts explicit facts interactively or
through `--input`; `status` reports lifecycle, qualification, revision, and gaps;
`validate` performs strict schema and cross-file checks without repair; and
`report` atomically renders deterministic Markdown beneath the engagement's
`reports/` directory. This surface makes no model calls and does not expose AIW,
the orchestrator, webhooks, Agent Expert, evaluation, implementation, deployment,
or autonomy promotion.

## Opportunity scoring

All scoring inputs are explicit numbers from 0 through 100. The positive score
is `25% business value + 10% volume + 15% feasibility + 10% adoption readiness
+ 10% evaluation feasibility + 5% reversibility + 10% data availability + 5%
integration availability + 10% implementation simplicity`, where simplicity is
`100 - implementation complexity`. The separately reported risk penalty is 25%
of the risk score. The final score is the positive score minus that penalty,
clamped to 0–100 and rounded to two decimals.

Risk at 90 or above, or an explicit rejection reason, yields `reject`; risk at
70 or above yields `defer`. Otherwise scores at least 70 with evaluation
feasibility at least 60 yield `prioritize`; scores at least 55 with evaluation
feasibility at least 50 yield `pilot`; scores at least 35 yield `investigate`;
lower scores yield `defer`. ROI is reported only when supplied as numeric data.
Scoring supports human judgment and prioritization; it does not replace it.

## Qualification rules

Qualification checks a named workflow owner, clear problem, measurable outcome,
workflow evidence, sufficient frequency or explicit strategic justification,
data accessibility, technical and evaluation feasibility, acceptable risk or a
defined human control, an adoption owner, and absence of unresolved prohibited
conditions. Results are `qualified`, `conditionally_qualified`,
`insufficient_evidence`, or `rejected` with machine-readable reason codes.
Inaccessible data, technical infeasibility, uncontrolled unacceptable risk, and
prohibited conditions reject. Missing or unclear evidence produces
`insufficient_evidence`; other remediable gaps are conditional.

## Automation taxonomy and risk

Each step can remain unchanged, use deterministic software or rules, use
traditional ML, LLM classification or generation, agentic execution, remain a
human decision or approval, or be prohibited. AI choices must state why simpler
approaches were rejected. Agentic execution and human approval require an
explicit human-control checkpoint. A prohibited decision cannot define an
execution checkpoint. Every record also carries failure impact, reversibility,
fallback, required evidence, uncertainty, approval ownership, security
restrictions, and an optional maximum cost. Selecting no AI is a first-class
valid outcome.

Risk severity is derived from the product of 1–5 likelihood and impact: 1–4 is
low, 5–9 moderate, 10–16 high, and 17–25 critical. Risks identify detection,
mitigation, ownership, rollback/fallback, related steps, and evidence.

## Non-goals and follow-up

This milestone does not implement model-backed interviews, workflow discovery,
an evaluation engine, GitHub integration, scaffold behavior, implementation
automation, or a UI. The domain remains an internal composition building block.
