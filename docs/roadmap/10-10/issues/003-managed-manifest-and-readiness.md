# 003 — Managed manifest and readiness model

## Goal

Introduce a manifest that records every agentify-managed file, its owner,
kind, marker, hash, and required/optional status. Use it for repo status
instead of path existence alone.

## Evidence

- `src/core/repo-status.ts` only checks for `AGENTS.md`,
  `specs/README.md`, `ai_docs/README.md`, `SETUP.md`, and
  `.github/workflows/agent-implement.yml` existence.
- `src/core/project-state.ts` persists `repoStatus` but does not know
  which generated files were actually applied.
- `artifact-exporters.ts` and `scaffold-installer.ts` already know write
  actions, so they can feed a manifest.

## Scope

Add manifest types, read/write helpers, and readiness logic. Do not yet
make bootstrap transactional; issue 004 applies the manifest transactionally.

## Proposed manifest path

`.pi/agentify/manifest.json`

## Manifest fields

- `schema_version`
- `agentify_version`
- `generated_at`
- `mode`: `brownfield | greenfield`
- `files[]`:
  - `path`
  - `kind`: `audit | harness_export | scaffold | state | prompt | skill | expert`
  - `required`: boolean
  - `marker`: markdown/hash/toml marker expected
  - `sha256`
  - `source`: renderer/scaffold/exporter name

## Implementation plan

1. Add manifest schema/types in a new core module.
2. Add hash helpers and marker verification.
3. Update `inspectAgentifyRepoState()` to read the manifest when present.
4. If no manifest exists, keep legacy detection but report `partial` when
   any required file is user-owned/unmanaged.
5. Add tests for ready, partial, missing, hash mismatch, and unmanaged
   required file.

## Acceptance criteria

- A repo is `ready` only when required files exist, carry the expected
  managed marker, and match the manifest hash or an accepted migration rule.
- Existing path-only detection is no longer enough to mark ready.
- Tests cover critical scaffold conflict readiness.

## Validation

```bash
npm run typecheck
npm run test:unit
```
