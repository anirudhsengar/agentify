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

Release notes must call out known limitations, conflict recovery steps, and any
manual setup required for GitHub secrets or variables.

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
- Confirm security red-team coverage includes env dump, secret-file read, network exfil, destructive git, and interpreter one-liners.

Public release may not proceed with known blockers in transactional apply,
required-file readiness, or CI token isolation.
