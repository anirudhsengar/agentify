# Dependency compatibility matrix

Status: accepted discovery record for Issue #34  
Discovery date: 2026-07-12  
Implementation gate: Issues #32 and #33 must be merged before any dependency version changes

## Executive decision

This matrix records both discovery decisions and the isolated implementation result for each dependency group. A completed row may change only its owned manifest, lockfile, configuration, documentation, and characterization surface; later groups remain frozen.

| Group | Resolved baseline | Candidate or decision | Publication date | Status | Implementation issue |
| --- | --- | --- | --- | --- | --- |
| TypeScript and Node declarations | TypeScript 5.9.3; `@types/node` 22.19.21 | TypeScript 6.0.3; `@types/node` 22.20.1 | TS 6.0.3: 2026-04-16; Node types 22.20.1: 2026-07-08 | **Implemented; Node 22 floor retained** | #60 |
| esbuild and tsx | esbuild 0.25.12; tsx 4.22.4 | esbuild 0.28.1; tsx 4.23.0 | 2026-06-11; 2026-07-03 | **Approved as one group; gated** | #61 |
| TypeBox | direct 1.2.9; Pi nested 1.1.38 | direct 1.3.6 | 2026-07-08 | **Approved; hard-blocked on #33** | #62 |
| Pi runtime pair | 0.80.6 / 0.80.6 | 0.80.6 / 0.80.6 | 2026-07-09 / 2026-07-09 | **Unnecessary today; re-evaluate at gate** | #63 |
| Smithy integrity override | override 4.4.7 plus nested 2.2.0 | review 4.4.8, retention, narrowing, or removal | 4.4.8: 2026-07-10 | **Blocked pending provenance review** | #64 |
| Node engine/support | engine `>=22.19.0`; CI on 22.19.0 and 24 | retain the current floor unless later evidence justifies change | Node 22 EOL: 2027-04-30; Node 24 EOL: 2028-04-30 | **No engine change approved** | #65 |

TypeScript 7.0.2, published 2026-07-08, was evaluated but is not approved for this cycle. It removes `baseUrl`, rejects the current non-relative `paths` target, and introduces twenty platform-specific compiler packages. TypeScript 6 is the migration bridge.

## Implementation gate

No implementation issue may begin until latest `main` proves all of the following:

1. Issue #32 state migration and deprecated write-map retirement are merged.
2. Issue #33 schema decomposition and golden contract tests are merged.
3. Issue #35 decision documentation remains merged; PR #49 satisfied this condition.
4. `npm run typecheck`, `npm run test:all`, `npm run test:package`, `npm run test:security-redteam`, `npm run test:parity`, and `npm run release:check` pass.
5. `npm pack --json --ignore-scripts` and `npm audit --omit=dev` have been reviewed.
6. The exact minimum supported Node version and the current supported Node version are green.

## Baseline inventory

### Manifest ranges

```text
engines.node                         >=22.19.0
@earendil-works/pi-ai                ^0.80.6
@earendil-works/pi-coding-agent      ^0.80.6
typebox                              ^1.1.38
@types/node                          22.20.1
esbuild                              ^0.25.12
tsx                                  ^4.20.0
typescript                           6.0.3
override @smithy/util-buffer-from    4.4.7
```

### Resolved lockfile

```text
@earendil-works/pi-ai                0.80.6
@earendil-works/pi-coding-agent      0.80.6
typebox (direct)                     1.2.9
typebox (Pi nested copies)           1.1.38
typescript                           6.0.3
@types/node (root)                   22.20.1
esbuild (root)                       0.25.12
tsx                                  4.22.4
esbuild (tsx nested)                 0.28.1
@smithy/util-buffer-from (root)      4.4.7
@smithy/util-buffer-from (nested)    2.2.0
```

The baseline production audit reported zero known vulnerabilities. Audit output is investigation evidence; it is not proof of behavioral compatibility, package provenance, or deterministic installation.

## TypeScript and `@types/node`

