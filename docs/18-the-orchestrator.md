# The orchestrator (internal control plane)

Status: internal library code, not a public command. This document is
architecture notes for contributors. The public product surface is the
single `agentify` command ([ADR 0008](adr/0008-one-package-two-entry-modes.md))
and the GitHub scaffold loop ([the lifecycle](lifecycle/README.md)).

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
   loop.**
2. **AIW workflows** (`src/core/aiw/`) — fixed phase pipelines
   (plan → build → review → fix → ship), each phase a fresh Pi session,
   isolated in a git worktree.
3. **Orchestrator workflows** (`src/core/orchestrator/workflows/*.json`) —
   JSON DAGs composing sub-agents and AIWs.

AIW and orchestrator are internal alternatives / foundation code. See
[ADR 0013](adr/0013-webhook-server.md) for the same "parked internal
runtime" framing applied to the webhook server.

## Persistence

Orchestrator state lives under `<configDir>/orchestrator/` (session id,
per-agent `state.json` + `events.jsonl`, workflow runs, escalation
tickets), so a restarted host can resume.

## Testing

Orchestrator, AIW, webhook, and coms are exercised in tests against a
`FakeRuntime` (`tests/orchestrator/fake-runtime.ts`) or in `dryRun`
mode; they are not run against real Pi sessions in the default suite.
