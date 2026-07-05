# ADR 0005: `agent:*` GitHub label taxonomy

Status: Accepted

## Context

After bootstrap, work is routed through GitHub. We need a small,
predictable vocabulary that both humans and workflows understand for
signalling intent on issues and PRs.

## Decision

agentify uses an `agent:*` label taxonomy, stamped and validated by
`scaffold/.github/scripts/setup-agentify.sh`:

| Label | Meaning |
|-------|---------|
| `agent:queued` | Issue is a ready, executable slice; not yet picked up. |
| `agent:implement` | Go signal. Triggers the implement workflow. |
| `agent:review` | PR is ready for the review workflow. |
| `agent:approved` | Review passed; human merge approval remains. |
| `agent:blocked` | A run failed or preconditions were unmet. |
| `agent:drill-me` | Issue should be drilled/triaged by the agent. |
| `agent:update-branch` | Rebase/merge base into the PR branch. |

Labels are the trigger surface because label-add events are cheap,
auditable, and permission-controllable.

## Consequences

- `agent:queued` + `agent:implement` are both required before
  implement runs; see `scaffold/.github/scripts/check-issue-ready.sh`.
- Creating an issue alone does not start work; a go-label does. See
  [the lifecycle doc](../lifecycle/README.md).
