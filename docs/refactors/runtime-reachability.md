# Runtime reachability specification

This specification defines the roots and evidence model that Issue #22 must use before deleting code. It records the current repository contract; it does not classify any production file as dead by itself.

A file is removable only when it is proven unreachable from every retained root below. Uncertainty is a reason to retain the file and record it as a candidate.

## 1. Supported CLI runtime

The supported runtime begins at the installed package boundary:

```text
package.json#bin.agentify
  -> bin/agentify.js
  -> dist/cli.js
  -> bundled graph rooted at src/cli.ts
```

Reachability includes all static and dynamic TypeScript or JavaScript imports used by the CLI, plus files opened through application-owned filesystem discovery. The root covers top-level parsing, utility subcommands, brownfield and greenfield execution, attach and recovery, rendering, ownership, apply, rollback, state transactions, harness exports, and scaffold installation.

The source checkout is not the public boundary. A module imported only through raw `src/` is not public merely because it is importable during development, but it may still be reachable from another retained root.

## 2. Build, package, and runtime assets

Build and package roots include:

- `package.json` fields `bin`, `files`, `exports`, scripts, npm lifecycle hooks, dependencies, and engines;
- `bin/agentify.js`;
- `scripts/build.mjs` and every file or directory in its explicit copy manifest;
- runtime prompts and workflow definitions copied into `dist/`;
- `scaffold/` files installed into target repositories;
- `packaged/` skills and `skills-lock.json`;
- top-level and `docs/` files included by the npm `files` allowlist;
- release and CI workflows that build, inspect, test, or publish the artifact;
- shell and JavaScript helpers invoked by package scripts, GitHub Actions, or scaffold workflows.

Filesystem-discovered assets count as consumers even when there is no import edge. This includes prompts, skills, workflows, agent definitions, scaffold templates, and generated-runtime scripts selected by path, extension, registry entry, or directory traversal.

Package reachability must be checked against `npm pack --json --ignore-scripts`. Raw `src/` remains excluded and package exports remain restrictive.

## 3. Internal experimental composition roots

The following areas are retained internal composition roots when referenced by repository code, security checks, or contract tests:

- `src/core/webhook/`;
- `src/core/aiw/`;
- `src/core/orchestrator/`;
- `src/core/coms/`;
- `src/core/agent-expert.ts` and related expert modules.

These roots are not supported package APIs and must not be promoted into CLI routes or exports. Their experimental status does not make them dead. Composition entrypoints, workflow registries, security policies, prompt assets, and test-only runtimes under these areas must be traced before any deletion.

## 4. Tests and fixtures

Repository validation is a retained reachability root. Account for:

- recursively discovered `tests/**/*.test.*` files;
- `tests/run.sh` and shell contracts it invokes;
- helpers and fixtures imported by tests, including files without `.test` in their names;
- `scaffold/tests/` and workflow-simulation fixtures;
- package installation and tarball inventory tests;
- maintenance, generated-output, parity, and security-redteam commands;
- test data opened by path rather than imported;
- experimental modules retained specifically for contract or security coverage.

A file used only by a test is not production runtime code, but it is still reachable from a retained root and cannot be deleted as proven dead without changing the test contract in a separately justified issue.

## 5. Proven unreachable candidates

A candidate may be classified as proven unreachable only after all of the following are checked:

1. no TypeScript or JavaScript static import, dynamic import, `require`, or generated bundle edge reaches it;
2. no package script, build script, npm lifecycle hook, shell script, or GitHub Actions workflow invokes it;
3. no `package.json` `bin`, `files`, or `exports` entry includes or exposes it;
4. no registry, directory walk, glob, path constant, prompt loader, skill loader, workflow loader, scaffold copier, or other filesystem discovery can select it;
5. no shipped documentation names it as an executable command, runtime asset, compatibility surface, or operator procedure;
6. no unit, integration, contract, package, scaffold, parity, or security test consumes it;
7. it is not retained as an experimental composition root or compatibility fixture.

Search results alone are insufficient when a path may be discovered dynamically. Generated `dist/` output must be traced back to its source and copied assets rather than treated as an independent source tree.

## Deletion evidence required by Issue #22

For every deletion, record:

- the file or export's previous purpose;
- all reachability roots examined;
- evidence that no retained consumer exists;
- the replacement, when functionality moved elsewhere;
- why it is not a package, build, test, fixture, documentation, compatibility, or experimental surface.

If evidence is incomplete, retain the item and list it as a candidate with the unresolved edge.

## Current generated and discovered surface

The reachability audit must specifically account for generated-surface inventory used by ownership snapshots and rollback, including root artifacts, provider dot-directories, GitHub actions/scripts/workflows, feedback-loop directories, prompts, workflows, extensions, skills, and feature-agent files. Reserved agent filenames and provider-specific exporter conventions are behavioral data even when represented as constants rather than standalone modules.

The parity contract in `docs/refactors/modernization-baseline.md` is the regression gate for every classification or deletion made from this specification.
