# ADR 0015: Public orchestration plane is GitHub Actions

Status: Accepted

## Context

agentify's vision is that a GitHub issue can trigger an orchestrator that
routes work through generated specialists, experts, and workflows until a
reviewable PR exists. The repository also contains an internal
`OrchestratorHost` that can manage sub-agents, AIWs, and JSON workflow DAGs, but
promoting that host to the public installed runtime would add persistent
process management, credential handling, queueing, cost controls, and recovery
semantics beyond the one-command bootstrap contract.

## Decision

For public v1, the shipped orchestration plane is the scaffolded GitHub Actions
loop: labels trigger trusted workflows, a credential-free orchestration planner
selects generated workflows/specialists/experts, trusted scripts validate the
route and side effects, and Pi runs only inside those bounded workflow jobs.
Generated `.pi/workflows/*.json` specs are registry-compatible and are rendered
into prompt context, but the public GitHub loop does not execute internal
`OrchestratorHost` DAGs.

The internal OrchestratorHost, AIW runtime, webhook server, and coms runtime
remain foundation code for future hosted/local orchestration, not public
commands or required runtime services.

## Consequences

- Public production hardening focuses on the scaffolded GitHub issue/PR loop,
  route validation, token isolation, release evidence, and model-backed smoke
  gates.
- Documentation must not claim that installed target repositories run the
  internal OrchestratorHost unless a future ADR supersedes this one.
- Promoting OrchestratorHost later requires a new decision covering hosting,
  authentication, persistence, concurrency, budget enforcement, recovery, and
  operator controls.
