---
description: state-migration-specific feature template. Use for recurring feature work in the state-migration area.
argument-hint: "<one-sentence feature task in state-migration>"
---
<!-- agentify:managed -->

# State Migration (feature)

## Goal

Write a build spec for $ARGUMENTS using `.pi/agentify/prompts/feature.md` as the base format, enriched with state-migration context.

## Area Context

- Source feature agent: `.pi/agentify/agents/state-lifecycle.md`
- Rationale: State changes require transaction, rollback, symlink, fingerprint, and legacy compatibility checks.
- Trigger phrases:
  - When changing provider-scoped state selection or migration
  - When changing crash recovery or transaction semantics

## Workflow

1. Read `.pi/agentify/prompts/feature.md` for the base spec flow.
2. Read `.pi/agentify/agents/state-lifecycle.md` for local conventions, key files, and pitfalls.
3. Read `AGENTS.md` and `.pi/agentify/conditional_docs.md`.
4. Inspect relevant files before naming implementation steps.
5. Write the spec to `specs/<type>-<slug>.md` with area-specific risks and validation.

## Validation Surface

- Test: npm test
- Lint: not configured
- Typecheck: npm run typecheck
- E2E: not configured

## Instructions

- MUST include area-specific files, conventions, and pitfalls when they affect the task.
- MUST NOT invent files or commands.
- MUST NOT write product code from this prompt.
