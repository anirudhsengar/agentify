# The orchestrator (internal control plane)

Status: internal library code, not a public command. This document is
architecture notes for contributors. The public product surface is the
single `agentify` command ([ADR 0008](adr/0008-one-package-two-entry-modes.md))
and the GitHub scaffold loop ([the lifecycle](lifecycle/README.md)). For public
v1, ADR 0015 defines that GitHub Actions loop as the shipped orchestration
plane, while this host remains internal foundation code:
[ADR 0015](adr/0015-public-orchestration-plane.md).

## Purpose

`src/core/orchestrator/` implements a management-only agent that
delegates to specialized sub-agents, AI Developer Workflows (AIWs), and
JSON DAG "developer workflows". By design it has no `read`/`write`/
`edit`/`bash` tools — only management tools — so it cannot do work
itself; it coordinates (`orchestrator-prompt.ts`).

## Pieces

| Module | Role |
|--------|------|
| `orchestrator-prompt.ts` | The orchestrator system prompt + boot substitutions |
| `agent-manager.ts` | Spawns/among sub-agent sessions in-process |
| `subagent-registry.ts` | Discovers `.pi/agents/*.md` + user config |
| `workflow-runner.ts` | Walks JSON DAG workflows (`workflows/*.json`) |
| `workflow-registry.ts` / `workflow-spec.ts` | Workflow definitions/types |
| `aiw-bridge.ts` | Starts/polls AIWs from the orchestrator |
| `auto-improve.ts` | Runs expert self-improve after matching agent runs |
| `worker.ts` | Multi-process worker that uses coms IPC |
| `tools/` | The management tools (create/command/interrupt/list agents, run/compose/check workflow, start/check AIW, escalate, read logs) |

Domain lock is enforced by the shared defense hook (Layer E in
`src/core/audit/defense-hook.ts`): a sub-agent's `write`/`edit` calls
are constrained to its assigned glob domain.

## Three workflow systems, one shipped path

There are three notions of "workflow" in the tree; only one is the
shipped loop today:

1. **Scaffold workflows** (`scaffold/.github/workflows/*.yml`) —
   label-driven GitHub Actions running Pi. **This is the shipped async
   loop.** The implement workflows render generated `.pi/workflows/*.json`
   specs into prompt context, and implement/review workflows render generated
   `.pi/agents/*.md` specialist routing plus `.pi/prompts/experts/*`
   expert routing context. Issue implementation also runs a credential-free
   orchestration-planner prompt that emits a bounded structured route for the
   implementation agent. The trusted extractor rejects selected workflows,
   specialists, experts, or validation-focus commands that are not present in
   the generated context. These workflows do not execute orchestrator DAGs.
2. **AIW workflows** (`src/core/aiw/`) — fixed phase pipelines
   (plan → build → review → fix → ship), each phase a fresh Pi session,
   isolated in a git worktree.
3. **Orchestrator workflows** (`src/core/orchestrator/workflows/*.json`) —
   JSON DAGs composing sub-agents and AIWs.

AIW and orchestrator are internal alternatives / foundation code. Generated
project workflow specs are already discoverable by the orchestrator registry,
and the scaffold can read workflows, specialist routes, expert routes, and a
structured orchestration route as prompt guidance, but public execution still
belongs to GitHub Actions by decision, not by accident. See
[ADR 0015](adr/0015-public-orchestration-plane.md) for the public
orchestration decision and [ADR 0013](adr/0013-webhook-server.md) for the same
"parked internal runtime" framing applied to the webhook server.

## Persistence

Orchestrator state lives under `<configDir>/orchestrator/` (session id,
per-agent `state.json` + `events.jsonl`, workflow runs, escalation
tickets), so a restarted host can resume.

## Testing

Orchestrator, AIW, webhook, and coms are exercised in tests against a
`FakeRuntime` (`tests/orchestrator/fake-runtime.ts`) or in `dryRun`
mode; they are not run against real Pi sessions in the default suite.
