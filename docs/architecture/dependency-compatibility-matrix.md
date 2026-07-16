# Dependency compatibility matrix

Status: accepted discovery and implementation record for Issue #34  
Discovery date: 2026-07-12  
Last implementation update: 2026-07-15  
Implementation gate: Issues #32 and #33 are complete

## Executive decision

Dependency work is split into separately owned groups. Each implementation may change only its manifest, lockfile, configuration, documentation, and characterization surface. Later groups remain frozen until their issue begins.

| Group | Resolved baseline | Approved candidate or decision | Publication date | Status | Issue |
| --- | --- | --- | --- | --- | --- |
| TypeScript and Node declarations | TypeScript 5.9.3; `@types/node` 22.19.21 | TypeScript 6.0.3; `@types/node` 22.20.1 | 2026-04-16; 2026-07-08 | **Implemented; Node 22 floor retained** | #60 |
| esbuild and tsx | esbuild 0.25.12; tsx 4.22.4 | esbuild 0.28.1; tsx 4.23.1 | 2026-06-11; 2026-07-13 | **Implemented as one build-tooling group** | #61 |
| TypeBox | direct 1.2.9; Pi nested 1.1.38 | direct 1.3.6 | 2026-07-08 | **Approved; pending implementation** | #62 |
| Pi runtime pair | 0.80.6 / 0.80.6 | re-query as a pair; keep 0.80.6 / 0.80.6 if still current | 2026-07-09 baseline | **Re-evaluation pending** | #63 |
| Smithy integrity override | override 4.4.7 plus nested 2.2.0 | review 4.4.8, retention, narrowing, or removal | 2026-07-10 candidate | **Pending provenance and compatibility review** | #64 |
| Node engine and support | engine `>=22.19.0`; validation on 22.19.0 and 24 | retain the current floor unless evidence justifies change | Node 22 EOL 2027-04-30; Node 24 EOL 2028-04-30 | **No engine change approved** | #65 |

TypeScript 7.0.2 was evaluated but is not approved for this cycle. It removes `baseUrl`, rejects the former non-relative `paths` target, and introduces twenty platform-specific compiler packages. TypeScript 6 is the completed migration bridge.

## Implementation gate

Before any dependency group lands, latest `main` must preserve:

1. completed state migration and deprecated write-map retirement from #32;
2. completed schema decomposition and golden-contract ownership from #33;
3. the decision documentation merged through #35;
4. typecheck, build, package, parity, security, and release gates;
5. reviewed `npm pack --json --ignore-scripts` and `npm audit --omit=dev` results; and
6. compatibility on exact Node 22.19.0 and the current supported Node line.

No implementation may weaken a schema, validator, hard gate, security policy, package boundary, test, or lockfile merely to pass.

## Current inventory after #61

### Manifest ranges

```text
engines.node                         >=22.19.0
@earendil-works/pi-ai                ^0.80.6
@earendil-works/pi-coding-agent      ^0.80.6
typebox                              ^1.1.38
@types/node                          ^22.20.1
esbuild                              ^0.28.1
tsx                                  ^4.23.1
typescript                           ^6.0.3
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
esbuild (root)                       0.28.1
tsx                                  4.23.1
esbuild (tsx nested)                 none; deduplicated
@smithy/util-buffer-from (root)      4.4.7
@smithy/util-buffer-from (nested)    2.2.0
```

The production audit reports zero known vulnerabilities. Audit output is investigation evidence; it is not proof of behavioral compatibility, package provenance, or deterministic installation.

## TypeScript and `@types/node`

| Required field | Compatibility assessment |
| --- | --- |
| Baseline | TypeScript range `^5.6.0`, resolved 5.9.3; Node types range `^22.0.0`, resolved 22.19.21. |
| Implemented | TypeScript range `^6.0.3`, resolved 6.0.3; root `@types/node` range `^22.20.1`, resolved 22.20.1. |
| Official evidence | TypeScript 6 release and migration notes, compiler-provided TS6 migration guidance, DefinitelyTyped Node declarations, and the Node release schedule. |
| Breaking changes | TypeScript 6 changes ambient-type discovery and deprecates legacy resolution and compatibility options. Agentify already uses explicit Node types, strict mode, ESM, and bundler resolution. |
| Runtime and ESM | `tsc` remains `noEmit`. `module: "ESNext"`, `moduleResolution: "Bundler"`, JSON modules, and `.ts` import checking are preserved. |
| Configuration result | Removed obsolete `baseUrl`, wildcard `paths`, and `ignoreDeprecations`; package resolution now uses normal ESM and package-export semantics. |
| Node policy | Declarations remain on the Node 22 line because the minimum runtime is Node 22.19.0. Node 24 declarations were not adopted implicitly. |
| Lockfile result | Only the root TypeScript and root Node-declaration records changed. Nested Pi Node declarations and `undici-types` remained unchanged. No TypeScript 7 platform packages were added. |
| Decision | **Implemented in #60.** No runtime, schema, build-tool, TypeBox, Pi, Smithy, export, or generated-output policy changed. |

