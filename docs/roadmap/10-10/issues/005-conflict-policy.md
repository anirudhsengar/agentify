# 005 — Conflict policy blocks false success

## Goal

Make conflicts on required files block `ready` status and prevent unsafe
exports from user-owned content.

## Evidence

- `markAuditArtifacts()` records conflicts but `runBrownfieldAudit()` still
  reports audit complete.
- `exportClaude()` copies `AGENTS.md` into `CLAUDE.md` if it exists, even
  when `AGENTS.md` is user-owned.
- `installScaffoldRuntime()` reports conflicts, but `persistProjectState()`
  can still store `repoStatus: "ready"`.

## Scope

Conflict classification and state outcomes.

## Implementation plan

1. Define required-vs-optional generated files.
2. Treat required conflicts as blocking:
   - `AGENTS.md`
   - `specs/README.md`
   - `ai_docs/README.md`
   - `SETUP.md`
   - `.github/workflows/agent-implement.yml`
   - `.github/actions/run-pi/action.yml`
   - `.github/scripts/setup-agentify.sh`
3. Prevent exporters from reading/copying user-owned conflicting source
   files into managed target files.
4. Persist `runStatus: partial` and `repoStatus: partial` when required
   conflicts exist.
5. Print an actionable conflict report.

## Acceptance criteria

- User-owned `AGENTS.md` is not copied to `CLAUDE.md` as managed output.
- User-owned critical scaffold workflows keep repo status partial.
- Optional conflicts can be skipped without blocking if documented.
- Re-running after removing conflicts succeeds.

## Validation

```bash
npm run typecheck
npm run test:unit
```
