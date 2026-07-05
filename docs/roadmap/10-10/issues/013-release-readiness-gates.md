# 013 — Release readiness gates

## Goal

Create explicit gates for private dogfood, external beta, and public npm
release so the project does not ship on unit tests alone.

## Evidence

- `prepublishOnly` runs `typecheck` and `npm test`.
- There is no release checklist for fixture audits, generated-output
  quality, GitHub workflow simulation, security red-team, or package docs.

## Scope

Release docs, scripts, and CI gates.

## Implementation plan

1. Add `docs/release-readiness.md` with three stages:
   - private dogfood,
   - external beta,
   - public release.
2. Add scripts as the suites become available:
   - `test:fixtures`,
   - `test:generated-output`,
   - `test:scaffold-e2e`,
   - `test:security-redteam`,
   - `release:check`.
3. Update `prepublishOnly` only when the suites are stable enough for
   every publish.
4. Add CHANGELOG/release note requirements.

## Acceptance criteria

- The repo has a clear "you may publish only if..." checklist.
- CI can run the public-release gate, even if some expensive suites are
  manual initially.
- The checklist names exactly which risks remain acceptable for alpha/beta.

## Validation

```bash
npm run typecheck
npm test
npm pack --dry-run
```
