# Build and package architecture

Agentify is authored in TypeScript but published as a compiled Node ESM command.
The official npm package is `@anirudhsengar/agentify`; its installed executable remains `agentify`. The npm artifact is intentionally narrower than the repository checkout.

## Build flow

```text
src/cli.ts
  → esbuild bundle
  → dist/cli.js

src/core/audit/prompts/
  → copied verbatim
  → dist/prompts/

src/core/orchestrator/workflows/
  → copied verbatim
  → dist/workflows/

bin/agentify.js
  → imports ../dist/cli.js
```

`scripts/build.mjs` is the single build implementation. CI and npm lifecycle
scripts call it rather than duplicating build logic in workflow YAML.

The bundle targets Node 22 and remains ESM. A `createRequire(import.meta.url)`
bridge is injected for bundled CommonJS dependencies that perform dynamic
`require()` calls. This bridge is part of the generated bundle only; application
source remains ESM.

## Runtime assets

Prompts and workflow definitions are executable inputs, not optional
repository documentation. The build fails when required asset directories are
missing and verifies representative files after copying.

Code that needs the installed package root must use
`src/core/package-root.ts`. It walks upward to the nearest `package.json` whose
name is `@anirudhsengar/agentify`, so the same code works when executed from source and from the
bundled `dist/cli.js` location.

## Published boundary

The npm `files` allowlist includes:

- `bin/`
- `dist/`
- `scaffold/`
- `docs/`
- `packaged/`
- package metadata and top-level guidance files

It excludes raw `src/`, tests, temporary workflows, and build tooling. The
package `exports` map exposes no library API. Removed internal compatibility
symbols therefore cannot be reached through a supported deep import; the
installed `agentify` binary is the supported runtime surface. Dedicated
old-manifest and migration readers are bundled only because the CLI needs them
for safe installed upgrades.

## Verification

`npm run test:package` performs the release-relevant checks against an actual
packed tarball:

1. build the distribution;
2. inspect the tarball file list;
3. require compiled code and runtime assets;
4. reject raw source and `jiti`;
5. install into a clean project;
6. execute `agentify --help` and `agentify --version`;
7. verify package deep imports are rejected.

A source-checkout test is not a substitute for this gate. Release publication
uses the exact tarball produced and verified by the release workflow.

## Maintenance rules

- Add new runtime file assets to the explicit copy manifest in
  `scripts/build.mjs` and to package-smoke assertions.
- Never make the binary load TypeScript source at runtime.
- Never add raw `src/` back to the npm artifact to work around a missing asset.
- Keep build dependencies in `devDependencies`; production dependencies are for
  behavior required by the installed command.
- Treat package-smoke failures as release blockers.
