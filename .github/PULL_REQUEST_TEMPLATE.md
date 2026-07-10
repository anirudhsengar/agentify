## Summary

<!-- One paragraph: what does this PR do and why? -->

## Linked issues

<!-- `Closes #123`, `Fixes #456`, or `Refs anirudhsengar/agentify#789`. Use
`Closes` only when the merge fully resolves the issue. -->

## Type of change

<!-- Tick one. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (fix or feature that would cause existing usage to fail)
- [ ] Documentation only
- [ ] Refactor (no behavior change)
- [ ] CI / tooling

## Test evidence

<!-- agentify's CI runs `npm test` which is `npm run typecheck && npm run test:unit && bash tests/run.sh`.
For scaffold changes, also run `npm run test:scaffold-e2e`.
For security-relevant changes, also run `npm run test:security-redteam`. -->

- [ ] `npm run typecheck` passes
- [ ] `npm run test:unit` passes
- [ ] `bash tests/run.sh` passes
- [ ] `npm run test:scaffold-e2e` passes (if `scaffold/` touched)
- [ ] `npm run test:security-redteam` passes (if defense hook / webhook touched)

## Docs and changelog

- [ ] `CHANGELOG.md` `[Unreleased]` updated (Added / Changed / Fixed / Removed)
- [ ] `README.md` updated if user-facing behavior changed
- [ ] Generated `AGENTS.md` regeneration rules unchanged (otherwise note in PR body — the 200-line cap is hard)

## Release impact

- [ ] No release impact (docs, tests, internal refactor)
- [ ] Patch bump
- [ ] Minor bump
- [ ] Major bump (breaking)

<!-- If `prepublishOnly` (typecheck + test) should now pass on this branch,
state the local evidence: e.g. "ran `npm run release:check` locally, all
green." -->