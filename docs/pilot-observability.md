# Pilot measurement and factual observability

Milestone 6A instruments real shadow and human-approved draft pilots. It does
not claim pilot outcomes, prove business value, authorize broader autonomy, or
replace a productization review. Repeated real pilot data is required before
final outcome conclusions.

## Storage and event reference

Each engagement owns `metrics/run-events.jsonl`, `review-events.jsonl`,
`outcome-events.jsonl`, `adoption-events.jsonl`, `aggregates.json`, and
`pilot-report.md`. There is no global metrics store. Events are closed TypeBox
variants for run start/completion, readiness, plan, draft publication, human
review, intervention, incident, adoption, and baseline observations. Common
identity, timestamp, source, provenance, evidence references, redaction status,
and payload fields are mandatory.

Evidence quality is one of `measured`, `human_supplied`, `derived`, `estimated`,
or `unavailable`. Missing values remain unavailable, never zero. Measured and
estimated model costs are totaled separately; reserved exposure is reported as
exposure and never spend. Shadow recommendations are never implementation
success.

JSONL uses the evaluation append primitive: one fsynced append per record,
strict schema reads, rejection of incomplete final records, and no silent
corruption recovery. Event IDs are deterministic hashes of canonical event
facts, so retries are idempotent. Files preserve history and reads are sorted by
timestamp then event ID. Like the existing append primitive, this supports one
writer per engagement stream; concurrent writers for the same run are not
supported and must be serialized by GitHub workflow concurrency or the operator.

## Automatic and human evidence

Shadow collection reads runner identity, clocks, repository commit, structured
readiness/plan fields, grader results, and the evidence packet. Draft collection
reads admission, hardened cost accounting, cancellation/deadline state,
structured validation, and GitHub publication recovery state. Operators do not
re-enter those facts.

Human-only facts use strict JSON input and explicit confirmation:

```text
agentify engage metrics record-baseline --id ID --input baseline.json --yes
agentify engage metrics record-review --id ID --input review.json --yes
agentify engage metrics record-adoption --id ID --input adoption.json --yes
```

Inputs must identify the selected engagement, use source `operator`, and mark
provenance `human_supplied`. Review comments should be stored in an approved
system and referenced; do not copy secrets or private source into comments.
Agentify does not infer satisfaction from prose.

Baselines may use historical repository evidence, maintainer measurements,
direct observation, or a structured estimate. Preserve each provenance record
and sample window. Never invent labor rates or translate time into money without
an explicit supplied value model.

## Aggregation and interpretation

`metrics status` shows current counts and separate cost totals. `metrics report`
writes deterministic aggregates and Markdown. It reports run/mode/completion,
failure/cancellation/timeout/safety/escalation counts; measured and estimated
cost; runtime, time-to-plan, time-to-draft, and review percentiles; acceptance,
rework, rejection, interventions, and repeat use. Every distribution includes
sample size. Percentiles use the deterministic nearest-rank method after numeric
ascending sort. Missing samples produce `unavailable`, not a percentile.

Fewer than five runs produces a small-sample warning. A larger sample removes
that warning but does not establish causality. Conclusions are limited to
`no_pilot_data`, `collecting_data`, `insufficient_sample`,
`technical_pilot_complete`, `human_review_incomplete`, or `safety_blocked`.
The report cannot declare ROI, business value, product-market fit, readiness to
scale, or readiness for autonomous operation.

## Privacy, provenance, and operator checklist

Reports contain structured values and safe references, not tokens, credentials,
environment dumps, raw validation output, or unnecessary private source. Human
comments remain references or must be redacted using repository conventions.

Before a pilot: select the engagement deterministically; verify charter,
workflow, risk, eval, promotion, budget, runtime, and redaction policy; serialize
writers. After each run: retain authoritative artifacts, record human review,
inspect corruption/status, generate the report, review missing evidence and
incidents, and make no business or productization conclusion from instrumentation
alone.
