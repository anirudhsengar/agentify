# ADR 0007: Pi as the CI coding harness

Status: Accepted

## Context

The GitHub-first loop needs an agent to run inside GitHub Actions when
an issue or PR is labeled. That agent must install quickly, run
non-interactively, and honor the repository's skills.

## Decision

The stamped scaffold runs Pi in CI. `scaffold/.github/actions/setup-pi`
installs a pinned `@earendil-works/pi-coding-agent` version;
`scaffold/.github/actions/run-pi` invokes
`pi --print --no-session --approve` with the provider, model, and
thinking level supplied as Actions secrets/variables.

The same harness (Pi) is used locally by the builder
([0001](0001-in-process-pi-session.md)) and in CI, so skills and
prompts behave consistently across both.

## Consequences

- CI requires `PI_API_KEY` (secret) and `PI_VERSION` / `PI_MODEL`
  (variables); see [the webhook/CI setup](../lifecycle/README.md).
- CI Pi runs trust project-local resources (`--approve`); the trusted
  runtime is checked out from the base branch into `.agentify-runtime`
  to prevent PR-branch tampering with the harness.
