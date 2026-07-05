# 011 — Greenfield session controller

## Goal

Make greenfield mode a real checkpointed terminal formation flow instead
of a single one-shot prompt.

## Evidence

- `runGreenfield()` in `src/core/run-agentify.ts` calls
  `runtime.runGreenfield()` once.
- `PiSdkRuntime.runGreenfield()` prompts the model to ask the user what
  they are building, but the CLI does not manage a multi-turn formation
  loop.
- README promises greenfield checkpointed planning artifacts.

## Scope

Greenfield lifecycle only.

## Implementation plan

1. Define a greenfield state file under `~/.agentify/projects` or
   `.pi/agentify/greenfield-state.json`.
2. Add explicit checkpoints:
   - wide idea,
   - goals,
   - selected goal,
   - PRD,
   - plan,
   - issue slices,
   - spec.
3. Make the CLI loop over user input until a checkpoint stop.
4. Reuse shipped skills, but have the app own persistence and status.
5. Add non-interactive behavior: fail clearly unless a goal/spec seed is
   provided.

## Acceptance criteria

- Empty repo run can produce `GOALS.md` and stop at a clear checkpoint.
- Re-running attaches to the greenfield state and offers next actions.
- No scaffold-ready status is reported unless required greenfield signals
  and scaffold files are present and managed.

## Validation

```bash
npm run typecheck
npm run test:unit
```
