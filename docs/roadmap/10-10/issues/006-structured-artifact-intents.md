# 006 — Structured artifact intents

## Goal

Stop relying on free-form builder prose for generated files. Have the LLM
produce typed artifact intents that deterministic renderers can consume.

## Evidence

- `builder.md` instructs the LLM to write many user-facing files directly.
- `src/core/audit/schema.ts` validates the codebase map, but not feature
  reports, experts, prompts, extensions, or feedback-loop state.
- ADR 0003 says downstream artifacts are grounded in the map, but explorer
  reports are prose today.

## Scope

Add schemas and tools; do not render everything yet. Rendering is issue 007.

## Implementation plan

1. Add TypeBox schemas for:
   - feature agent intent,
   - always-on docs intent,
   - prompt template intent,
   - expert intent,
   - extension/skill candidate intent,
   - scaffold/runtime intent metadata.
2. Add custom tools like `write_artifact_intents` or extend `write_map` with
   a top-level `artifact_intents` section.
3. Update builder prompt to emit intents, not files, for phases 4–10.
4. Validate names and paths at schema level:
   - kebab-case names,
   - repo-relative safe paths,
   - no `..`, absolute paths, or path separators in names.
5. Add tests for valid/invalid intents.

## Acceptance criteria

- The builder can complete an audit with a valid map plus valid artifact
  intents without writing user-facing files itself.
- Invalid names/paths are rejected before rendering.
- Existing fixture map tests still pass.

## Validation

```bash
npm run typecheck
npm run test:unit
```
