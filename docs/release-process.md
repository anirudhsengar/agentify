# Release process

Agentify releases are tag-driven. Manual workflow dispatch is always a
verification run and can never publish to npm or create a GitHub release.

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
4. create an npm tarball;
5. install a tarball into a fresh temporary project;
6. run the installed `agentify --help` and `agentify --version` commands;
7. create the final release tarball;
8. upload that tarball as a workflow artifact.

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

The npm job downloads and publishes the exact tarball produced by the successful
verification job. It does not rebuild from a second checkout. npm provenance is
requested through GitHub's OIDC token.

The GitHub release job runs only after npm publication succeeds. It attaches the
same verified tarball and uses GitHub-generated release notes. Release Drafter is
not invoked in the publication workflow, avoiding two competing release-note
sources.

## Permissions

The workflow defaults to `contents: read`.

- Verification receives no write permission.
- npm publication receives `id-token: write` and `contents: read`.
- GitHub release publication receives `contents: write` only.

The npm environment should retain required-reviewer protection and the npm token
should be scoped only to this package.

## CI gates

Pull requests and main-branch pushes run separate jobs for:

- TypeScript typechecking at the minimum supported Node version;
- the full executable test suite on Node 22.19 and Node 24;
- production dependency audit;
- installation and execution of the packed npm artifact;
- CodeQL;
- dependency review for high-severity additions and denied copyleft licenses.

The CI test job calls `npm run test:all`, which intentionally excludes duplicate
typechecking. `npm test` remains the local all-in-one command.

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
