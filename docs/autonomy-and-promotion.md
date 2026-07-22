# FDE autonomy and promotion

Agentify records FDE autonomy explicitly. A level is a policy fact, not a claim that an automation runtime is active. Promotion commands are deterministic, invoke no model, and do not change GitHub behavior.

## Levels and current support

The ordered levels are `observe`, `draft`, `approved_execute`, `bounded_auto`, and `policy_auto`. `observe` and human-approved `draft` are supported operating levels. Draft only authorizes an isolated implementation run that may publish an unmerged draft pull request after validation; it never authorizes merge. `approved_execute` can be represented, but execution is not automated. `bounded_auto` is unavailable by default. `policy_auto` is unsupported and every attempted transition to it is rejected.

Promotions normally advance exactly one level. Skips, reverse transitions, implicit promotions, terminal-engagement promotions, and unsupported candidates fail closed. An approved record still cannot silently grant tools, change an execution policy, or enable a GitHub workflow.

## Policy and evidence

Each engagement stores `promotion-state.json` beneath its engagement state directory. The state contains a revisioned promotion policy, its existing execution-policy mode, and append-preserved decision records. Promotion evaluates that execution boundary but never widens it. A record binds the engagement and workflow, current and candidate levels, requester and approver, timestamp, evaluation run IDs, required and actual conditions, decision and reasons, review or expiration dates, rollback level, and policy version.

Thresholds are engagement-specific. Agentify does not invent universal pass rates, task counts, cost limits, or runtime limits. Policies can configure eligible-task count, pass@1, repeated-run consistency, major-rework rate, forbidden-action and security failures, cost, runtime, reviews, named owners, rollback and escalation tests, monitoring, risk-register status, an approval checkpoint, and unresolved critical risks. Zero forbidden-action and security failures are the normal safe choice, but must remain visible in the engagement policy.

Missing evidence is failure to establish a condition, not evidence that it passed. Omitted actual results are reported as `insufficient_evidence`. Values exactly on an inclusive threshold pass. Any failed safety condition blocks promotion. Evaluation reports list passed, failed, and missing requirements separately.

## Responsibilities, approval, and history

Use:

```bash
agentify engage promotion evaluate --id <engagement> --input promotion-evidence.json
agentify engage promotion status --id <engagement>
agentify engage promotion approve --id <engagement> --actor "Name" --yes
agentify engage promotion revoke --id <engagement> --actor "Name" --reason "Reason" --yes
```

The requester supplies the policy and evidence references. Named business and technical owners remain accountable for their configured conditions. Approval requires an explicit human actor and confirmation; no LLM can approve. Decisions are `approved`, `rejected`, `insufficient_evidence`, `expired`, or `revoked`.

Revocation appends a new audit record and derives the current level as the configured rollback level; it does not delete or rewrite the approval. Expiration likewise fails back to the rollback level. The deterministic Markdown report is stored at `reports/promotion.md` and includes direct rollback instructions.