Implementation evidence:

- clean installation selected TypeScript 6.0.3 and root `@types/node` 22.20.1;
- nested Pi `@types/node` remained 22.19.19 and `undici-types` remained 6.21.0;
- effective compiler options contain no `baseUrl`, wildcard `paths`, or `ignoreDeprecations`;
- typecheck and production build passed on Node 22.19.0 and Node 24.13.1; and
- the installed package retained its identity, CLI behavior, inventory restrictions, and deep-import rejection.

## esbuild and tsx

| Required field | Compatibility assessment |
| --- | --- |
| Baseline | esbuild range `^0.25.12`, resolved 0.25.12; tsx range `^4.20.0`, resolved 4.22.4. The tsx subtree separately carried esbuild 0.28.1. |
| Implemented | esbuild range `^0.28.1`, resolved 0.28.1; tsx range `^4.23.1`, resolved 4.23.1. |
| Release date | esbuild 0.28.1: 2026-06-11; tsx 4.23.1: 2026-07-13. |
| Official evidence | esbuild changelog and security advisories; tsx releases and package/runtime contract. tsx 4.23.1 declares Node >=18 and depends on esbuild `~0.28.0`. |
| Breaking changes | esbuild 0.28.0 is intentionally breaking and adds binary-integrity checks. 0.28.1 fixes Windows development-server traversal and transform/minifier edge cases. Agentify does not use esbuild's development server. |
| Runtime and ESM | Existing `scripts/build.mjs` options remain valid. The CLI remains a Node-targeted ESM bundle with unchanged externalization, executable entry point, source-map production, and runtime-asset copying. |
| Schema and session surfaces | No schema, Pi, TypeBox, tool, session, or generated-output contract changed. Focused schema ownership and composition tests remain green. |
| Lockfile result | Root esbuild and its 26 platform packages moved to 0.28.1; tsx moved to 4.23.1; the nested tsx esbuild package and 26 nested platform packages were removed through deduplication. No production dependency changed. |
| Bundle result | `dist/cli.js` increased by 5,388 bytes, approximately 0.036%; its source map increased by 273 bytes. Node 22.19.0 and Node 24.13.1 produced identical hashes. |
| Package result | The tarball remains 181 files. Identity, version, complete help output, raw-source exclusion, temporary-file exclusion, and `ERR_PACKAGE_PATH_NOT_EXPORTED` behavior are unchanged. |
| Decision | **Implemented in #61 as one coherent build-tooling group.** No build architecture, code splitting, minification, format, target, package export, runtime asset, or Node engine policy changed. |

Implementation evidence:

- clean installs resolved exactly esbuild 0.28.1 and tsx 4.23.1;
- typecheck, build, schema-boundary tests, production audit, packing, and installed-package smoke passed on Node 22.19.0 and Node 24.13.1;
- the packed artifact is 8,050,846 bytes, 45,718,774 bytes unpacked, and 181 files;
- package SHA-1 is `8fb4d623e762b3a81906b226172237c8acbaf18d`;
- package integrity is `sha512-2d/rFeSzmGsoWdV6vsg5qFtm41FSq+gf/VCQ/6oVFZG5BfUkf/N6P8UKYzk6Z2klBpTPrguDj7fAsitKZI/Zcg==`; and
- production audit remained at zero known vulnerabilities.

## TypeBox

| Required field | Compatibility assessment |
| --- | --- |
| Current | Direct range `^1.1.38`, resolved 1.2.9. Pi subtrees retain exact 1.1.38 copies. |
| Candidate | Direct TypeBox 1.3.6. |
| Release date | 2026-07-08. |
| Official evidence | TypeBox 1.3 changelog and official repository. |
| Breaking changes | TypeBox 1.3 removes deprecated `Base`, `Awaited`, `Promise`, `AsyncIterator`, `Iterator`, and `Value.Mutate` APIs and changes compiler/reference and future TypeScript inference internals. No audited Agentify import uses the removed APIs. |
| Runtime risk | Validation, compilation, errors, references, defaults, cloning, repair, and Unicode/length behavior can change even when serialized schemas look identical. |
| Schema requirements | Preserve serialized schema semantics, static types, required and optional fields, enums and literals, bounds, constraints, descriptions, validation acceptance and rejection, error paths, write-map parameters, and stable façades. |
| Expected lockfile | Only root `node_modules/typebox` should move from 1.2.9 to 1.3.6. Pi's exact nested 1.1.38 copies remain frozen. |
| Required tests | Complete schema goldens, schema/write-map characterization, validation/error fixtures, execution-policy and tool-schema tests, generated parity, package smoke, and both Node lanes. |
| Decision | **Approved and next in order under #62.** It is not implemented by #61. |

