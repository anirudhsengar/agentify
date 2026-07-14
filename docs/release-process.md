# Release process

Agentify releases are tag-driven. The official npm package is `@anirudhsengar/agentify`, while the installed executable remains `agentify`. Manual workflow dispatch is always a verification run and can never publish to npm or create a GitHub release.

## Release prerequisites

Before creating a release tag:

1. update `package.json` to the intended version;
2. update `CHANGELOG.md` with user-visible changes;
3. ensure the main branch is green;
4. run `npm run release:check` locally when possible;
5. create a signed or protected tag named `v<package-version>`.

Examples:

```text
package.json version 0.2.0 → tag v0.2.0
package.json version 0.2.0-beta.1 → tag v0.2.0-beta.1
```

A tag that is not valid semver or does not exactly match `package.json` stops in
the verification job.

## Verification job

Both manual dispatch and tag pushes run the same verification job:

1. install from the lockfile with `npm ci`;
2. verify the tag when the event is a tag push;
3. run typechecking and the complete test suite;
4. run the installed-package smoke test, which packs into a temporary artifact, installs it into a clean project, and executes `agentify --help` and `agentify --version`;
5. run the final `npm pack --json --ignore-scripts` command;
6. require exactly one pack result with a non-empty filename and confirm that exact tarball exists;
7. expose the filename as a step and job output;
8. upload that exact tarball as the workflow artifact.

The package smoke test is available independently as:

```bash
npm run test:package
```

## Publication jobs

The npm and GitHub release jobs have identical job-level guards:

```text
github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
```

A manual dispatch therefore never enters either job, regardless of inputs or
branch name.

The verification job derives the tarball filename from `npm pack --json`, uploads that exact file, and exposes the filename as a step and job output. The npm job downloads the artifact, requires exactly one local `.tgz`, and publishes it without rebuilding or repacking. npm provenance is requested through GitHub's OIDC token.

The GitHub release job runs only after npm publication succeeds. It attaches the
same verified tarball and uses GitHub-generated release notes. Release Drafter is
not invoked in the publication workflow, avoiding two competing release-note
sources.

## Permissions

The workflow defaults to `contents: read`.

- Verification receives no write permission.
- npm publication receives `id-token: write` and `contents: read`.
- GitHub release publication receives `contents: write` only.

The npm environment should retain required-reviewer protection and the granular npm token should allow public publication of `@anirudhsengar/agentify` under the `anirudhsengar` user scope, including the required 2FA-bypass publishing permission when token-based publication requires it.

## CI gates

Pull requests and main-branch pushes run separate jobs for:

- TypeScript typechecking at the minimum supported Node version;
- the full executable test suite on Node 22.19 and Node 24;
- high-severity production dependency auditing with `npm audit`;
- installation and execution of the packed npm artifact;
- CodeQL.

GitHub's dependency-review action is intentionally not a required check in this
repository because the repository integration fails before producing a review,
even when configured in warn-only mode. A permanently broken check would provide
no security signal. Dependency changes remain covered by the lockfile, production
`npm audit`, CodeQL, and normal pull-request review.

The CI test job calls `npm run test:all`, which intentionally excludes duplicate
typechecking. `npm test` remains the local all-in-one command.

## Upgrade-compatibility gate

Release verification must preserve safe upgrades from prior installed versions.
The packed CLI is tested against retained legacy state, old manifest formats,
interrupted migration journals, explicit provider switches, and package export
confinement. Removed callable compatibility APIs are not public package exports;
file-format readers required to migrate user state remain part of the CLI until
their supported upgrade horizon is deliberately retired.

## Failure handling

Do not move or recreate a failed release tag until the cause is understood.

- Tag/version mismatch: correct `package.json`, merge, and create a new tag.
- Verification failure: fix the repository and create a new version tag.
- npm publication failure: inspect the npm environment and token; the GitHub
  release will not be created.
- GitHub release failure after npm succeeds: rerun only after confirming the tag
  and npm package are correct. The attached artifact must remain the verified
  workflow artifact.

Never use manual workflow dispatch as a publication workaround.
