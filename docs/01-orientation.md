# Orientation

New to the codebase? Read this first, then
[docs/13-repository-layout.md](13-repository-layout.md).

## What agentify is

agentify is a standalone CLI. You run `agentify` once inside a
repository and it turns that repository into an "agentic codebase": it
audits the code, generates codebase-specific agent intelligence
(`AGENTS.md`, feature agents, project workflow specs, expert directories,
specs, ai_docs, feedback-loop storage, and repo-specific skill candidates),
ships a generic skill pack, and stamps a GitHub Actions runtime so that, after
bootstrap, issues/comments/PRs drive agentic work. Pi
(`@earendil-works/pi-coding-agent`) is the agent harness.

See [ADR 0008](adr/0008-one-package-two-entry-modes.md) for why there
is exactly one public command.

## The three things it produces

1. **Codebase-specific intelligence** — generated per repo from a
   validated codebase map ([ADR 0003](adr/0003-structured-output-only.md),
   [ADR 0009](adr/0009-machinery-shipped-intelligence-generated.md)).
2. **A shipped skill pack** — the generic build chain under
   `.agents/skills/` ([ADR 0002](adr/0002-skills-as-shipped-machinery.md)).
3. **A GitHub runtime scaffold** — stamped into the target repo
   ([ADR 0007](adr/0007-pi-as-the-ci-coding-harness.md)).

## The read path through the code

```
bin/agentify.js            jiti-loads src/cli.ts (ADR 0011)
  └─ src/cli.ts            CLI: flags, ConsoleUi, PiSdkRuntime
     └─ src/core/agentify-app.ts   attach / recover / bootstrap
        └─ src/core/run-agentify.ts   the bootstrap orchestration
           ├─ agentify-config.ts / provider-auth.ts   auth
           ├─ project-classifier.ts   brownfield vs greenfield
           ├─ pi-sdk-runtime.ts   in-process Pi session (ADR 0001)
           │   └─ audit/defense-hook.ts   the safety hook (ADR 0004)
           ├─ audit/write-map-tool.ts + audit/schema.ts   the map
           ├─ audit/spawn-explorer-tool.ts   sub-agents
           ├─ artifact-exporters.ts   harness exports
           ├─ greenfield-artifacts.ts   typed formation renderer/tool
           ├─ scaffold-installer.ts   stamp scaffold/
           └─ github-readiness.ts   next-step guidance
```

## Where to go next

- Lifecycle end to end: [docs/lifecycle/README.md](lifecycle/README.md)
- Layout: [docs/13-repository-layout.md](13-repository-layout.md)
- Contributing/running: [docs/14-development-guide.md](14-development-guide.md)
- Internal control plane: [docs/18-the-orchestrator.md](18-the-orchestrator.md)
- Decisions: [docs/adr/](adr/)
