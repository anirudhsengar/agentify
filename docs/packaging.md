# Compiled package contract

Agentify is developed in TypeScript but published and executed as JavaScript.
The npm artifact must never require a runtime TypeScript loader.

## Build output

`npm run build` performs a clean production build:

1. remove the existing `dist/` directory;
2. compile `src/**/*.ts` with `tsconfig.build.json`;
3. rewrite relative `.ts` import specifiers to JavaScript specifiers;
4. copy non-TypeScript runtime assets from `src/` into the matching `dist/`
   locations;
5. fail if `dist/cli.js` was not emitted.

The asset-copy step preserves prompt Markdown, JSON data, and runtime `.mjs`
helpers next to the compiled modules that resolve them through `import.meta.url`.

## Published artifact

The published tarball contains:

- `bin/agentify.js`, a minimal executable shim;
- `dist/`, containing compiled runtime code and colocated runtime assets;
- the generated scaffold, packaged skills, documentation, license, and package
  metadata required by the CLI.

The artifact does not contain `src/` or TypeScript implementation files. The
package export map also rejects package-internal deep imports. The only supported
runtime entrypoint remains the `agentify` executable.

## Release verification

The package smoke test builds the project, creates the exact npm tarball, installs
it into a clean temporary project, and verifies:

- the tarball contains `dist/cli.js` and the executable shim;
- no `src/` path or `.ts` implementation file is present;
- the installed package has no `jiti` runtime dependency;
- `agentify --help` and `agentify --version` execute successfully;
- importing `agentify/src/cli.ts` is rejected by Node's package export boundary.

Release automation publishes the same verified tarball and never rebuilds in the
publication job.
