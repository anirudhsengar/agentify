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
  `.pi/agents/`, experts, and the harness exports you selected. It then
  stamps the GitHub Actions scaffold and reports GitHub readiness.
- **Empty/starter (greenfield):** it starts a local-first formation
  chat that moves one goal at a time through PRDs, plans, issues, and
  specs, then stamps the same scaffold.

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
2. Once the issue is a ready slice it carries `agent:queued`.
3. Adding `agent:implement` triggers the implement workflow: it
   branches, runs Pi, commits, and opens a draft PR labeled
   `agent:review`.
4. The review workflow reviews the PR and either approves
   (`agent:approved`) or requests changes (re-queues implement).
5. A human merges approved PRs.

> Creating an issue is not by itself a go signal. A label — applied by
> a human or by the drill pipeline after approval — starts implementation.
> This keeps write-capable automation gated.

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
| Commit | Files not pushed | GitHub loop inert until pushed |
| Setup | Missing secrets/labels | `setup-agentify.sh` / workflow preflight |
| Implement | Preconditions unmet | Issue comment + `agent:blocked` |

Internal runtimes (webhook, AIW, orchestrator, coms) are library code,
not part of this public lifecycle; see
[docs/15-the-webhook-server.md](../15-the-webhook-server.md) and
[docs/18-the-orchestrator.md](../18-the-orchestrator.md).
