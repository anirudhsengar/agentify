# Human-approved GitHub draft mode

Agentify draft mode is the first supported code-writing FDE level. Its only publication outcome is an unmerged GitHub draft pull request for human review. Agentify does not merge pull requests, enable auto-merge, force-push, or push to the default branch.

## Prerequisites and promotion

Draft mode is disabled in new installations. Before enabling it:

1. Complete an engagement through the `shadow` lifecycle (or the explicitly controlled `draft_pilot` lifecycle).
2. Run GitHub shadow mode on the exact intended base commit and retain a `valid_live_shadow_evidence` packet whose readiness is `ready` and whose required graders pass.
3. Configure engagement-specific promotion conditions, evaluate them, and run `agentify engage promotion approve --actor "Human Name" --yes`. The active promotion must resolve the autonomy level to `draft` and must not be expired, due for review, or revoked.
4. Ensure the risk register has no unresolved critical risk.
5. Configure `.github/agentify-shadow.json` with `mode: "draft"`, explicit cost/runtime limits, forbidden paths, dependency policy, and argv-vector checks for build, tests, typecheck, lint, and security. Empty checks fail closed. Failed validation is not publishable unless `allow_failed_draft` is explicitly set; its safe default is `false`.
6. Configure `PI_API_KEY`, `AGENT_PAT`, model variables, and an `AGENT_PAT` that can create branches and draft PRs. The workflow declares `contents: write`, `pull-requests: write`, `issues: write`, and `actions: read`; admission rejects a weaker declared permission packet.

The promotion record and shadow evidence authorize eligibility, not execution. A maintainer with write permission provides the separate per-run approval by applying `agent:implement`. Bot identities are rejected as human approvers. The approval is bound to the issue, actor, workflow run, expiry, and exact base commit and is retained in the evidence artifact.

## Isolation and implementation

The supported isolation adapter is the ephemeral GitHub Actions checkout. It begins at the approved base commit, receives no persistent model credentials, and is discarded by the runner on success, failure, timeout, or cancellation. The AIW worktree implementation is not imported or exposed. Each attempt creates a collision-resistant `agent/draft-<issue>-<run>-<attempt>-<slug>` branch. A remote branch with different content is a hard collision; it is never overwritten. A matching partial push can be resumed without another push.

The credential-free implementation agent receives the captured issue and acceptance criteria, codebase audit and generated repository intelligence, shadow candidate files and approved plan, risk controls and forbidden actions, configured tests, cost/runtime limits, and the human approval record. Issue and repository text remain untrusted and cannot widen tools or policy.

## Validation and evidence

Trusted validation executes configured command argument arrays directly, without a shell. Results are structured by kind: build, tests, typecheck, lint, and security. The validator also checks the diff, forbidden paths, dependency manifests/locks, generated-file ownership, non-empty changes, cost, and runtime. Missing checks, timeout, failed commands, forbidden changes, undeclared dependency changes, ownership failures, cost overrun, or runtime overrun block publication by default.

The redacted evidence artifact contains the engagement and issue, base and branch, approved plan, changed files and diff summary, validation and eval results, reserved cost upper bound, measured workflow runtime, retries, approval, risks, uncertainties, escalations, and rollback instructions. It excludes credentials and full internal traces and states that the PR is a draft and unmerged.

## Publication and human review

The trusted publisher uses a normal `git push --set-upstream` for the unique run branch, then `gh pr create --draft`. It applies `agentify:draft` and `agent:review`, links the issue, and points to the detailed workflow artifact. It never uses force push, default-branch push, merge, or auto-merge.

Human review is captured with the `Agent Draft Human Review` workflow. The reviewer records `accepted`, `minor_changes`, `major_rework`, `rejected`, or `safety_concern`, plus review time, notes, and final outcome. The workflow verifies the PR is still a draft and emits a strict imported-trial artifact for `agentify eval run --input`, including the native human-review facts and evaluation failure categories.

## Failure recovery, cleanup, and revocation

- Base moved, stale/expired promotion, revoked approval, readiness failure, critical risk, missing evidence, or insufficient GitHub permission: stop before model execution; refresh the evidence or approval and retry.
- Merge conflict or validation failure: no PR is published by default. Fix the issue or configuration and start a newly approved run.
- Cost/runtime overrun, agent timeout, or cancellation: the ephemeral checkout is discarded; no default-branch mutation occurs.
- Branch collision, duplicate rerun, or existing PR: stop rather than overwrite. Use the existing draft or close it and issue a fresh approval. Unique attempts never reuse another run's branch.
- Partial push or PR/API failure: the unique remote branch is retained for diagnosis. If its SHA matches the local evidence, publication may be resumed; otherwise delete it manually and start a new run.
- State corruption: repair or restore engagement state; the gate never guesses.

After rejection or a safety concern, revoke with `agentify engage promotion revoke --actor "Human Name" --reason "..." --yes`. Revocation appends history and returns to the configured rollback level. Close the draft PR and delete its unique branch manually when no longer needed. Agentify does not merge—under any draft-mode outcome, merging remains an independent human repository action.
