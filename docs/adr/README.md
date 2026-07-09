# Architecture Decision Records

This directory holds the architecture decision records (ADRs) for
agentify. Each ADR captures one decision: the context that forced it,
the decision itself, and the consequences we accepted.

ADRs are immutable once merged. If a decision is reversed, add a new
ADR that supersedes the old one and mark the old one `Superseded`.

## Historical note

ADRs `0001`–`0007` predate the standalone pivot. They were written
while the project was still an extension named "GreenField" and
preserve the original wording as historical records. Read them for
lineage, not for current wording. The current product is a single
standalone CLI (`agentify`); see [0008](0008-one-package-two-entry-modes.md).

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-in-process-pi-session.md) | In-process Pi session, no subprocess | Accepted |
| [0002](0002-skills-as-shipped-machinery.md) | Skills are shipped machinery | Accepted |
| [0003](0003-structured-output-only.md) | Structured output only (TypeBox map) | Accepted |
| [0004](0004-defense-in-depth-hook.md) | Defense-in-depth tool-call hook | Accepted |
| [0005](0005-agent-star-label-taxonomy.md) | `agent:*` GitHub label taxonomy | Accepted |
| [0006](0006-dual-skill-discovery.md) | Dual skill discovery (`.agents` + `.claude`) | Accepted |
| [0007](0007-pi-as-the-ci-coding-harness.md) | Pi as the CI coding harness | Accepted |
| [0008](0008-one-package-two-entry-modes.md) | One package, two entry modes | Accepted |
| [0009](0009-machinery-shipped-intelligence-generated.md) | Machinery shipped, intelligence generated | Accepted |
| [0010](0010-plan-two-layer-taxonomy.md) | Two-layer plan/spec taxonomy | Accepted |
| [0011](0011-jiti-runtime-typescript.md) | jiti runtime TypeScript, no build step | Accepted |
| [0012](0012-evolution-loop.md) | The self-refresh evolution loop | Accepted |
| [0013](0013-webhook-server.md) | Internal webhook server (parked) | Accepted |
| [0014](0014-coverage-gate-in-code.md) | Coverage gate enforced in code | Accepted |
| [0015](0015-public-orchestration-plane.md) | Public orchestration plane is GitHub Actions | Accepted |
