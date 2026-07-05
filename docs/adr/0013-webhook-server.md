# ADR 0013: Internal webhook server (parked)

Status: Accepted

## Context

Before the standalone pivot, agentify explored a local webhook daemon
as an alternative async ingress: a signed HTTP endpoint that receives
GitHub events and dispatches Pi work, rather than running Pi inside
GitHub Actions.

## Decision

The webhook server (`src/core/webhook/`) ships as **internal library
code**, not a public command. It is documented in
[docs/15-the-webhook-server.md](../15-the-webhook-server.md). The
**shipped async loop is the GitHub Actions scaffold**
([0007](0007-pi-as-the-ci-coding-harness.md)), not the webhook server.

The webhook server is retained as foundation code for a future unified
control plane. It is not started by the public `agentify` command.

## Consequences

- The contract test still requires the webhook source files and this
  ADR to exist, marking them as intentionally-shipped internal code.
- There is no supported deployment story for the webhook daemon today;
  the canonical loop is the scaffold.
- If the webhook path is ever promoted, this ADR should be superseded
  with a deployment design.