The isolated discovery probe passed typecheck and audit-schema/write-map golden characterization. Final implementation must repeat the full gate after #61.

## Pi runtime pair

| Required field | Compatibility assessment |
| --- | --- |
| Current | `@earendil-works/pi-ai` 0.80.6 and `@earendil-works/pi-coding-agent` 0.80.6. |
| Candidate | Re-query both packages together at the #63 gate. |
| Baseline release date | Both 0.80.6 packages were published 2026-07-09. |
| Pairing rule | The two packages are one runtime contract and may not be upgraded independently. |
| Runtime risk | Future changes require review of model/provider discovery, auth, session creation, event shapes, tools, usage and cost, cancellation, errors, and provider SDK graph. |
| Expected lockfile | No change if 0.80.6 remains current. Any future delta requires complete pair and transitive review. |
| Decision | **Re-evaluate closed #63 after #62.** If 0.80.6 remains current, record evidence and keep the issue closed as unnecessary. |

## Smithy integrity override

| Required field | Compatibility assessment |
| --- | --- |
| Current | Root override `@smithy/util-buffer-from` 4.4.7; a nested 2.2.0 remains in the graph. |
| Candidate | Review 4.4.8 and decide whether to retain, narrow, update, or remove the override. |
| Provenance requirement | Confirm why the override exists, which dependency paths it affects, whether upstream ranges now resolve safely without it, and whether package provenance and integrity remain acceptable. |
| Runtime risk | Buffer conversion sits on provider SDK and credential/request paths; silent behavioral changes are not acceptable. |
| Expected lockfile | Must be characterized through isolated retain, update, narrow, and remove simulations. Reject unrelated AWS/Smithy churn. |
| Decision | **Pending #64.** No override change is included in #60 or #61. |

## Node engine and support

| Required field | Compatibility assessment |
| --- | --- |
| Current | `engines.node` is `>=22.19.0`; validation lanes are exact Node 22.19.0 and current Node 24. |
| Candidate | Retain the floor unless #65 establishes evidence for a policy change. |
| Compatibility rule | Dependencies and declarations must remain usable on the minimum supported runtime. Newer declarations may not introduce APIs unavailable on Node 22.19.0. |
| Packaging rule | The installed CLI, ESM bundle, package exports, deep-import rejection, and runtime assets must pass on both lanes. |
| Decision | **Pending #65.** #60 and #61 preserve the existing floor. |

## Lockfile impact summary

| Group | Added records | Removed records | Changed records | Result |
| --- | ---: | ---: | ---: | --- |
| TypeScript 6.0.3 + Node 22.20.1 types | 0 | 0 | 2 | Implemented in #60; only the two owned direct records moved. |
| esbuild 0.28.1 + tsx 4.23.1 | 0 | 27 | 28 | Implemented in #61; root esbuild/platform records and tsx moved, nested esbuild/platform records deduplicated. |
| TypeBox 1.3.6 | 0 | 0 | 1 expected | Pending #62; root TypeBox only. |
| Pi 0.80.6 pair | 0 | 0 | 0 if still current | Re-evaluate under #63. |
| Smithy override | unknown | unknown | unknown | Characterize under #64 before deciding. |
| Node support policy | 0 | 0 | documentation/config only unless approved | Decide under #65. |

Every completed simulation retained a zero-vulnerability production audit result. Audit output does not replace behavioral, schema, package, provenance, or minimum-runtime validation.

## Approved implementation order

1. #60 — TypeScript 6 and Node declaration alignment. **Completed.**
2. #61 — esbuild and tsx. **Completed.**
3. #62 — direct TypeBox upgrade with schema golden parity.
4. #63 — Pi runtime-pair re-evaluation; no-op if 0.80.6 remains current.
5. #64 — Smithy override provenance and disposition.
6. #65 — Node engine and support-policy decision.
7. Close parent #34 only after every child decision is recorded and all implementation gates are complete.

## Release constraints

These dependency changes are maintainer-visible but do not authorize publication. During this backlog:

- do not publish npm packages;
- do not create a GitHub release;
- do not create, delete, or move `v0.2.0` or `v0.2.1`;
- do not enable, dispatch, or rerun GitHub Actions; and
- keep every implementation and merge commit marked with `[skip actions]`.
