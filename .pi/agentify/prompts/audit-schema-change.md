---
description: audit-schema-change-specific refactor template. Use for recurring refactor work in the audit-schema-change area.
argument-hint: "<one-sentence refactor task in audit-schema-change>"
---
<!-- agentify:managed -->

# Audit Schema Change (refactor)

## Goal

Write a build spec for $ARGUMENTS using `.pi/agentify/prompts/refactor.md` as the base format, enriched with audit-schema-change context.

## Area Context

- Source feature agent: `.pi/agentify/agents/audit-pipeline.md`
- Rationale: Schema structure, ordering, ownership, and golden compatibility form a specialized recurring workflow.
- Trigger phrases:
  - When changing CodebaseMap or audit schema contracts
  - When moving schema ownership across domain files

## Workflow

1. Read `.pi/agentify/prompts/refactor.md` for the base spec flow.
2. Read `.pi/agentify/agents/audit-pipeline.md` for local conventions, key files, and pitfalls.
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
