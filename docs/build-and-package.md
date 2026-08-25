# Build and package

Agentify requires Node.js 22.19.0 or newer and uses ESM throughout.

## Build

`npm run build` executes `scripts/build.mjs`. The build creates three bundled
entry points:

```text
dist/cli.js
dist/task-runtime.mjs
dist/learning-runtime.mjs
```

It also copies the prompts, workflow assets, and runtime files required by the
installed package. Build inputs are explicit; raw `src/` files are not published.

The three bundles are fully self-contained: esbuild inlines every library the
CLI and runtimes import, including the Pi SDK. The published package therefore
declares **zero runtime `dependencies`** — installing it fetches no transitive
packages, runs no third-party install scripts, and prints no deprecation
warnings from upstream code. Everything needed to build the bundles
(`@earendil-works/pi-*`, `@clack/prompts`, `typebox`, esbuild, TypeScript) lives
in `devDependencies`.

## Package surface

The npm artifact exposes:

- `bin/agentify.js` as the only executable;
- the three `dist/` bundles and required runtime assets;
- the installable scaffold;
- current public and maintainer documentation;
- `package.json` through the sole package export.

Deep imports are blocked. Consumers do not require TypeScript, `tsx`, source
files, a repository checkout, or build tooling.

## Verification

```bash
npm run typecheck
npm run test:all
npm run test:package
npm run verify:release
```

`test:all` builds and runs every discovered source test plus repository contract
tests. `test:package` creates the exact tarball, checks its inventory and hashes,
installs it into isolated fixtures, exercises the public CLI, and runs installed
workflow scenarios.

`verify:release` adds the complete scaffold suite and a full-tree dependency
audit (the shipped bundles contain code drawn from the development dependency
tree, so `npm audit` runs without `--omit=dev`). It is the authoritative
source-to-artifact gate.

## Reproducibility

`scripts/pack-release.mjs` writes a deterministic package result describing the
tarball name and hash. `scripts/verify-pack-reproducibility.mjs` compares package
bytes produced in clean environments. Release automation uses Node 22.19.0 and
the npm version pinned by `packageManager`.

The package file allowlist, installed-document link checks, bundle roots, copied
assets, and package exports are contract-tested. Any new runtime asset must be
added deliberately to the build, package inventory, and exact-artifact tests.
