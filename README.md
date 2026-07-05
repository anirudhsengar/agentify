# agentify

**One terminal command for the full life of an agentic codebase.**

`agentify` is a standalone CLI. You run it once inside a repository and
it turns that repository into an "agentic codebase": it audits the code,
generates codebase-specific agent intelligence, ships a generic skill
pack, and stamps a GitHub runtime so that — after bootstrap — issues,
comments, and PRs drive agentic work.

## Install

Requires Node `>=22.19.0`.

```bash
npm install -g agentify
# or run without installing:
npx agentify
```

On first run, agentify asks for an LLM provider and API key (or reads
one from the environment) and stores configuration under `~/.agentify/`
with `0600` permissions. Nothing is written to your repository during
auth setup.

```bash
agentify
```

For CI or scripted use, pre-seed auth via a provider environment
variable (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and run
non-interactively:

```bash
agentify --non-interactive --assume brownfield
```

See [docs/lifecycle/README.md](docs/lifecycle/README.md) for the full
walkthrough.

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

## What Gets Written

On a successful **brownfield** audit, agentify writes into your repo:

| Path | What |
|------|------|
| `AGENTS.md` | Codebase-specific agent guide (capped at 200 lines) |
| `specs/README.md`, `ai_docs/README.md` | Always-on context artifacts |
| `.pi/agents/<feature>.md` | Generated feature specialists |
| `.pi/agentify/codebase_map.json` | The validated audit map (managed) |
| `.agents/skills/`, `.claude/`, `.codex/`, `CLAUDE.md` | Harness exports |
| `SETUP.md`, `.github/workflows/*`, `.github/scripts/*` | GitHub runtime scaffold |

Generated files carry an `agentify:managed` marker. agentify never
overwrites a pre-existing user-owned file: it reports it as a conflict
and leaves it intact. Nothing is written unless the audit closes every
coverage dimension; a partial audit reports its gaps and writes no
harness export.

## After Bootstrap

1. Review the generated diff, then commit and push to your default
   branch — the GitHub loop only exists once these files are pushed.
2. Run `bash .github/scripts/setup-agentify.sh` to create the `agent:*`
   labels.
3. Set Actions secrets `PI_API_KEY` and `AGENT_PAT`, and variables
   `PI_VERSION` and `PI_MODEL` (details in the stamped `SETUP.md`).
4. Drive work through GitHub issues, comments, and PRs.

## Command Surface

```bash
agentify [--non-interactive] [--assume brownfield|greenfield] [--config-dir <dir>]
agentify --help
agentify --version
```

That is the only public CLI entrypoint. Bootstrap, attach, recovery,
and future lifecycle operations all start from `agentify` itself. The
flags above tune a single run (non-interactive/CI use, forced project
kind, alternate state dir); there are no subcommands.

## Troubleshooting

- **"Cannot prompt because stdin is not interactive"** — you ran
  agentify without a TTY and without pre-configured auth. Set a provider
  env var (e.g. `OPENAI_API_KEY`) or create `~/.agentify/auth.json`, and
  pass `--non-interactive --assume brownfield`.
- **"audit did not complete"** — the audit did not close every coverage
  dimension, so no files were exported. agentify prints the specific
  gaps and the path to a JSONL run log under `~/.agentify/logs/agentify/`.
  Inspect it with `npm run inspect-log` (from a clone) or re-run
  `agentify` to resume.
- **GitHub loop does nothing after bootstrap** — confirm you committed
  and pushed the generated files, ran `setup-agentify.sh`, set the
  `PI_API_KEY`/`AGENT_PAT` secrets, and that the issue carries both
  `agent:queued` and `agent:implement`.

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
