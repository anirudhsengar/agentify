# Release process

Agentify releases are tag-only and artifact-driven. The package version and Git
tag must match exactly.

## Preconditions

- the worktree is clean;
- `package.json` and `package-lock.json` contain the intended version;
- `CHANGELOG.md` documents the release;
- current documentation matches CLI and package behavior;
- Node.js 22.19.0 and the `packageManager`-pinned npm are available;
- npm and GitHub credentials are configured outside repository state.

Run the authoritative gate:

```bash
npm ci
npm run verify:release
npm run verify:pack-reproducibility
```

`verify:release` performs strict type checking, builds all bundles, runs all
source and contract tests, runs the installed scaffold suite, installs and
executes the exact npm artifact, and audits the full dependency tree (the
zero-dependency artifact ships bundles built from that tree).

## Tag and publish

Create an annotated tag whose name is `v` followed by the exact package version:

```bash
git tag -a v1.0.0 -m "Agentify v1.0.0"
git push origin v1.0.0
```

The release workflow:

1. checks out the tagged commit;
2. installs Node 22.19.0 and npm 11.19.0;
3. verifies the tag against `package.json`;
4. runs `verify:release`;
5. builds the release tarball once;
6. validates its name, inventory, hashes, and reproducibility;
7. publishes that exact local tarball to npm;
8. creates the GitHub release from the same artifact.

Manual workflow dispatch performs verification only. It does not publish or move
tags.

## Failure handling

Do not reuse or move a published tag. Fix the source on a new commit, choose the
next semantic version, rerun the full gate, and publish a new tag. Never publish
from an unverified working tree or by rebuilding different bytes after the tag.
