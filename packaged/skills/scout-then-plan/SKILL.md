---
name: scout-then-plan
description: Discover the task's relevant feature specialists, recon them in parallel, synthesize the findings, then write a build spec with that enriched context. Use for a task that spans or touches an unfamiliar feature.
disable-model-invocation: true
tier: opt-in

---

# Scout-then-plan

Enrich a `/spec` with feature-specialist recon first. **Dynamic** — it discovers the
specialists at run time from `<agentify-state-dir>/agents/*.md`, so adding a new `/<feature>` later
extends this chain automatically. Never hard-code the feature list.

## Workflow

1. Read `AGENTS.md` and ``<agentify-state-dir>/conditional_docs.md`` (if present) for context.
2. **Discover specialists.** List `<agentify-state-dir>/agents/*.md`; read each one's frontmatter `name` +
   `description`. Skip the cross-cutting primitives (`scout`, `review`, `test`, `fix`,
   `document`, `implement`) — they aren't feature scouts.
3. **Pick relevant scouts.** Match the task against each specialist's `description`. If
   one or more match, invoke them in parallel (each as a subagent) with the task as the
   question. If none match, skip this step.
4. **Synthesize.** Combine the scouts' findings into one brief: what files the change
   touches, what types are involved, what conventions to follow, what pitfalls to avoid,
   what conditional docs to load.
5. **Spec with context.** Run `/spec $ARGUMENTS`; the spec writer uses the synthesized
   brief plus `specs/README.md` to write `specs/<class>-<slug>.md`. Report the spec path.
