# Repository layout

```
agentify/
├── bin/agentify.js              Public CLI entrypoint (jiti-loads src/cli.ts)
├── src/
│   ├── cli.ts                   Single public CLI entrypoint + ConsoleUi
│   └── core/
│       ├── agentify-app.ts      Public app seam: attach / recover / bootstrap
│       ├── run-agentify.ts      Bootstrap orchestration (brownfield + greenfield)
│       ├── agentify-config.ts   Config + auth under ~/.agentify (0600)
│       ├── provider-auth.ts     Provider list + env-key resolution
│       ├── pi-sdk-runtime.ts    In-process Pi session (createAgentSession)
│       ├── project-classifier.ts  brownfield / greenfield / ambiguous
│       ├── artifact-exporters.ts  Codex / Claude / Pi harness exports
│       ├── greenfield-artifacts.ts  Typed greenfield formation renderer + tool
│       ├── scaffold-installer.ts  Stamp scaffold/ into the target repo
│       ├── repo-status.ts       Detect initialized / partial / uninitialized
│       ├── project-state.ts     Per-repo run metadata (~/.agentify/projects)
│       ├── github-readiness.ts  git + remote + gh checks and guidance
│       ├── types.ts             Shared types + AgentRuntime interface
│       ├── agent-expert.ts      Expert prompt driver (post-bootstrap)
│       ├── audit/               Audit machinery
│       │   ├── prompts/builder.md       The builder system prompt
│       │   ├── prompts/explorers/*.md   Sub-agent (explorer) prompts
│       │   ├── schema.ts                The codebase map schema (single source)
│       │   ├── write-map-tool.ts        write_map / write_map_delta tools
│       │   ├── spawn-explorer-tool.ts   spawn_explorer sub-agent tool
│       │   ├── defense-hook.ts          Tool-call safety hook (ADR 0004)
│       │   ├── defense/                 Blacklist + path policy
│       │   ├── state.ts                 Per-session active/thinking flags
│       │   ├── log.ts                   JSONL run log (redacted)
│       │   └── scripts/*.mjs            Eval/inspection tooling
│       ├── orchestrator/        Internal control plane (library code)
│       ├── aiw/                 Internal async workflow runtime (library code)
│       ├── webhook/             Internal trigger runtime (library code; ADR 0013)
│       └── coms/                Internal agent IPC (library code)
├── .agents/skills/             Shipped skill pack (single source of truth)
├── .claude/skills/             Mirror of .agents/skills (symlinks; ADR 0006)
├── scaffold/                   Stampable GitHub Actions runtime
│   └── .github/                workflows, actions, scripts, agent-prompts
├── docs/                       This documentation tree + ADRs
├── tests/                      agentify's own unit + contract tests
└── .agentify/webhooks.example.json   Example webhook trigger config
```

## Ownership boundaries

- `src/core/audit/schema.ts` is the **only** file that defines the
  codebase-map TypeBox schema.
- Defense/gating policy lives under `src/core/audit/defense/` and
  `src/core/audit/defense-hook.ts`.
- Orchestrator state and prompts live under `src/core/orchestrator/`.
- The scaffold stamped into a *target* repo lives under `scaffold/`;
  agentify's own tests live under `tests/`. They are distinct.

## Shipped vs generated

Shipped machinery (same for every repo): `.agents/skills/`, `scaffold/`.
Generated intelligence (per repo, from the audit): `AGENTS.md`,
`specs/README.md`, `ai_docs/README.md`, `.pi/agents/*.md`,
`.pi/workflows/*.json`, expert directories, feedback-loop storage, and
repo-specific `.pi/skills/`. The stamped GitHub implement/review workflows
render `.pi/agents/*.md` specialist routing and `.pi/prompts/experts/*`
expert routing into prompt context, and implement also renders
`.pi/workflows/*.json`, so the public issue/PR loop can use the generated
specialist, expert, and workflow guidance even before the internal orchestrator
is the hosted runtime.
See [ADR 0009](adr/0009-machinery-shipped-intelligence-generated.md).
