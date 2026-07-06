# The agentify lifecycle

This is the public lifecycle: what happens from the moment you run
`agentify` in a repository to the point where the repository improves
itself through GitHub.

## 0. Install and authenticate

```bash
npm install -g agentify   # or: npx agentify
```

Requires Node `>=22.19.0`. On first run, agentify asks for an LLM
provider and API key (or reads one from the environment) and stores
config under `~/.agentify/` with `0600` permissions. Nothing is written
to your repository yet.

## 1. Bootstrap (one command, once)

```bash
agentify
```

agentify classifies the repository:

- **Existing code (brownfield):** it runs an in-process Pi audit,
  fills a structured codebase map, and — only when every coverage
  dimension is closed — emits the agentic surface: `AGENTS.md`,
  `specs/README.md`, `ai_docs/README.md`, feature agents under
  `.pi/agents/`, specialist workflow specs under `.pi/workflows/`,
  expert directories, feedback-loop storage, repo-specific `.pi/skills/`
  candidates, and the harness exports you selected. The GitHub implement
  and review scaffold summarizes `.pi/agents` into specialist routing
  guidance, summarizes `.pi/prompts/experts` into expert routing guidance,
  and implement also summarizes `.pi/workflows` into workflow routing
  guidance. It then stamps the GitHub Actions scaffold and reports GitHub
  readiness.
- **Empty/starter (greenfield):** it starts a local-first formation
  chat that moves one goal at a time through PRDs, plans, issues, and
  specs. The model submits typed formation data through
  `write_greenfield_artifacts`; agentify renders the planning markdown
  deterministically. The payload's `stop_at` field is a hard checkpoint
  gate: first formation normally stops at `goals`, and artifacts beyond
  the user-approved milestone are rejected. agentify records
  `.pi/agentify/greenfield-state.json` with the current checkpoint, next
  actions, exact artifact paths, local/GitHub resume instructions, and
  artifact validation result, then stamps the same scaffold only after the
  planning artifacts pass the substance gate.

If a previous run left the repo half-initialized, agentify detects that
and recovers. If the repo is already fully initialized, agentify
attaches and reports status instead of re-running.

## 2. Review and commit the generated files

agentify writes into your working tree. Review the diff, then commit
and push. The GitHub loop only exists once the scaffold and generated
surface are pushed to the default branch.

```bash
git add -A && git commit -m "Bootstrap agentify" && git push
```

## 3. Configure GitHub

Read the stamped `SETUP.md`, then:

```bash
bash .github/scripts/setup-agentify.sh   # creates the agent:* labels
```

Set the GitHub Actions **secret** `PI_API_KEY` and `AGENT_PAT`, and the
**variables** `PI_VERSION`, `PI_MODEL` (plus optional `PI_PROVIDER`,
`PI_THINKING`, and `AGENT_BOT_LOGIN` for drill). See
[ADR 0007](../adr/0007-pi-as-the-ci-coding-harness.md).

## 4. Work through GitHub

The `agent:*` label taxonomy ([ADR 0005](../adr/0005-agent-star-label-taxonomy.md))
drives the loop:

1. Open an issue (or let the drill workflow triage a new one).
2. Once the issue is a ready slice it carries `agent:queued` and a
   `## Blocked by` section. Use `None - can start immediately.` when it is
   unblocked, or concrete `#123` issue references when earlier work must close
   first.
3. Adding `agent:implement` triggers the implement workflow: it
   refuses open blockers, branches, renders generated workflow/specialist/expert
   routing context, runs a credential-free orchestration planner to select the
   starting route, runs Pi to implement, commits, and opens a draft PR labeled
   `agent:review`.
4. The review workflow reviews the PR and either approves
   (`agent:approved`) or requests changes (re-queues implement).
5. A human merges approved PRs.

> Creating an issue is not by itself a go signal. A label — applied by
> a human or by the drill pipeline after approval — starts implementation.
> This keeps write-capable automation gated.

For greenfield repositories, the drill workflow also renders
`.pi/agentify/greenfield-state.json` into the prompt as resume context. The
agent sees the local checkpoint, current focus, artifact paths, and local/GitHub
continuation instructions before making its one transition. The model run reads
captured issue JSON from the workflow, not live GitHub credentials. When a
transition needs child, PRD, or implementation issues, the model returns
structured issue requests and the trusted workflow creates or reuses those
issues with `agent:drill-me`, `artifact:prd`, or `agent:queued` labels.

## 5. Self-refresh

On every push to the default branch, `agent-refresh-surface.yml` runs a
delta re-audit and opens a PR when the generated surface drifts
([ADR 0012](../adr/0012-evolution-loop.md)). The repository keeps its
agentic surface current without another terminal invocation.

## What can fail, and where

| Stage | Failure | Where it surfaces |
|-------|---------|-------------------|
| Auth | No key / no TTY | CLI error naming the env vars |
| Audit | Coverage gaps remain | `partial` status, no export, log path printed |
| Greenfield | Missing structured formation output, `stop_at` overrun, or placeholder/thin artifacts | `partial` status, checkpoint state with validation/resume context, no scaffold |
| Commit | Files not pushed | GitHub loop inert until pushed |
| Setup | Missing secrets/labels | `setup-agentify.sh` / workflow preflight |
| Implement | Preconditions unmet | Issue comment + `agent:blocked` |

Internal runtimes (webhook, AIW, orchestrator, coms) are library code,
not part of this public lifecycle; see
[docs/15-the-webhook-server.md](../15-the-webhook-server.md) and
[docs/18-the-orchestrator.md](../18-the-orchestrator.md).
