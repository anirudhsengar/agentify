# Eval grader authoring

Agentify eval graders consume strict task configuration and structured imported
artifacts. They do not read chain-of-thought, infer missing costs, or run shell
strings from task files.

## Result contract

Every automated and human-review grader result records `grader_id`,
`grader_version`, one of `pass`, `fail`, `human_required`, `skipped`, or
`error`, a compatible boolean/null pass value, optional normalized score,
reason, evidence references, controlled failure categories, duration, optional
confidence, and an explicit error. A skipped, human-required, or errored grader
is unresolved and cannot make a trial or release gate pass.

## Deterministic checks

Configure `grader_configuration.deterministic.checks` as an array. Supported
checks are:

- `file_exists` / `file_absent` with repository-relative `value`;
- `allowed_paths` / `forbidden_paths` with glob-like `values`;
- `schema_validation` with the named supplied schema-result key;
- `command_status` with a stable `command_id`, category (`test`, `typecheck`,
  `lint`, or `approved`), and expected integer exit status;
- `diff_size` with `maximum_lines`;
- `dependency_changes` with an `allowed` boolean;
- `required_artifact` with an evidence reference.

Example:

```json
{
  "deterministic": {
    "checks": [
      { "type": "allowed_paths", "values": ["src/**", "tests/**"] },
      { "type": "forbidden_paths", "values": [".github/workflows/**"] },
      { "type": "command_status", "command_id": "unit", "category": "test", "expected_exit_status": 0 },
      { "type": "diff_size", "maximum_lines": 500 }
    ]
  }
}
```

`command_status` grades imported exit-status evidence. It is deliberately not a
command string. Raw commands, shell operators, and task-controlled executable
arguments are rejected. This release performs no eval command execution; a
future supported executor must use Agentify's execution policy and defense
mechanisms at the final runtime boundary.

## Outcome, process, and economics

Outcome evidence maps the exact expected/forbidden outcome text to `met`,
`not_met`, or `unknown`. Unknown or absent evidence returns `human_required`.
No LLM grader is used.

Process grading reads structured trace entries: tool category, action, optional
path, evidence, approval, and escalation references. Configure
`required_evidence`, `required_tool_categories`, and `approval_required`.
Free-form chain-of-thought is neither requested nor parsed.

Economics uses the trial's supplied cost/runtime plus optional supplied retry,
repeated-action, and human-review facts. Configure `maximum_retries`,
`maximum_repeated_actions`, `maximum_human_review_minutes`, and
`maximum_cost_per_accepted_outcome` (using supplied `accepted_outcome_count`). Missing values
needed by a configured limit fail; Agentify never substitutes invented values.

## Human review

A structured human review embedded in an imported trial artifact contains the
reviewer, UTC timestamp, judgment, minutes, comments, linked PR/issue, and
evidence reference. Judgments are `accept`, `accept_with_minor_changes`,
`major_rework`, `reject`, or `safety_concern`. The `human_review` grader keeps
this judgment distinct from automated confidence and never passes a safety
concern.

## Release policy

Suite `release_policy` may configure a minimum task count, required human-review
count, required safety graders, complete trace references, and complete
cost/runtime reporting. A technically complete run can remain ineligible.
Synthetic-only evidence is always insufficient for external release proof.
