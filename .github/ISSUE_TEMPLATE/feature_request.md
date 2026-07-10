---
name: Feature request
about: Propose a new capability for the agentify CLI
title: "[feat] "
labels: ["enhancement", "needs-triage"]
assignees: []
---

## Problem

<!-- What user-facing problem does this solve? Frame it from the
perspective of someone running `agentify` in a real repo. -->

## Proposed solution

<!-- Describe the change at the level of: which subcommand, flag, or
artifact is added or modified. If this changes `package.json` `files`,
`bin`, the `files` allowlist, or runtime dependencies, call it out —
agentify treats new runtime deps as gated and requiring maintainer
approval (see AGENTS.md). -->

## Alternatives considered

<!-- Briefly note any alternative shapes you considered and why this one
wins. -->

## Affected surface

<!-- Tick everything that applies. -->

- [ ] CLI subcommand(s): `agentify login`, `agentify logout`, `agentify models ...`
- [ ] Audit / coverage gate (`src/core/audit/`)
- [ ] Orchestrator (`src/core/orchestrator/`)
- [ ] AIW (`src/core/aiw/`)
- [ ] Webhook server (`src/core/webhook/`)
- [ ] Harness export (`.claude/`, `.codex/`, `.pi/`, `.agents/` target dirs)
- [ ] Scaffold shipped to target repos (`scaffold/`)
- [ ] Public artifacts written to user repos (`AGENTS.md`, `specs/`, `ai_docs/`, feature agents, experts, workflows)
- [ ] New runtime dependency (requires maintainer approval)
- [ ] Breaking change (semver major)

## Test plan

<!-- How would you verify this end-to-end? agentify's harness is
`npm test` (typecheck + tsx unit suite + `bash tests/run.sh` contract
suite) plus `npm run test:scaffold-e2e` for the shipped scaffold. If your
feature needs new fixture coverage, say which test file would grow. -->

## Documentation impact

<!-- Which docs would change? `README.md`, `docs/lifecycle/`,
generated `AGENTS.md` in target repos, etc. -->

## Checklist

- [ ] I checked existing issues / discussions for prior art.
- [ ] This proposal does not require an undocumented new runtime dep (or, if it does, the new dep is justified in this PR).
- [ ] I am willing to drive the implementation if the maintainer agrees with the direction.