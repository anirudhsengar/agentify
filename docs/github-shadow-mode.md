# GitHub shadow mode operator guide

GitHub shadow mode is Agentify's supported analysis-only FDE deployment mode.
It extends the installed GitHub scaffold and needs no hosted service, webhook,
public orchestrator, implementation branch, or pull request.

## Configuration

The managed `.github/agentify-shadow.json` supports `disabled`, `shadow`, and
human-approved `draft`. New and upgraded installations receive `disabled`;
Agentify never silently activates either workflow. Shadow enabling requires valid IDs for an
existing engagement, eval suite, and task, plus a validation policy and cost
and runtime ceilings. `comment_on_issue` defaults to false.

An operator enables `shadow`, commits that configuration intentionally, and
adds `agent:shadow` to an issue. The issue event—not its title or body—supplies
the issue number. Engagement and eval identities come only from the committed
configuration and validated Agentify state. Repository identity, workflow run,
attempt, and commit come from the GitHub runner and checkout and are
cross-checked before evidence is accepted.

## Security model

The workflow receives `contents: read`, uses checkout with persisted
credentials disabled, and has no branch, commit, push, PR, merge, dependency,
or destructive-command step. The runner refuses a dirty checkout and verifies
that only the resolved Agentify state directory changed. Unique workflow run
IDs and issue-scoped GitHub concurrency prevent two processes from sharing an
eval run directory; general JSONL multi-process locking remains out of scope.

Issue text, repository data, command/model output, and errors are untrusted.
The packet stores bounded facts and evidence references rather than source
excerpts. Known token/key forms are redacted, raw environment variables are
never stored, and grader exceptions are reduced to fixed messages. The compact
optional issue comment excludes traces, source excerpts, secrets, and the full
packet. Operators should still use private repositories for sensitive work and
review GitHub artifact access and retention policies.

## Evidence packet

`evidence-packet.json` and `summary.md` record the engagement, issue, repository
commit and identity, audit version, current workflow, readiness checks,
evidence references, candidate modules/files, plan, risks, approvals, tests,
escalations, uncertainties, measured cost/runtime, grader results, failure
categories, execution policy, and an explicit no-code-change statement.

The packet digest is SHA-256 over the canonical packet payload before the
digest field is attached, avoiding a self-referential hash. Its live trial
attestation binds repository identity, GitHub repository, issue, run and
attempt, exact commit, engagement, suite, task, trial index, Agentify and audit
versions, timestamps, policy version, and that digest.

Classification is `valid_live_shadow_evidence`,
`incomplete_live_shadow_evidence`, or `invalid_live_shadow_evidence`. Shadow
evidence can support readiness, evidence completeness, recommended scope and
files, escalation, risks, proposed tests, cost, runtime, and policy compliance.
It never proves code correctness, issue resolution, implementation tests, PR
acceptance, or production value, and cannot gate an Agentify package release.

## Readiness and evaluation

Deterministic checks produce `ready`, `needs_information`, `rejected`, or
`requires_human_decision` and identify missing acceptance criteria,
reproduction, ambiguous scope, security scope, dependency changes, tests,
ownership, and forbidden actions. The evaluation grades required evidence,
candidate-file support, scope, escalation, forbidden actions, runtime, cost,
and completeness. A missing audit is explicit and yields incomplete evidence;
it is not silently fabricated or refreshed with write-capable tools.

## Limits and troubleshooting

- Candidate files are evidence-backed recommendations, not an implementation.
- The first milestone does not invoke a model or refresh a missing audit; run a
  normal approved brownfield audit first when the packet says `audit:missing`.
- A corrupt engagement, suite, task, event, or repository identity fails before
  a trusted trial is emitted.
- Cancellation may leave no artifact; rerun the label event after confirming no
  other issue-scoped run is active. Timeout is enforced by both workflow and
  configured evidence policy.
- If upload reports no files, inspect the fixed, redacted workflow error and
  validate engagement/eval state locally.

## Migration from an existing scaffold

Run the normal Agentify scaffold refresh with GitHub runtime explicitly opted
in. Managed files update in place; user-owned workflow changes are preserved
and the new managed version is written alongside according to Agentify's
managed-file policy. Reconcile alongside files manually, commit them, run
`bash tests/run.sh`, and leave shadow configuration disabled until the IDs and
permissions have been reviewed.

## Example issue flow

1. A maintainer validates engagement `invoice-review`, suite `regression`, and
   task `issue-readiness`, then enables shadow mode with comments disabled.
2. The maintainer adds `agent:shadow` to issue #42.
3. The workflow analyzes the exact checked-out commit without credentials,
   emits readiness and recommendations, creates a live shadow eval trial, and
   uploads `agentify-shadow-<run>-<attempt>`.
4. A human reviews the packet and chooses whether to clarify, reject, approve
   sensitive scope, or start a separate implementation workflow.
