---
description: Write an agentify build spec for bug work in this repository.
argument-hint: "<one-sentence bug task>"
---
<!-- agentify:managed -->

# Bug

## Goal

Write a build spec for $ARGUMENTS to `specs/bug-<slug>.md`.
The implementer will run `/implement <spec-path>` after the spec is reviewed.

## Workflow

1. Read `specs/README.md` for this repository's spec conventions.
2. Read `.pi/agentify/conditional_docs.md` and load matching docs when present.
3. Read `AGENTS.md` for current build, test, and ownership guidance.
4. Inspect the relevant files before naming implementation steps.
5. Write the spec with `## Relevant Files`, `## Steps`, and `## Validation Commands`.

## Validation Surface

- Test: npm test
- Lint: not configured
- Typecheck: npm run typecheck
- E2E: not configured

## Validation By Change Type

- chore: `npm run typecheck`, `npm run test:unit`, `npm run test:maintenance`
- bug: `npm run typecheck`, `npm run test:unit`
- feature: `npm run typecheck`, `npm run test:all`, `npm run test:parity`, `npm run test:package`, `npm run test:generated-output`, `npm run test:maintenance`
- refactor: `npm run typecheck`, `npm run test:unit`, `npm run test:maintenance`
- security: `npm run typecheck`, `npm run test:security-redteam`, `npm audit --omit=dev --audit-level=high`

## Instructions

- MUST end with runnable validation commands.
- MUST cite concrete repository paths in Relevant Files.
- MUST NOT write product code from this prompt.
