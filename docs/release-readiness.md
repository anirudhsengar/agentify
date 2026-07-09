# Release Readiness

agentify ships only when the release stage's gate passes and the remaining
risks are explicit.

## Private Dogfood

Allowed audience: maintainers and trusted internal repos.

Required gate:

```bash
npm run typecheck
npm run test:generated-output
npm run test:security-redteam
```

Acceptable risks: GitHub workflow simulation may still be synthetic, and package
docs may change quickly.

## External Beta

Allowed audience: selected external repos with direct maintainer support.

Required gate:

```bash
npm test
npm run test:scaffold-e2e
npm pack --dry-run
```

For a staged repository with Actions configured, also run:

```bash
bash .github/scripts/smoke-github-runtime.sh --evidence-file docs/release/smoke-implement-preflight.json
bash .github/scripts/smoke-drill-github-runtime.sh --evidence-file docs/release/smoke-drill-preflight.json
bash .github/scripts/smoke-retry-github-runtime.sh --evidence-file docs/release/smoke-retry.json
bash .github/scripts/smoke-model-github-runtime.sh --confirm-model-run --evidence-file docs/release/smoke-model-implement.json
bash .github/scripts/smoke-review-github-runtime.sh --confirm-model-run --pr <number> --evidence-file docs/release/smoke-review.json
bash .github/scripts/smoke-refresh-github-runtime.sh --confirm-model-run --evidence-file docs/release/smoke-refresh.json
```

Release notes must call out known limitations, conflict recovery steps, and any
manual setup required for GitHub secrets or variables. Record command results,
issue/PR links, workflow links, and model/provider details in
[release-evidence.md](release-evidence.md) or in a dated copy of that template.
Prefer the `--evidence-file` output from each smoke command over manually copied
console text. Verify the three no-model smoke files with
`npm run verify:smoke-evidence -- --profile no-llm <files>`. Verify the full
six-gate set with `npm run verify:smoke-evidence -- <files>`.
When expert dogfood transcripts exist, score them with
`npm run score:expert-outcomes -- <manifest>`. For public release candidates,
run
`npm run qualify:release-evidence -- --repo <owner/name> --commit <sha> --since <iso> --expert <manifest> --smoke <file>...`
so fresh smoke evidence and pinned plan/review/refresh expert outcome evidence
from the staged repository and candidate commit pass together.

## Public Npm Release

Allowed audience: public npm users.

Required gate:

```bash
npm run release:check
```

Before publishing:

- Confirm `CHANGELOG.md` has a dated entry with user-visible changes.
- Confirm `README.md`, `docs/lifecycle/README.md`, and stamped `SETUP.md` links resolve.
- Confirm generated artifact snapshots are stable.
- Confirm scaffold workflow simulation passes with fake `pi` and fake `gh`.
- Confirm the stamped no-LLM GitHub smoke script passes in a staged repository.
- Confirm the stamped drill no-LLM GitHub smoke script passes in a staged repository.
- Confirm the stamped retry GitHub smoke script passes in a staged repository.
- Confirm no-LLM smoke evidence includes repository-matching issue URLs and
  workflow run URLs for implement preflight, drill preflight, and retry command.
- Confirm the stamped model-backed GitHub smoke script reaches a draft PR in a staged repository.
- Confirm the stamped model-backed review smoke script reaches approval or implementation requeue in a staged repository.
- Confirm the stamped model-backed refresh smoke script completes successfully in a staged repository.
- Confirm model-backed smoke evidence includes repository-matching workflow run
  URLs for implementation, review, and refresh gates.
- Confirm the release evidence ledger records local gates, staged GitHub smoke links, model/provider details, and expert outcome transcript scores pinned to the staged repository, candidate commit, and evidence window.
- Confirm `npm run qualify:release-evidence -- --repo <owner/name> --commit <sha> --since <iso> --expert <manifest> --smoke <file>...` passes for the staged repository evidence.
- Confirm security red-team coverage includes env dump, secret-file read, network exfil, destructive git, and interpreter one-liners.

Public release may not proceed with known blockers in transactional apply,
required-file readiness, or CI token isolation.
