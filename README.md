# agentify

**One terminal command for the full life of an agentic codebase.**

`agentify` is a standalone CLI. Invoke agentify itself only from a
terminal:

```bash
agentify
```

## What It Does

agentify exposes one public entrypoint and hides the rest of the
machinery behind it.

- **Audit/comprehension:** scan an existing codebase and generate its
  agentic surface: `AGENTS.md`, `specs/README.md`, `ai_docs/README.md`,
  feature agents, experts, and harness exports.
- **Greenfield/genesis:** start from an empty or starter repo, capture
  project intent, and move one goal at a time through PRDs, plans,
  issues, and specs.
- **Internal control plane:** orchestrators, specialists, experts, and
  workflows remain implementation machinery, not separate public command
  families.
- **GitHub-first async loop:** after bootstrap, issues, comments, and
  PRs are the primary out-of-loop surface.

Generated project artifacts may still be harness-shaped (`.pi/agents`,
`.agents/skills`, `.claude/skills`, `.codex/agents`, etc.) because those
are target outputs. The agentify package itself is not a Pi extension.

## Existing Repo

Run agentify from the repository root:

```bash
agentify
```

On first run, the CLI asks for provider/auth configuration and stores it
under `~/.agentify/`. The audit writes codebase-specific intelligence to
the current repository, exports supported harness surfaces, installs the
GitHub runtime scaffold, and reports GitHub readiness plus next-step
setup guidance. Later runs attach to an initialized repo, report last
run status and the latest log path, and recover incomplete setup when
needed. User-owned files are reported as conflicts and left intact.

## New Repo

Run `agentify` in an empty or starter repo. The CLI starts a local-first
greenfield session, writes checkpointed planning artifacts, installs the
GitHub runtime scaffold, reports readiness, and proceeds one selected
goal/sub-goal at a time through the same build chain. Subsequent runs
attach to that initialized state instead of acting like a separate tool
family.

## Command Surface

```bash
agentify
```

That is the only public CLI entrypoint. Bootstrap, attach, recovery,
and future lifecycle operations all start from `agentify` itself.

Webhook, AIW, orchestrator, and expert modules may still exist
internally, but they are not part of the public product surface.

The shipped skill pack lives in `.agents/skills/` and is mirrored to
`.claude/skills/` for harnesses that support skills. Those skills are
generic machinery; the audit generates only codebase-specific
intelligence.

## Repository Layout

```
agentify/
├── bin/agentify.js                 # public CLI entrypoint
├── src/cli.ts                      # single public CLI entrypoint
├── src/core/agentify-app.ts        # public application seam behind `agentify`
├── src/core/audit/                 # audit prompts, schema, custom tools, defense hook
├── src/core/orchestrator/          # internal control-plane runtime
├── src/core/aiw/                   # internal workflow runtime
├── src/core/webhook/               # internal trigger/runtime adapter
├── .agents/skills/                 # shipped skill pack
├── .claude/skills/                 # Claude Code mirror
├── scaffold/                       # stampable CI runtime
└── docs/                           # architecture docs and ADRs
```

## Development

```bash
npm run typecheck
npm test
bash tests/run.sh
```

Useful docs:

- [docs/lifecycle/README.md](docs/lifecycle/README.md) — the public
  lifecycle: bootstrap, GitHub inbox, PR, refresh.
- [docs/01-orientation.md](docs/01-orientation.md)
- [docs/13-repository-layout.md](docs/13-repository-layout.md)
- [docs/14-development-guide.md](docs/14-development-guide.md)
- [docs/18-the-orchestrator.md](docs/18-the-orchestrator.md) — internal
  architecture notes for the control plane.
- [docs/adr/](docs/adr/)
