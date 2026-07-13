# Runtime reachability specification

This specification defines the roots and evidence model used before deleting code. It records the repository contract and the audited classification completed for Issue #22.

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

### Audited CLI classification

The following source families are retained through the bundled graph rooted at `src/cli.ts`:

| Classification | Retained source | Reachability evidence |
| --- | --- | --- |
| CLI parsing and dispatch | `src/cli.ts`, `src/core/cli-parser.ts`, `src/core/cli-commands.ts` | Bundled static import graph and installed CLI parity tests. |
| Authentication, models, targets, and project selection | configuration/auth modules, `src/core/models/`, `src/core/target-picker.ts`, `src/core/project-classifier.ts` | CLI bootstrap and utility-subcommand paths. |
| Brownfield runtime | `src/core/run-agentify.ts`, `src/core/audit/`, artifact renderers, apply policy, manifest, revert, and repository-state modules | Audit, attach, partial, abort, conflict, rollback, and parity paths. |
| Greenfield runtime | `src/core/greenfield-artifacts.ts`, `src/core/greenfield-state.ts`, and greenfield session coordination | Greenfield formation, checkpoint, rendering, state, and generated-output tests. |
| State and recovery | `src/core/state-dir.ts`, `src/core/state-transaction.ts`, project/repository state modules | Provider-scoped resolution, legacy compatibility, transaction, rollback, and recovery tests. |
| Harness export and scaffold installation | exporter, skill-curation, package-root, and scaffold-installer modules | Selected-target fan-out, managed ownership, filesystem discovery, and installed-package tests. |

No supported CLI module or public command was removed by Issue #22.

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

### Audited build and package classification

| Classification | Retained path | Reachability evidence |
| --- | --- | --- |
| Compiled entrypoint | `bin/agentify.js`, `scripts/build.mjs`, `src/cli.ts` | `package.json#bin`, `build`, `prepack`, CI, and release workflows. |
| Copied runtime prompts | `src/core/audit/prompts/**` | Explicit `scripts/build.mjs` copy manifest and installed-package assertions. |
| Copied workflow definitions | `src/core/orchestrator/workflows/**` | Explicit `scripts/build.mjs` copy manifest; files are loaded by workflow registries and retained experimental tests. |
| Target-repository runtime | `scaffold/**` | Scaffold installer, package `files`, shell contracts, and `scaffold/tests/**`. |
| Shipped skill catalog | `packaged/skills/**`, `skills-lock.json` | Package `files`, skill curation and exporter directory traversal, documentation, and unification contracts. |
| Shipped documentation | top-level guidance and `docs/**` | Package `files`, documentation index, package-link tests, and operator procedures. |
| CI and release helpers | `.github/workflows/**`, `.github/scripts/**` | Direct workflow references and release-safety tests. |

The npm inventory is expected to remain byte-for-byte identical except for edits to already-shipped documentation. Relocating raw-source-only communications files does not alter the tarball because `src/`, repository `scripts/`, and tests are excluded.

## 3. Internal experimental composition roots

The following areas are retained internal composition roots when referenced by repository code, security checks, or contract tests:

- `src/core/webhook/`;
- `src/core/aiw/`;
- `src/core/orchestrator/`, including its owned `comms/` transport;
- `src/core/agent-expert.ts` and related expert modules.

These roots are not supported package APIs and must not be promoted into CLI routes or exports. Their experimental status does not make them dead. Composition entrypoints, workflow registries, security policies, prompt assets, and test-only runtimes under these areas must be traced before any deletion.

### Audited experimental classification

| Area | Retained because |
| --- | --- |
| Webhook | `tests/webhook/**`, security-redteam coverage, HTTP/signature/replay policy, and documented experimental composition. |
| AIW | `tests/aiw/**`, orchestrator bridge paths, execution-policy tests, and workflow composition contracts. |
| Orchestrator | `tests/orchestrator/**`, copied workflow JSON, workflow registry, domain locks, security/contract tests, and the owned `src/core/orchestrator/comms/` peer transport. |
| Agent Expert | generated-output qualification, expert-outcome scoring, smoke evidence, and release qualification tests. |

The standalone `src/core/orchestrator/scripts/seed-workflows.mjs` file was not a retained composition root: no orchestrator module, registry, test, package script, documentation page, build copy, or workflow invoked it.

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

### Audited test classification

| Root | Discovery or invocation rule |
| --- | --- |
| TypeScript/JavaScript tests | `tests/scripts/run-test-files.mjs` recursively discovers `tests/**/*.test.*`. |
| Generation pipeline | `package.json#test:generation-pipeline` invokes its dedicated TypeScript contract. |
| Repository shell contracts | `tests/run.sh` executes every `tests/test-*.sh`. |
| Scaffold contracts | `scaffold/tests/run.sh` and focused package/security scripts execute the target-runtime simulations. |
| Fixtures and helpers | Imports from `tests/fixtures/**`, fake runtimes, and path-opened fixture files are retained consumers. |
| Package boundary | `tests/package/installed-cli-smoke.mjs` packs, inventories, installs, and executes the real package. |
| Parity boundary | `tests/parity/**` freezes CLI, generated-bundle, ownership, symlink, manifest, and state behavior. |

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

