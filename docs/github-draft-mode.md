# Human-approved GitHub draft mode

Agentify draft mode is the first supported code-writing FDE level. Its only publication outcome is an unmerged GitHub draft pull request for human review. Agentify does not merge pull requests, enable auto-merge, force-push, or push to the default branch.

## Prerequisites and promotion

Draft mode is disabled in new installations. Before enabling it:

1. Complete an engagement through the `shadow` lifecycle (or the explicitly controlled `draft_pilot` lifecycle).
2. Run GitHub shadow mode on the exact intended base commit and retain a `valid_live_shadow_evidence` packet whose readiness is `ready` and whose required graders pass.
3. Configure engagement-specific promotion conditions, evaluate them, and run `agentify engage promotion approve --actor "Human Name" --yes`. The active promotion must resolve the autonomy level to `draft` and must not be expired, due for review, or revoked.
4. Ensure the risk register has no unresolved critical risk.
5. Configure `.github/agentify-shadow.json` with `mode: "draft"`, explicit cost/runtime and input/output-token limits, a versioned exact-model pricing policy, forbidden paths, dependency policy, and argv-vector checks for build, tests, typecheck, lint, and security. Empty checks and unknown model pricing fail closed. Failed validation commands are not publishable unless `allow_failed_draft` is explicitly set; its safe default is `false`. That override never permits cost, runtime, mutation, ownership, promotion, approval, evidence-integrity, grader, or security failures.
6. Configure `PI_API_KEY`, `AGENT_PAT`, model variables, and an `AGENT_PAT` that can create branches and draft PRs. The workflow declares `contents: write`, `pull-requests: write`, `issues: write`, and `actions: read`; admission rejects a weaker declared permission packet.

The promotion record and shadow evidence authorize eligibility, not execution. A maintainer with write permission provides the separate per-run approval by applying `agent:implement`. Bot identities are rejected as human approvers. The approval is bound to the issue, actor, workflow run, expiry, and exact base commit and is retained in the evidence artifact.

## Isolation and implementation

The supported isolation adapter is the ephemeral GitHub Actions checkout. It begins at the approved base commit, receives no persistent model credentials, and is discarded by the runner on success, failure, timeout, or cancellation. The AIW worktree implementation is not imported or exposed. Each attempt creates a collision-resistant `agent/draft-<issue>-<run>-<attempt>-<slug>` branch. A remote branch with different content is a hard collision; it is never overwritten. A matching partial push can be resumed without another push.

The credential-free implementation agent receives the captured issue and acceptance criteria, codebase audit and generated repository intelligence, shadow candidate files and approved plan, risk controls and forbidden actions, configured tests, cost/runtime limits, and the human approval record. Issue and repository text remain untrusted and cannot widen tools or policy.

## Validation and evidence

Trusted validation executes configured command argument arrays directly, without a shell. Results are structured by kind: build, tests, typecheck, lint, and security; raw command output is not persisted because repository-controlled checks may print secrets. The validator also checks the diff, forbidden paths, dependency manifests/locks, generated-file ownership, non-empty changes, cost, runtime, and that validation commands left both `HEAD` and the worktree unchanged. Missing checks, timeout, failed commands, forbidden changes, undeclared dependency changes, ownership failures, validation-time mutation, cost overrun, or runtime overrun block publication by default.

The redacted evidence artifact contains the configured budget separately from reserved exposure, measured cost, estimated cost, unknown/measurement status and limit status. It also contains model-call usage records and application cancellation evidence. A configured maximum is never reported as actual spend. See [draft cost accounting](draft-cost-accounting.md) and [runtime cancellation](draft-runtime-cancellation.md).

## Publication and human review

The trusted publisher binds the branch SHA to the validated implementation `HEAD` and queries the exact repository, owned head branch, and expected base before creation. A deterministic body marker binds the PR to the engagement, issue, and branch. A matching owned draft is recovered and persisted; a mismatched PR is an ownership conflict. After any create error the publisher queries again, so a crash or response loss after successful GitHub creation converges on the same PR. It never uses force push, default-branch push, merge, or auto-merge.

Human review is captured with the `Agent Draft Human Review` workflow. The reviewer records `accepted`, `minor_changes`, `major_rework`, `rejected`, or `safety_concern`, plus review time, notes, and final outcome. The workflow verifies the PR is still a draft and emits a strict imported-trial artifact for `agentify eval run --input`, including the native human-review facts and evaluation failure categories.

## Failure recovery, cleanup, and revocation

- Base moved, stale/expired promotion, revoked approval, readiness failure, critical risk, missing evidence, or insufficient GitHub permission: stop before model execution; refresh the evidence or approval and retry.
- Merge conflict or validation failure: no PR is published by default. Fix the issue or configuration and start a newly approved run.
- Cost/runtime overrun, agent timeout, or cancellation: the ephemeral checkout is discarded; no default-branch mutation occurs.
- A matching owned PR is recovered on retry. A non-Agentify, non-draft, wrong-base, or wrong-head match is an ownership conflict and is never reused.
- Partial push or PR/API failure: the owned remote branch is retained and marked orphaned. Retry publication with the same run state to recover an already-created PR.
- State corruption: repair or restore engagement state; the gate never guesses.

To remove an orphan, run `GH_REPO=owner/repo GH_TOKEN=... bash .github/scripts/cleanup-draft-branch.sh <draft-run-state.json> <agent/draft-...> --confirm`. The command verifies recorded ownership, refuses default/protected/non-Agentify branches and branches with active PRs, and deletes only the named remote branch. Agentify does not merge—under any draft-mode outcome, merging remains an independent human repository action.
