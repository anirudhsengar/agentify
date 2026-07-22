# FDE evaluation architecture

Agentify's supported evaluation layer measures explicitly defined FDE workflow
outcomes. It complements technical, package, generated-output, security,
scaffold, smoke-evidence, and release-qualification checks; it does not replace
them. The layer does not expose or import the experimental orchestrator or AIW.

## Data model

An **eval task** is a versioned, strict contract for one workflow case. It names
the repository fixture or external repository reference, structured workflow
input, expected and forbidden outcomes, required escalations, allowed actions,
risk and resource limits, grader configuration, evidence, tags, and provenance.
Unknown fields are rejected. A task is not an instruction to run autonomous
code: execution references and artifacts enter through a supported adapter.

An **eval suite** pins a versioned ordered set of task references, required
graders, trial count, concurrency ceiling, environment requirements,
aggregation policy, release-gate designation, and its own provenance. Loading a
suite resolves every task reference, rejects duplicate loaded task IDs, and
checks that each task belongs to the suite. Trial plans sort task IDs and use
zero-based trial indexes, making the plan stable for a given suite and run ID.

A **trial** is one attempt at one task. Its identity is `(run_id, task_id,
trial_index)`. It records start/end time, status, structured inputs, environment
and execution references, transcript or audit-trail reference, cost, runtime,
outputs, error, grader results, final pass/fail, and controlled failure
categories. Failed and skipped trials remain in evidence and in reports.

A **grader** is a named supported adapter in this foundation. It receives a
validated task and a supplied trial artifact, and returns a strict result with
version, `pass`, `fail`, `human_required`, `skipped`, or `error` status,
optional normalized score, reason, evidence, duration, confidence, error, and
failure categories. A missing or throwing adapter becomes a visible grader
error and `grader_failure`; it is never treated as a pass. Deterministic,
outcome, process, economics, and structured human-review graders are supported.
Model-based graders remain outside this release.

An **outcome** is the combination of the final trial pass boolean, its grader
results, and its failure categories. Application-owned adapters and schemas—not
free-form model prose—determine authoritative outcomes.

## Provenance

Every task has a matching top-level `source_type` and discriminated provenance:

- `synthetic` is authored or generated for evaluation and must state
  `generated_for_evaluation: true`. It must never be labeled historical.
- `historical` is derived from a real prior workflow record and must retain a
  `historical_record_reference`.
- `live` describes a current authorized case and must retain an
  `authorization_reference`.

The runner rejects a mismatch between the declared source type and provenance.
Reports count each source type. A suite composed only of synthetic tasks can
inform engineering but cannot gate a release; no golden dataset is fabricated.

## Storage and interruption recovery

Evaluation state is kept below the existing engagement root:

```text
<stateDir>/engagements/<engagementId>/evals/
  suites/<suiteId>.json
  tasks/<taskId>.json
  runs/<runId>/
    run.json
    trials.jsonl
    grader-results.jsonl
    summary.json
    report.md
```

IDs are path-safe and paths may not escape the resolved state directory or
traverse symlinks. JSON snapshots use a durable temporary write followed by an
atomic rename. JSONL records are appended as one newline-terminated JSON value
and fsynced. Readers reject invalid records and incomplete final lines.

`run.json` persists the deterministic plan. On resume, the runner validates the
file and requires the stored plan to match the newly resolved plan. Completed
trial identities are read from `trials.jsonl` and skipped, so a completed trial
is never silently rerun. Missing imported artifacts in no-execution/imported
operation become explicit skipped trials. Corrupt state stops the run. The
foundation fails clearly for `execute` mode because no supported execution
adapter exists yet.

## Supported CLI

`agentify eval validate` checks schemas, cross-references, grader configuration,
adapter availability, provenance, and configured release-policy preconditions.
`agentify eval run` grades supplied JSON trial artifacts (or records explicit
skips when artifacts are absent), prints the run ID, persists progress, and
resumes by stable trial identity. `agentify eval report` regenerates and
optionally prints the deterministic report.

Command checks use imported named/categorized exit-status evidence. Eval task
files cannot provide executable shell strings, so this release never executes
untrusted task commands.

## Aggregation

Let `C` be completed terminal trials (passed, failed, skipped, or error), `P`
the passed trials, and `T` the tasks declared by the suite.

- **Trial pass rate:** `|P| / |C|`, or `0` when `C` is empty. Skips and errors
  remain in the denominator.
- **Task pass rate:** the fraction of all suite tasks satisfying the suite's
  task policy. `any_trial` requires at least one passing trial; `all_trials`
  requires all planned trials to be present and pass. An incomplete task does
  not pass.
- **pass@1:** the fraction of tasks whose single first trial (`trial_index = 0`)
  passes. It is reported only when every task has a first trial; otherwise it is
  not applicable. This is observed first-attempt success, not an estimator.
- **Repeated-trial success:** the fraction of suite tasks with at least one
  observed passing trial across the repeated attempts.
- **All-k success (`pass^k`):** when `k` is configured, the fraction of tasks
  for which the first `k` trials all exist and pass. This is not `pass@k`.

This foundation intentionally does not call repeated-trial success `pass@k`.
The common pass@k estimator answers a different sampling question and is not
implemented here.

Totals sum supplied cost and runtime over terminal trials. Failure distribution
counts each category attached to each trial. Missing graders, grader errors, and
safety failures are reported separately.

## Failure taxonomy and evolution

The initial versioned taxonomy is `missing_context`, `incorrect_scope`,
`wrong_module`, `wrong_tool`, `incorrect_assumption`, `hallucinated_api`,
`unsafe_action`, `permission_failure`, `test_failure`, `incomplete_task`,
`unnecessary_complexity`, `failed_escalation`, `poor_explanation`,
`excessive_cost`, `timeout`, `user_rejection`, `environment_failure`,
`grader_failure`, and `unknown`. Schemas reject arbitrary strings. Additions
require an explicit schema-version evolution and compatibility review.

## Transcripts and release eligibility

Trials store a reference to a transcript or immutable audit trail rather than
embedding uncontrolled prose in run state. The referenced evidence remains
available to graders and reviewers without becoming authoritative state.

A run is release-gate eligible only when the suite is designated eligible, the
run is complete, required graders are present and error-free, no safety failure
exists, every trial passes, and the task set is not synthetic-only. Eligibility
is evidence for the existing release qualification process, not a replacement
for package, security, smoke, or technical checks.
