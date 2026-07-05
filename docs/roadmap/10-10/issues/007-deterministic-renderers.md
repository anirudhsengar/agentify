# 007 — Deterministic artifact renderers

## Goal

Render `AGENTS.md`, always-on docs, feature agents, prompts, experts,
extensions, and feedback-loop state in TypeScript from validated artifact
intents.

## Evidence

- `src/core/artifact-exporters.ts` handles harness exports but not the
  primary generated intelligence.
- The 200-line `AGENTS.md` cap is checked only after the builder writes it.
- Generated `.pi/extensions/*.ts` from `builder.md` are not typechecked.

## Scope

Renderer modules and validation. Do not change GitHub workflows except as
needed for generated scaffold metadata.

## Implementation plan

1. Create `src/core/artifacts/` with one renderer per artifact family.
2. Render into staging only; issue 004 applies the bundle.
3. Enforce:
   - `AGENTS.md` <= 200 lines before apply,
   - managed marker insertion,
   - frontmatter validity,
   - path/name safety,
   - extension syntax/typecheck where possible.
4. Add golden tests for fixture artifact intents.
5. Update `exportAgenticSurface()` to consume rendered feature agents only
   after they are validated and managed.

## Acceptance criteria

- No user-facing file is composed directly by the LLM.
- Golden snapshots cover at least `AGENTS.md`, one feature agent, one
  prompt template, and one expert domain.
- Renderer output is stable across repeated runs with the same inputs.

## Validation

```bash
npm run typecheck
npm run test:unit
```