## Standalone script inventory

Issue #22 audited executable-style files in `scripts/`, `src/core/scripts/`, `src/core/audit/scripts/`, and `src/core/orchestrator/scripts/`.

### Retained scripts

| Script | Classification | Consumer |
| --- | --- | --- |
| `scripts/build.mjs` | Build/package root | `package.json#build`, `prepack`, CI, and release workflows. |
| `src/core/audit/scripts/inspect-log.mjs` | Maintainer utility root | `package.json#inspect-log`. |
| `src/core/audit/scripts/aggregate-kpis.mjs` | Test-only root | `tests/scripts/aggregate-kpis.test.mjs`. |
| `src/core/scripts/score-expert-outcomes.ts` | Maintainer evidence root | `package.json#score:expert-outcomes`. |
| `src/core/scripts/verify-smoke-evidence.ts` | Maintainer evidence root | `package.json#verify:smoke-evidence` and focused tests. |
| `src/core/scripts/qualify-release-evidence.ts` | Maintainer evidence root | `package.json#qualify:release-evidence` and focused tests. |

`tests/maintenance/reachability-invariants.test.ts` freezes this inventory. A new standalone script must gain an explicit retained consumer and classification rather than silently becoming an orphan.

### Deleted scripts and evidence

| Removed path | Previous purpose | Zero-consumer evidence | Replacement / reason outside retained roots |
| --- | --- | --- | --- |
| `scripts/patch-tools.py` | One-time regex applicator that rewrote orchestrator tool error-result shapes. | It was the only repository Python applicator; no package script, workflow, import, test, documentation, build copy, package entry, or directory loader referenced it. | The rewritten TypeScript tool implementations are the permanent result. The applicator itself had no ongoing runtime or maintenance role. |
| `src/core/audit/scripts/compare-runs.mjs` | Standalone Markdown comparison of two historical audit JSONL logs. | Its name and callable were referenced only inside its own file; it was absent from package scripts, docs, tests, workflows, build copies, and package inventory. | No supported replacement is required. `inspect-log.mjs` remains the explicitly retained diagnostic utility. |
| `src/core/audit/scripts/coverage-trend.mjs` | Standalone coverage trend renderer for historical audit logs. | Its name and callable were referenced only inside its own file; it was absent from package scripts, docs, tests, workflows, build copies, and package inventory. | No supported replacement is required. KPI aggregation remains covered by the tested `aggregate-kpis.mjs`. |
| `src/core/orchestrator/scripts/seed-workflows.mjs` | Standalone copier from source workflow JSON into `~/.agentify/workflows/`. | No orchestrator import, registry, test, package script, documentation, workflow, build step, or package entry invoked it. The build copies workflow JSON to `dist/workflows` but never copied this script. | Current workflow loading uses packaged/copied definitions and generated repository surfaces; undocumented user-home seeding is not part of a retained contract. |

All four files were excluded from the npm package before deletion. Their removal therefore changes neither installed CLI bytes nor tarball paths.

## Retained compatibility and uncertain candidates

The following suspicious-looking items were deliberately retained:

| Candidate | Reason retained |
| --- | --- |
| Deprecated legacy state constants and path helpers in manifest/greenfield/state modules | Tests, scaffold compatibility, and legacy `.pi/agentify` behavior still consume or document them. |
| Experimental composition entrypoints under webhook, AIW, orchestrator (including its communications transport), and Agent Expert | Contract and security tests are retained roots even without public CLI or package exports. |
| `src/core/audit/scripts/aggregate-kpis.mjs` | It has a direct executable test consumer and therefore is test-reachable. |
| Copied prompt and workflow directories | They are filesystem-discovered build assets; absence of a TypeScript import edge is not deletion evidence. |
| Scaffold scripts not named by source imports | Workflows, setup documentation, unification contracts, and scaffold tests consume them by path. |

No uncertain candidate was deleted.

## Deletion evidence requirements for later work

For every future deletion, record:

- the file or export's previous purpose;
- all reachability roots examined;
- evidence that no retained consumer exists;
- the replacement, when functionality moved elsewhere;
- why it is not a package, build, test, fixture, documentation, compatibility, or experimental surface.

If evidence is incomplete, retain the item and list it as a candidate with the unresolved edge.

## Current generated and discovered surface

The reachability audit specifically accounts for generated-surface inventory used by ownership snapshots and rollback, including root artifacts, provider dot-directories, GitHub actions/scripts/workflows, feedback-loop directories, prompts, workflows, extensions, skills, and feature-agent files. Reserved agent filenames and provider-specific exporter conventions are behavioral data even when represented as constants rather than standalone modules.

The parity contract in `docs/refactors/modernization-baseline.md` is the regression gate for every classification or deletion made from this specification.
