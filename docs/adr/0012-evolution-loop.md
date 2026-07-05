# ADR 0012: The self-refresh evolution loop

Status: Accepted

## Context

A codebase changes after bootstrap. The generated intelligence
(AGENTS.md, feature agents, experts) goes stale unless something keeps
it current.

## Decision

The scaffold stamps `agent-refresh-surface.yml`. On every push to the
default branch (and on manual dispatch), it runs the `/refresh-surface`
skill via Pi, performs a delta re-audit, and opens a PR when the
generated surface drifts. Its own refresh commits are skipped to avoid
a loop.

This closes the evolution loop: the repository continuously
re-understands itself and proposes updates to its own agentic surface.

## Consequences

- Refresh runs are gated by commit-message guards to prevent
  self-triggering.
- The delta re-audit reuses the same builder machinery as bootstrap.
- Refresh PRs are labeled `agent:review` and go through the normal
  review loop before merge.
