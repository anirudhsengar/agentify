---
name: spec
description: Write a build spec — a single implementable contract for one slice of work — to specs/<type>-<slug>.md using the project's Spec Format. Use when you have one well-scoped task ready to implement.
disable-model-invocation: true
---

# Spec

Turn one well-scoped task into a **build spec**: the implementation contract a fresh
`/implement` session reads to do the work. A spec is one slice (one tracer bullet), not a
release plan — the release plan (`/to-plan` → `docs/plans/`) orders many slices; a spec is
one of them ([ADR-0010](../../../docs/adr/0010-plan-two-layer-taxonomy.md)).

The session that writes the spec and the session that implements it are different — that
separation is the point. The spec carries all the context the implementer needs.

## Workflow

1. Read `specs/README.md` for the Spec Format (the section set for this change type).
2. Read ``<agentify-state-dir>/conditional_docs.md`` (if present) and load any feature docs whose conditions
   match the task. Read `AGENTS.md` for project context; read `CONTEXT.md` for domain
   language. If a `/<feature>` specialist owns the area, lift its types/conventions/pitfalls.
3. Explore the codebase to identify the **Relevant Files**, existing patterns, and the
   seams the implementer will test at (existing seams preferred, highest seam possible).
4. `think hard` about the structure, then write the spec to `specs/<type>-<slug>.md`.

## Spec Format (sections by change type)

Pick the change type (`chore`, `bug`, `feature`, `refactor`, `security`, `docs`, `test`,
`perf`, `chore_deps`); `specs/README.md` lists the sections each requires. Universal
rules:

- **MUST** end with `## Validation Commands` — runnable shell commands that prove "done".
- **MUST** include `## Relevant Files` with concrete paths and `## Steps` (atomic,
  ordered, testable).
- **MUST NOT** invent files or commands; leave a field empty if unknown.
- **MUST NOT** write the implementation in the spec — the spec is a contract; `/implement`
  writes the code.

## Report

Report the spec path, the change type, the step count, and the validation commands. The natural
next step is `/implement <spec-path>` (or a `/plan-build*` chain).
