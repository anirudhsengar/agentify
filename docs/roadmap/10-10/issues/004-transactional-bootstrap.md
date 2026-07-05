# 004 — Transactional bootstrap apply

## Goal

Ensure failed or partial audits do not leave user-facing generated files in
the working tree.

## Evidence

- `runBrownfieldAudit()` currently calls the Pi builder with `write` and
  `edit` before final coverage is known.
- `readFinalAuditState()` runs after the session, so it cannot prevent
  early writes.
- README promises no files are written unless coverage closes.

## Scope

Brownfield audit first. Greenfield can follow after the same staging
primitive exists.

## Implementation plan

1. Define staging directory: `.pi/agentify/staging/<run-id>/` or a temp dir
   outside the repo with a project-local manifest preview.
2. Restrict builder user-facing writes. Preferred path: builder writes only
   the map and artifact intents; until issue 006 lands, redirect generated
   writes into staging through a controlled custom tool.
3. Validate final map and staged files.
4. Apply files atomically:
   - create parent dirs,
   - refuse conflicts,
   - write managed files,
   - write manifest last.
5. On failure, remove staging and leave prior managed files untouched.

## Acceptance criteria

- If no valid map exists, no new `AGENTS.md`, `specs/README.md`,
  `ai_docs/README.md`, scaffold, or harness export remains.
- A previously ready repo is not destroyed by a failed rerun.
- The run log names the staging path and cleanup result.
- Tests from issue 001 pass.

## Validation

```bash
npm run typecheck
npm run test:unit
bash tests/run.sh
```
