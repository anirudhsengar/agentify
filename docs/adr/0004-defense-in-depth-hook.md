# ADR 0004: Defense-in-depth tool-call hook

Status: Accepted

## Context

The builder runs with `bash`, `write`, and `edit` tools against the
user's own repository. A context-decayed or prompt-injected agent
could run destructive commands, read secrets, or write outside the
repo.

## Decision

Every agentify-managed Pi session installs a tool-call hook
(`src/core/audit/defense-hook.ts`) that applies, in layers:

1. Compound-operator rejection for `bash` (`&&`, `|`, `$()`, `>`…).
2. A command blacklist (`src/core/audit/defense/blacklist.ts`):
   recursive deletes, force push, network exfil, privilege escalation,
   interpreter one-liners, and more.
3. A script-content scanner that re-scans files passed to interpreters.
4. Zero-access path guard on `read`/`write`/`edit` covering secrets,
   `~/.ssh`, `/etc`, and the agentify config dir.
5. A repository jail: `write`/`edit` targets must resolve inside the
   working directory (via `realpath`), blocking traversal and symlink
   escape.
6. Domain lock for orchestrator sub-agents.

The hook fires for the builder, greenfield, and explorer sub-agent
sessions.

## Consequences

- The blacklist is a floor, not a sandbox; it is defense-in-depth, not
  a security boundary against a fully adversarial model.
- The hook is active whenever an agentify session is marked active
  (`src/core/audit/state.ts`).
