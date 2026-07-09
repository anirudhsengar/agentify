---
name: refresh-surface
description: Keep the agentic surface current after code changes — delta re-audit the touched feature areas and re-sync the experts. Use after a significant merge, or run it in CI on every merge to the default branch.
disable-model-invocation: true
---

# Refresh surface

The audit (`/agentify`) is a snapshot; code moves. This keeps the snapshot honest so the
*next* autonomous run starts from accurate context — the comprehension half of the
evolution loop ([ADR-0012](../../../docs/adr/0012-evolution-loop.md)).

## Workflow

1. **Scope the change.** `git diff <last-refresh>..HEAD --stat` (fall back to the diff
   against the previous commit on the default branch). Map changed files to feature areas
   using `<agentify-state-dir>/agents/*.md` (each specialist's `## Scope` paths).
2. **Decide delta vs full:**
   - **Delta** (default) — the diff touches files inside known feature areas only.
     Re-explore just those areas and update their ```<agentify-state-dir>/agents`/<feature>.md`,
     the affected sections of `AGENTS.md`, and ``<agentify-state-dir>/conditional_docs.md``.
   - **Full** — the diff touches `module_graph` edges, shared state, the manifest, or
     adds/removes top-level areas. A cross-cutting change can invalidate areas the diff
     doesn't name, so run a full `/agentify` instead.
3. **Re-sync experts.** For each expert domain (``<agentify-state-dir>/prompts/experts/<domain>/`) whose
   `primary_paths` the diff touched, run that domain's `self-improve` (`USE_DIFF=true`).
   In CI, also read the workflow-provided stale-experts JSON file and treat every domain
   listed in `stale[]` as affected; it is produced before the model runs by comparing
   expert `last_updated` timestamps to the files referenced by `expertise.yaml`.
   The code is the source of truth; the YAML is a cache.
4. **Honesty gate carries over.** If a refreshed area can't be covered, mark it honestly
   (`null` / low confidence) rather than padding — same rule as the audit.
5. **Report** what changed: which feature agents updated, whether `AGENTS.md` moved, which
   experts re-synced, and whether it ran delta or full.

## Rules

- **MUST NOT** invent surface for code that isn't there; refresh reflects the code as it
  now is, including deletions (remove a feature agent whose area was deleted).
- **MUST** keep `AGENTS.md` under its 200-line cap when updating it.
- In CI, repo-file changes go through a PR like any other agent change — do not commit
  or push directly; the trusted workflow handles the git plumbing.