| Required field | Compatibility assessment |
| --- | --- |
| Baseline version | TypeScript range `^5.6.0`, resolved 5.9.3. Node types range `^22.0.0`, resolved 22.19.21. |
| Implemented version | TypeScript 6.0.3 and `@types/node` 22.20.1, pinned directly for deterministic compiler/declaration selection. Node 24 declarations remain intentionally excluded while the runtime floor is Node 22.19.0. |
| Release date | TypeScript 6.0.3: 2026-04-16. Node types 22.20.1: 2026-07-08. |
| Official migration documentation | [TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html), compiler-provided [TS6 migration guidance](https://aka.ms/ts6), [DefinitelyTyped Node declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node), and the [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json). |
| Breaking API/type changes | TypeScript 6 changes default ambient-type discovery and deprecates `baseUrl`, Node 10 module resolution, legacy module formats, `outFile`, and compatibility options. Agentify already declares `types: ["node"]`, strict mode, ESM, and bundler resolution. The concrete blocker is `baseUrl`. Node 24 declarations may expose APIs absent on Node 22. |
| Runtime behavior changes | `tsc` remains `noEmit`; runtime behavior should not change. New inference and diagnostics can reveal real schema, Pi API, ESM, or test typing differences. |
| Node requirements | TypeScript 6 is compatible with the current floor in discovery. Declaration policy must follow the minimum runtime rather than the newest published Node types. |
| ESM implications | `module: "ESNext"`, `moduleResolution: "Bundler"`, JSON modules, and `.ts` import checking are preserved. The unused `baseUrl`, wildcard `paths`, and temporary `ignoreDeprecations` workaround were removed; package resolution continues through normal ESM/bundler semantics. |
| Bundling implications | No direct emitted bundle change is expected, but TypeScript resolution must continue to agree with esbuild resolution. |
| Schema implications | Re-check every TypeBox `Static<>` contract and schema façade export because compiler inference may change without serialized JSON changing. |
| Tool/session API implications | Pi session, provider, event, usage, and tool definitions may infer more strictly; do not hide incompatibility with broad casts. |
| Security advisory effects | No production advisory is fixed by the compiler. Review package provenance and unexpected compiler-package additions. |
| Expected lockfile impact | TypeScript 6 should update the compiler entry without TypeScript 7's twenty platform packages. Retaining Node 22 types should limit type movement to `@types/node` and possibly `undici-types`. |
| Required tests | Effective-config comparison, typecheck, maintenance, all tests, schema/tool/session characterization, parity, installed-package smoke, release check, Node 22.19.0 and current supported Node CI. |
| Decision | **Implemented in #60.** TypeScript 6.0.3 and Node-22 declarations 22.20.1 are isolated to the direct development dependency group. No Node engine, runtime, schema, build-tool, TypeBox, Pi, Smithy, package-export, or generated-output policy changed. |

Isolated evidence:

- TypeScript 6.0.3 reports `baseUrl` as deprecated and points to the TS6 migration guide.
- TypeScript 7.0.2 reports `baseUrl` as removed and rejects the current paths mapping.
- TypeScript 7 adds twenty `@typescript/typescript-*` platform packages and is deferred.

Implementation result (2026-07-15):

- clean `npm ci` resolved exactly TypeScript 6.0.3 and root `@types/node` 22.20.1;
- nested Pi `@types/node` remained 22.19.19 and `undici-types` remained 6.21.0;
- the lockfile added or removed no package records and changed only the two owned direct records;
- effective compiler options retain strict ESM/bundler behavior with no `baseUrl`, wildcard `paths`, or `ignoreDeprecations`; and
- typecheck and the production build pass on exact Node 22.19.0 and Node 24.13.1.

## esbuild and tsx

| Required field | Compatibility assessment |
| --- | --- |
| Current version | esbuild 0.25.12; tsx 4.22.4. The existing tsx subtree already carries esbuild 0.28.1 separately. |
| Candidate version | esbuild 0.28.1 and tsx 4.23.0 as one coherent group. |
| Release date | esbuild 0.28.1: 2026-06-11. tsx 4.23.0: 2026-07-03. |
| Official migration documentation | [esbuild changelog](https://github.com/evanw/esbuild/blob/master/CHANGELOG.md), [tsx releases](https://github.com/privatenumber/tsx/releases), and the [tsx package contract](https://github.com/privatenumber/tsx/blob/master/package.json). |
| Breaking API/type changes | esbuild 0.28.0 is intentionally a breaking release. Review build/transform options, warnings, binary integrity behavior, and platform package handling. tsx remains on 4.x and officially depends on esbuild `~0.28.0`. |
| Runtime behavior changes | esbuild owns the compiled CLI; tsx executes repository tests and scripts. Parser, resolver, ESM/CJS interop, lowering, tree-shaking, source maps, or loader changes can alter behavior. |
| Node requirements | Both candidates require Node >=18, below Agentify's floor. |
| ESM implications | Preserve esbuild `format: "esm"`, Node platform behavior, externalization, executable startup, and tsx `.ts` ESM resolution on Node 22 and 24. |
| Bundling implications | Compare `dist/cli.js`, source maps, warnings, size, prompt/workflow asset copying, installed startup, and tarball inventory. No output drift is accepted merely because the bundle runs. |
| Schema implications | No API migration is expected, but bundled schema objects and generated outputs must remain equivalent. |
| Tool/session API implications | Ensure bundling does not duplicate, omit, or rewrite Pi and TypeBox runtime boundaries. |
| Security advisory effects | esbuild 0.28 adds npm/Deno binary integrity checks. 0.28.1 includes a Windows development-server traversal fix; Agentify does not use the development server, but the integrity improvement supports upgrading. |
| Expected lockfile impact | Root esbuild plus 26 platform packages update; tsx updates; 27 nested tsx/esbuild platform entries disappear through deduplication. No production dependency should move. |
| Required tests | Build, generation pipeline, maintenance, all tests, parity, package smoke, source-map/bundle/tarball comparison, audit, Node minimum/current CI. |
| Decision | **Approved as one dependency group.** |

The isolated pair built the 14.2 MB ESM bundle and passed generation-pipeline tests. Its maintenance failure came only from the temporary discovery script being intentionally absent from the standalone-script allowlist; that script is not retained.

## TypeBox

| Required field | Compatibility assessment |
| --- | --- |
| Current version | Direct range `^1.1.38`, resolved 1.2.9. Pi subtrees retain exact 1.1.38 copies. |
| Candidate version | Direct TypeBox 1.3.6. |
| Release date | 2026-07-08. |
| Official migration documentation | [TypeBox 1.3 changelog](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.3.0.md) and the [official repository](https://github.com/sinclairzx81/typebox). |
| Breaking API/type changes | 1.3 removes deprecated `Base`, `Awaited`, `Promise`, `AsyncIterator`, `Iterator`, and `Value.Mutate` APIs and changes compiler/reference and future TypeScript inference internals. No audited Agentify import uses the removed APIs. |
| Runtime behavior changes | Validation, compilation, errors, references, defaults, cloning, repair, and Unicode/length behavior can change even when serialized schemas look identical. |
| Node requirements | No higher engine requirement was observed; verify the final patch manifest at implementation. |
| ESM implications | Preserve existing `typebox` and Value/compiler import paths and package export resolution. |
| Bundling implications | Only a minor bundle-size change is expected; no runtime asset should be added. |
| Schema implications | Critical: preserve serialized schema semantics, static types, required/optional fields, enums/literals, bounds, constraints, descriptions, validation acceptance/rejection, error paths, write-map parameters, and stable façades. |
| Tool/session API implications | Pi model-visible tools consume TypeBox parameter schemas; preserve JSON schemas and validator behavior. |
| Security advisory effects | No audit vulnerability was identified. The release contains correctness and maintenance changes. |
| Expected lockfile impact | Only root `node_modules/typebox` should move from 1.2.9 to 1.3.6. Pi's exact nested 1.1.38 copies should remain until the Pi group changes them. |
| Required tests | Complete schema goldens, schema/write-map characterization, validation/error fixtures, execution-policy/tool-schema tests, generated parity, all tests, package smoke, Node minimum/current CI. |
| Decision | **Approved but hard-blocked until Issue #33 merges.** |

The isolated 1.3.6 probe passed typecheck and the audit schema/write-map golden characterization. The later unit failure was caused by not building `dist/cli.js` in the probe sequence, not by TypeBox.

## Pi runtime pair

| Required field | Compatibility assessment |
| --- | --- |
| Current version | `@earendil-works/pi-ai` 0.80.6 and `@earendil-works/pi-coding-agent` 0.80.6. |
| Candidate version | 0.80.6 / 0.80.6; no newer registry release existed on 2026-07-12. |
| Release date | Pi AI 0.80.6: 2026-07-09. Pi coding agent 0.80.6: 2026-07-09. |
| Official migration documentation | Official [Pi AI npm package](https://www.npmjs.com/package/@earendil-works/pi-ai), [Pi coding-agent npm package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), and their declared [source repository](https://github.com/earendil-works/pi-mono). |
| Breaking API/type changes | None today because there is no version delta. A future pair requires review of model/provider discovery, auth, session creation, event shapes, tools, usage/cost, cancellation, and errors. |
| Runtime behavior changes | No current delta. Future releases are high-impact because the pair owns the model/provider session runtime and provider SDK graph. |
| Node requirements | Both packages require Node >=22.19.0, exactly matching Agentify's floor. |
| ESM implications | Both are ESM packages. Preserve exports, dynamic provider loading, and bundle/runtime resolution. |
| Bundling implications | Pi dominates the bundled production graph; a future change requires complete bundle and tarball inventory comparison. |
| Schema implications | Both currently depend on TypeBox 1.1.38 internally; a future pair may change tool-schema conversion. |
| Tool/session API implications | Critical: characterize `createAgentSession`, provider/model resolution, auth, events, tool definitions, interruption, and usage/cost before adaptation. |
| Security advisory effects | Baseline audit is clean. Future provider SDK, undici, networking, AWS/Smithy, or nested shrinkwrap changes need explicit review. |
| Expected lockfile impact | The 0.80.6 paired simulation changes zero entries. Future releases require a complete categorized lockfile report. |
| Required tests | Brownfield and greenfield runtime tests, providers/auth/models, slots, session events, cancellation, tool schemas, execution policy, cost, installed package, bundle/tarball, minimum/current Node CI. |
| Decision | **Unnecessary today.** Re-query at the gate and upgrade the pair atomically only when a newer compatible pair exists; otherwise close #63 as no-op. |

## `@smithy/util-buffer-from` override

| Required field | Compatibility assessment |
| --- | --- |
| Current version | Root npm override 4.4.7; Pi coding-agent's nested shrinkwrap still contains 2.2.0. |
| Candidate version | 4.4.8 is latest, but the final action may be retain, update, narrow, or remove. |
| Release date | 4.4.8: 2026-07-10. |
| Official migration documentation | [Smithy TypeScript](https://github.com/smithy-lang/smithy-typescript), the [npm package](https://www.npmjs.com/package/@smithy/util-buffer-from), and Agentify commit `bf53892336ad69cf3653e7497b391b5b9ddf033e`. |
| Breaking API/type changes | Moving between 2.x and 4.x changes dependencies and engines. A root override does not necessarily rewrite package-internal shrinkwrap entries. |
| Runtime behavior changes | Buffer conversion participates in AWS/Smithy provider paths; binary correctness and Bedrock behavior must be preserved. |
| Node requirements | 4.4.x requires Node >=18; 2.2.0 requires Node >=14. Both remain below Agentify's floor. |
| ESM implications | No public ESM change is expected; review duplicate Smithy copies and module placement. |
| Bundling implications | Override choice changes Smithy core/is-array-buffer placement and can alter the production bundle. |
| Schema implications | None directly. |
| Tool/session API implications | Bedrock/provider request and response behavior is the relevant runtime seam. |
| Security advisory effects | The override was added after npm re-published 2.2.0 with different bytes, causing `npm ci` integrity failures. `npm audit` does not resolve provenance or deterministic-install concerns. |
| Expected lockfile impact | Removing the override removes root 4.4.7, adds root `@smithy/is-array-buffer`, and adds another nested 2.2.0 under `@smithy/util-utf8`; the existing Pi nested 2.2.0 remains. |
| Required tests | Clean-cache `npm ci`, registry integrity/provenance review, audit, Bedrock/provider characterization, security-redteam, all/package/parity, bundle/tarball comparison, minimum/current Node CI. |
| Decision | **Blocked.** Do not remove or force-upgrade it automatically. Resolve #64 after the Pi dependency graph is final. |

The isolated removal probe passed typecheck, security-redteam, and audit with zero reported vulnerabilities. That is necessary but insufficient because the original control addressed re-published bytes and deterministic installation.

## Node engine and support policy

| Required field | Compatibility assessment |
| --- | --- |
| Current version | Product engine `>=22.19.0`; required CI on Node 22.19.0 and Node 24. |
| Candidate version | Retain the current floor. Node 26 may be evaluated separately as an informational/current-release lane. |
| Release date/lifecycle | Node 22 support ends 2027-04-30. Node 24 ends 2028-04-30. Node 26 began 2026-05-05 and is scheduled for LTS on 2026-10-28. |
| Official migration documentation | [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) and [previous releases](https://nodejs.org/en/about/previous-releases). |
| Breaking API/type changes | A floor change affects installation, ESM, globals, fetch/undici, filesystem/subprocess behavior, test tooling, and user support. |
| Runtime behavior changes | Node is the product runtime. A minimum/current-line change is a product-support decision, not a transitive dependency detail. |
| Node requirements | Current candidates do not require a higher floor. The Pi pair explicitly matches 22.19.0. |
| ESM implications | Verify resolution, import attributes, URLs, loaders, subprocesses, and bundled ESM on every required line. |
| Bundling implications | esbuild/tsx binaries and compiled CLI execution must be tested on exact supported versions. |
| Schema implications | None directly; JSON, Unicode, and validation runtime behavior must remain stable. |
| Tool/session API implications | Fetch, AbortSignal, streams, events, subprocesses, and filesystem behavior underpin Pi sessions and tools. |
| Security advisory effects | Supported lines have different maintenance windows. Do not retain EOL support or claim an untested current release. |
| Expected lockfile impact | None when retaining policy. Never hide an engine change inside another dependency PR. |
| Required tests | Full required suite, installed package, bundle/tarball, brownfield/greenfield, schema/tool policy on exact minimum and current supported versions. |
| Decision | **No engine change approved.** Decide explicitly in #65 after every dependency group is resolved. |

## Isolated lockfile simulations

| Simulation | Added | Removed | Changed | Interpretation |
| --- | ---: | ---: | ---: | --- |
| TypeScript 6.0.3 + Node 22.20.1 types | 0 | 0 | 2 | Implemented in #60; only the two owned direct package records move. |
| TypeScript 7.0.2 + Node 24 types | 20 | 0 | 3 | Adds native/platform TypeScript packages; not approved. |
| esbuild 0.28.1 + tsx 4.23.0 | 0 | 27 | 28 | Deduplicates tsx's nested esbuild/platform tree into the root candidate. |
| TypeBox 1.3.6 | 0 | 0 | 1 | Root TypeBox only. |
| Pi 0.80.6 pair | 0 | 0 | 0 | Already current. |
| Smithy override removal | 2 | 1 | 0 | Reintroduces another nested 2.2.0 path; requires integrity review. |

Every simulation retained a zero-vulnerability production audit result. Audit output remains evidence, not an instruction to force incompatible upgrades.

## Approved implementation order

1. #60 — TypeScript 6 and Node declaration alignment. **Completed.**
2. #61 — esbuild and tsx.
3. #62 — TypeBox, only after #33.
4. #63 — Pi pair re-evaluation; no-op if still current.
5. #64 — Smithy override/integrity review after the Pi graph is final.
6. #65 — Node engine/support decision last.

The order remains the requested default. The refinement is that TypeScript 7 is deferred and `@types/node` does not jump to Node 24 while the product floor remains Node 22.

## Rules for every implementation PR

- One dependency group per branch and PR.
- Re-query official release notes, migration guides, publish dates, engines, exports, and advisories immediately before implementation.
- Add or strengthen characterization before adapting source.
- Do not weaken schemas, tests, execution policies, package boundaries, or security gates.
- Review the complete lockfile diff and explain unexpected transitive packages.
- Test Node 22.19.0 and the current supported Node version.
- Compare bundle and `npm pack` inventories.
- Update `[Unreleased]` for maintainer- or user-visible effects.
- Record old/new versions, source changes, lockfile changes, security findings, test results, and PR URL in #34.

## Validation command set

```bash
npm run typecheck
npm run test:all
npm run test:package
npm run test:security-redteam
npm run test:parity
npm run release:check
npm pack --json --ignore-scripts
npm audit --omit=dev
```

Additional mandatory coverage:

- TypeScript: effective config, static schema/tool/session types, minimum/current Node.
- Build tooling: installed CLI, generation pipeline, bundle/source-map/tarball comparison.
- TypeBox: complete schema goldens and validation/error-path fixtures.
- Pi: brownfield/greenfield, providers/auth/models, events/cancellation/cost, execution policy/tool schemas.
- Smithy: clean-cache install integrity and Bedrock/provider paths.
- Node policy: full required matrix on exact minimum and current supported lines.

## Discovery evidence and cleanup

Candidate versions, publication dates, lockfile-only simulations, and isolated characterization were collected through temporary pull-request CI. Those discovery instruments are not retained. The final discovery branch contains no `package.json` or `package-lock.json` change.