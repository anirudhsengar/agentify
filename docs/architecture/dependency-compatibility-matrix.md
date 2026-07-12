# Dependency compatibility matrix

Status: Issue #34 discovery record  
Discovery date: 2026-07-12  
Implementation gate: Issues #32 and #33 must be merged before any dependency version changes

## Decision summary

This document records the version-neutral discovery phase for Issue #34. The discovery PR changes no dependency range, lockfile entry, Node engine, runtime export, schema, generated asset, or package boundary.

| Group | Baseline | Candidate or decision | Status | Implementation issue |
| --- | --- | --- | --- | --- |
| TypeScript and Node declarations | TypeScript 5.9.3; `@types/node` 22.19.21 | TypeScript 6.0.3; retain Node 22 declarations unless support policy changes | **Approved with required config migration; gated** | #60 |
| Build tooling | esbuild 0.25.12; tsx 4.22.4 | esbuild 0.28.1; tsx 4.23.0 | **Approved; gated** | #61 |
| TypeBox | direct 1.2.9; Pi nested 1.1.38 | direct 1.3.6 | **Approved but hard-blocked on #33** | #62 |
| Pi runtime pair | 0.80.6 / 0.80.6 | 0.80.6 / 0.80.6 | **Unnecessary today; re-evaluate at gate** | #63 |
| Smithy integrity override | override 4.4.7 plus nested 2.2.0 | review 4.4.8, retention, narrowing, or removal | **Blocked pending provenance/integrity review** | #64 |
| Node support policy | engine `>=22.19.0`; required CI on 22.19.0 and 24 | retain current floor unless later evidence justifies change | **No engine change approved** | #65 |

TypeScript 7.0.2 was evaluated but is not an approved candidate for this cycle. It removes `baseUrl`, rejects the current paths mapping, and introduces twenty platform compiler packages. TypeScript 6 is the required migration bridge.

## Gate before implementation

No implementation issue may begin until latest `main` proves all of the following:

1. Issue #32 state migration and deprecated write-map retirement are merged.
2. Issue #33 schema decomposition and golden contract tests are merged.
3. Issue #35 decision documentation is merged. This condition is already satisfied by PR #49.
4. `npm run typecheck`, `npm run test:all`, `npm run test:package`, `npm run test:security-redteam`, `npm run test:parity`, and `npm run release:check` pass.
5. `npm pack --json --ignore-scripts` and `npm audit --omit=dev` have been reviewed.
6. The minimum supported Node version and current supported Node version are both green.

## Baseline inventory

### Manifest

```text
engines.node                         >=22.19.0
@earendil-works/pi-ai                ^0.80.6
@earendil-works/pi-coding-agent      ^0.80.6
typebox                              ^1.1.38
@types/node                          ^22.0.0
esbuild                              ^0.25.12
tsx                                  ^4.20.0
typescript                           ^5.6.0
override @smithy/util-buffer-from    4.4.7
```

### Resolved lockfile

```text
@earendil-works/pi-ai                0.80.6
@earendil-works/pi-coding-agent      0.80.6
typebox (direct)                     1.2.9
typebox (Pi nested copies)           1.1.38
typescript                           5.9.3
@types/node (root)                   22.19.21
esbuild (root)                       0.25.12
tsx                                  4.22.4
esbuild (tsx nested)                 0.28.1
@smithy/util-buffer-from (root)      4.4.7
@smithy/util-buffer-from (nested)    2.2.0
```

The baseline production audit reported zero known vulnerabilities across all severities. That result is evidence, not proof of supply-chain integrity or behavioral compatibility.

## Compatibility records

### TypeScript

| Field | Assessment |
| --- | --- |
| Current version | Declared `^5.6.0`; resolved 5.9.3. |
| Candidate version | 6.0.3. TypeScript 7.0.2 is explicitly deferred. |
| Release date | Recorded from the official npm registry in the discovery evidence; final implementation must re-query because the selected patch may advance. |
| Official migration documentation | [TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html) and the compiler-provided [TS6 migration link](https://aka.ms/ts6). |
| Breaking API/type changes | TypeScript 6 changes ambient `types` defaults, deprecates `baseUrl`, old Node module resolution, legacy module formats, `outFile`, and several compatibility options. Agentify already sets `types: ["node"]`, uses ESM/bundler resolution, and has strict mode enabled. The remaining concrete blocker is `baseUrl`. |
| Runtime behavior changes | `tsc` is a development-time checker only (`noEmit`); no direct runtime code should change. New inference or diagnostics may expose real source/API problems. |
| Node requirements | TypeScript 6 remains compatible with the existing Node floor in discovery. The implementation must verify the candidate package engine at the gate. |
| ESM implications | Preserve `module: "ESNext"`, `moduleResolution: "Bundler"`, explicit `.ts` import checking, and JSON-module handling. Remove reliance on `baseUrl` and use explicit relative `paths` targets. |
| Bundling implications | None expected directly, but type-only resolution must continue to agree with esbuild's ESM resolution. |
| Schema implications | Type inference changes can affect TypeBox `Static<>` surfaces; run schema static/serialized contract tests. |
| Tool/session API implications | Pi tool/session types may become stricter or infer differently; do not cast away incompatibilities. |
| Security advisory effects | No production advisory is resolved by the compiler upgrade. Review compiler package provenance and lockfile structure. |
| Expected lockfile impact | TypeScript 6 should update the compiler entry without TypeScript 7's twenty native/platform packages. Investigate any unexpected additions. |
| Required tests | Typecheck, maintenance, all tests, schema/tool characterization, parity, package smoke, release check, Node minimum/current CI. |
| Decision | **Approved with required migration.** Upgrade to 6.x after the gate; do not use `ignoreDeprecations` as the final fix for `baseUrl`. |

Discovery probes:

- TypeScript 6.0.3 reports `baseUrl` as deprecated and points to the TS6 migration guide.
- TypeScript 7.0.2 reports `baseUrl` as removed and rejects the current non-relative paths target.
- TypeScript 7 adds twenty `@typescript/typescript-*` platform packages; this is not accepted implicitly.

### `@types/node`

| Field | Assessment |
| --- | --- |
| Current version | Declared `^22.0.0`; root resolves 22.19.21. |
| Candidate version | Retain the latest Node 22 line for the TypeScript 6 PR. Node 24.13.3 was inspected but is not approved while runtime support begins at Node 22.19.0. |
| Release date | Re-query the selected Node 22 patch at implementation time. |
| Official migration documentation | [DefinitelyTyped Node declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) and the [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json). |
| Breaking API/type changes | A Node 24 declaration jump can expose APIs absent on the Node 22 runtime and can alter globals, web types, streams, filesystem, subprocess, and test typings. |
| Runtime behavior changes | Type declarations do not change runtime, but can authorize source that fails on the supported minimum runtime. |
| Node requirements | The declaration policy must follow the product support floor, not the newest published types. |
| ESM implications | Review Node ESM loader, import attributes, URL, and module declarations against Node 22 behavior. |
| Bundling implications | None expected; compile-time global/module resolution can affect build inputs. |
| Schema implications | None directly, except inferred Node-backed values in schemas or validators. |
| Tool/session API implications | Provider, stream, fetch, abort, event, and filesystem types may change. |
| Security advisory effects | None directly. |
| Expected lockfile impact | Retaining the 22 line should limit movement to `@types/node` and `undici-types` if a newer 22 patch exists. |
| Required tests | Typecheck plus full runtime tests on Node 22.19.0 and current supported Node. |
| Decision | **No major declaration upgrade approved.** Keep Node types aligned with the minimum runtime; revisit in #65. |

### esbuild

| Field | Assessment |
| --- | --- |
| Current version | Declared/resolved 0.25.12. |
| Candidate version | 0.28.1. |
| Release date | 2026-06-11 (official npm registry evidence collected during discovery). |
| Official migration documentation | [Official esbuild changelog](https://github.com/evanw/esbuild/blob/master/CHANGELOG.md). |
| Breaking API/type changes | 0.28.0 is intentionally a breaking release. Review changed build/transform options, integrity checks, platform binary behavior, and warnings. |
| Runtime behavior changes | The bundled CLI can change if parsing, lowering, tree-shaking, minification, resolution, or sourcemaps change. Agentify does not accept output drift merely because the bundle executes. |
| Node requirements | Candidate requires Node >=18, below Agentify's floor. |
| ESM implications | Preserve `format: "esm"`, Node platform, package externalization decisions, and executable entry semantics. |
| Bundling implications | Directly owns `dist/cli.js` and sourcemap production. Compare size, warnings, copied assets, startup, and tarball inventory. |
| Schema implications | No schema API change; generated/bundled schema objects must remain behaviorally identical. |
| Tool/session API implications | Bundling must not duplicate, omit, or rewrite Pi/TypeBox runtime boundaries. |
| Security advisory effects | 0.28.0 adds npm/Deno binary integrity checking; 0.28.1 includes a Windows development-server traversal fix. Agentify does not use esbuild's dev server, but the security change supports upgrading. |
| Expected lockfile impact | Root esbuild and 26 platform packages update; tsx's nested esbuild/platform tree deduplicates away when paired with tsx 4.23.0. |
| Required tests | Build, generation pipeline, all tests, parity, installed CLI/package smoke, bundle/tarball comparison, Node minimum/current CI. |
| Decision | **Approved as a pair with tsx.** |

### tsx

| Field | Assessment |
| --- | --- |
| Current version | Declared `^4.20.0`; resolved 4.22.4. |
| Candidate version | 4.23.0. |
| Release date | 2026-07-03 (official npm registry evidence collected during discovery). |
| Official migration documentation | [Official releases](https://github.com/privatenumber/tsx/releases) and [package contract](https://github.com/privatenumber/tsx/blob/master/package.json). |
| Breaking API/type changes | Remains on 4.x. Review release notes for loader, watch, CJS/ESM, source-map, and Node feature-detection changes. |
| Runtime behavior changes | Repository tests and scripts execute through tsx; loader or resolution differences can alter test discovery and failures. |
| Node requirements | Official package requires Node >=18, below Agentify's floor. |
| ESM implications | tsx is an ESM loader/CLI. Preserve `.ts` execution, import resolution, and subprocess behavior across Node 22 and 24. |
| Bundling implications | tsx 4.23.0 officially depends on esbuild `~0.28.0`, enabling one deduplicated esbuild tree. |
| Schema implications | None directly; all schema tests run through tsx. |
| Tool/session API implications | None directly; all runtime characterization tests depend on reliable TS execution. |
| Security advisory effects | Inherits the paired esbuild security/integrity improvements. |
| Expected lockfile impact | tsx changes and 27 nested esbuild/platform entries are removed through deduplication. |
| Required tests | Complete test discovery, generation pipeline, maintenance, parity, security, package smoke, Node minimum/current CI. |
| Decision | **Approved only with esbuild 0.28.x.** |

The isolated pair built the ESM bundle and passed generation-pipeline tests. Its maintenance failure came exclusively from the temporary discovery script being unclassified; that script is removed from the final discovery PR.

### TypeBox

| Field | Assessment |
| --- | --- |
| Current version | Declared `^1.1.38`; direct root resolves 1.2.9; Pi subtrees use exact 1.1.38. |
| Candidate version | Direct dependency 1.3.6. |
| Release date | 2026-07-08 (official npm registry evidence collected during discovery). |
| Official migration documentation | [TypeBox 1.3 changelog](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.3.0.md). |
| Breaking API/type changes | 1.3 removes deprecated `Base`, `Awaited`, `Promise`, `AsyncIterator`, `Iterator`, and `Value.Mutate`; it also changes compiler/reference internals and TypeScript 7 inference preparation. No audited Agentify import uses the removed APIs. |
| Runtime behavior changes | Validation, compilation, repair, cloning, errors, references, defaults, and Unicode/length behavior can change even when schema JSON is identical. |
| Node requirements | No higher runtime requirement was observed. Verify the final package manifest at implementation. |
| ESM implications | Preserve the current `import { Type, type Static } from "typebox"` and Value/compiler imports. |
| Bundling implications | Bundle size may shift slightly; no new runtime asset is expected. |
| Schema implications | Critical. Preserve serialized schema semantics, static types, error paths, required/optional fields, literals/enums, bounds, descriptions, and write-map/tool schemas. |
| Tool/session API implications | Pi model-visible tools consume TypeBox schemas. Preserve parameter JSON schemas and validation behavior. |
| Security advisory effects | No audit vulnerability was identified. The maintenance line contains correctness fixes. |
| Expected lockfile impact | Only root `node_modules/typebox` should change from 1.2.9 to 1.3.6; Pi nested 1.1.38 copies remain. |
| Required tests | Schema goldens, schema/write-map characterization, tool-schema/execution-policy tests, all tests, generated parity, package smoke, Node minimum/current CI. |
| Decision | **Approved but hard-blocked until #33 merges.** |

The isolated 1.3.6 probe passed typecheck and the audit schema/write-map golden characterization. The later unit failure was a probe-order issue (`dist/cli.js` was not built), not a TypeBox incompatibility.

### `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`

| Field | Assessment |
| --- | --- |
| Current version | Both declared/resolved 0.80.6. |
| Candidate version | 0.80.6 for both; no newer registry release existed on 2026-07-12. |
| Release date | Pi AI: 2026-07-09; Pi coding agent: 2026-07-09. |
| Official migration documentation | Official npm package pages and the packages' declared source repository: [Pi AI](https://www.npmjs.com/package/@earendil-works/pi-ai), [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), [source](https://github.com/earendil-works/pi-mono). |
| Breaking API/type changes | None to assess because there is no candidate delta. A future candidate must be reviewed for session, provider, model, tool, event, auth, usage/cost, cancellation, and error-shape changes. |
| Runtime behavior changes | No current delta. The packages own the model/provider session runtime and a large provider SDK graph, so future changes are high-impact. |
| Node requirements | Both require Node >=22.19.0, matching Agentify's floor. |
| ESM implications | Both are ESM packages. Preserve imports, exports, dynamic provider loading, and bundle behavior. |
| Bundling implications | Pi packages dominate the bundled dependency graph; future upgrades require complete bundle/tarball comparison. |
| Schema implications | Both depend on TypeBox 1.1.38 internally. A future pair may alter model/tool schema conversion. |
| Tool/session API implications | Critical. Characterize `createAgentSession`, model registry/resolution, provider auth, event streams, tools, interruption, and usage/cost. |
| Security advisory effects | Baseline audit is clean. Future provider SDK, undici, Smithy/AWS, or networking changes need explicit review. |
| Expected lockfile impact | Current pair simulation changes zero entries. Future upgrades require full categorization, including nested shrinkwrap copies. |
| Required tests | Brownfield/greenfield runtime, model/provider/auth, slots, session events, cancellation, tool schemas, execution policy, cost, package/bundle, Node minimum/current CI. |
| Decision | **Unnecessary today.** Re-query after #32/#33; upgrade as a pair only, or close #63 as no-op. |

### `@smithy/util-buffer-from` override

| Field | Assessment |
| --- | --- |
| Current version | Root override 4.4.7; nested Pi coding-agent shrinkwrap still contains 2.2.0. |
| Candidate version | 4.4.8 is latest, but the action may be retain, update, narrow, or remove. |
| Release date | 4.4.8 published 2026-07-10. |
| Official migration documentation | [Smithy TypeScript](https://github.com/smithy-lang/smithy-typescript), [npm package](https://www.npmjs.com/package/@smithy/util-buffer-from), and Agentify commit `bf53892336ad69cf3653e7497b391b5b9ddf033e`. |
| Breaking API/type changes | A 2.x-to-4.x graph change changes dependencies and Node engines. The root override does not necessarily rewrite nested shrinkwrap entries. |
| Runtime behavior changes | Buffer conversion is used in AWS/Smithy provider paths. Preserve binary correctness and Bedrock behavior. |
| Node requirements | 4.4.x requires Node >=18; 2.2.0 requires Node >=14. Both are below Agentify's floor. |
| ESM implications | No expected surface change; review Smithy module graph and duplicate copies. |
| Bundling implications | Override choice changes Smithy core/is-array-buffer placement and may alter bundle contents. |
| Schema implications | None directly. |
| Tool/session API implications | Provider/Bedrock requests are the relevant runtime seam. |
| Security advisory effects | The override was added because npm re-published 2.2.0 with different bytes, causing lock integrity failure. `npm audit` does not answer that provenance question. |
| Expected lockfile impact | Removing the override removes root 4.4.7, adds root `@smithy/is-array-buffer`, and adds another nested 2.2.0 under `@smithy/util-utf8`; an existing Pi nested 2.2.0 remains. |
| Required tests | Clean-cache `npm ci`, integrity/provenance review, audit, Bedrock/provider tests, security-redteam, all/package/parity, bundle/tarball comparison, Node minimum/current CI. |
| Decision | **Blocked.** No automatic removal or forced upgrade; resolve in #64 after the Pi graph is final. |

The isolated removal probe passed typecheck, security-redteam, and audit with zero vulnerabilities. That is necessary but insufficient evidence because the original control addressed re-published bytes and deterministic installation.

### Node engine and support matrix

| Field | Assessment |
| --- | --- |
| Current version | Product floor `>=22.19.0`; CI requires Node 22.19.0 and Node 24. |
| Candidate version | Retain current floor. Node 26 may be evaluated as an informational/current-release lane, not silently declared supported. |
| Release date/lifecycle | Node 22 ends 2027-04-30; Node 24 ends 2028-04-30; Node 26 started 2026-05-05 and is scheduled for LTS on 2026-10-28. |
| Official migration documentation | [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) and [previous releases](https://nodejs.org/en/about/previous-releases). |
| Breaking API/type changes | A floor change affects installation, ESM, globals, fetch/undici, filesystem/subprocess behavior, test tooling, and user support. |
| Runtime behavior changes | Node is the product runtime; any floor/current-line change is user-visible support policy. |
| Node requirements | Current direct candidates do not require raising the floor. Pi explicitly matches 22.19.0. |
| ESM implications | Verify resolution, import attributes, URLs, loaders, subprocesses, and bundled ESM on every required line. |
| Bundling implications | esbuild/tsx binaries and bundle execution must be tested per required line. |
| Schema implications | None directly; JSON/Unicode/runtime behavior must remain stable. |
| Tool/session API implications | Fetch, AbortSignal, streams, events, subprocesses, and filesystem APIs underpin Pi sessions and tools. |
| Security advisory effects | Supported Node lines receive different security maintenance windows. Do not retain an EOL line or claim an untested current release. |
| Expected lockfile impact | No lockfile impact from retaining the policy. Engine changes must not be hidden inside another dependency PR. |
| Required tests | Full suite, installed package, bundle/tarball, brownfield/greenfield, schema/tool policy on exact minimum and current supported versions. |
| Decision | **No engine change approved.** Decide explicitly in #65 after all dependency groups. |

## Isolated lockfile simulations

| Simulation | Added | Removed | Changed | Interpretation |
| --- | ---: | ---: | ---: | --- |
| TypeScript 7.0.2 + Node 24 types | 20 | 0 | 3 | Adds native/platform TypeScript compiler packages; not approved for this cycle. |
| esbuild 0.28.1 + tsx 4.23.0 | 0 | 27 | 28 | Deduplicates tsx's nested esbuild/platform tree into the root candidate. |
| TypeBox 1.3.6 | 0 | 0 | 1 | Root TypeBox only. |
| Pi 0.80.6 pair | 0 | 0 | 0 | Already current. |
| Smithy override removal | 2 | 1 | 0 | Reintroduces another nested 2.2.0 path; requires integrity review. |

Every simulation retained a zero-vulnerability `npm audit --omit=dev` result. Audit output must continue to be treated as investigation evidence, not an instruction to force incompatible upgrades.

## Approved implementation order

The default order remains valid:

1. #60 — TypeScript 6 and Node declaration alignment.
2. #61 — esbuild and tsx.
3. #62 — TypeBox, only after #33.
4. #63 — Pi pair re-evaluation; no-op if still current.
5. #64 — Smithy override/integrity review after the Pi graph is final.
6. #65 — Node engine/support decision last.

The only refinement is that TypeScript 7 is deferred and `@types/node` does not jump to Node 24 while the product floor remains Node 22. This preserves the requested ordering and prevents a type package from changing product support implicitly.

## Mandatory rules for every implementation PR

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

Additional mandatory coverage by group:

- TypeScript: effective config, static schema/tool/session types, minimum/current Node.
- Build tooling: installed CLI, generation pipeline, bundle/source-map/tarball comparison.
- TypeBox: complete schema goldens and validation/error-path fixtures.
- Pi: brownfield/greenfield, providers/auth/models, events/cancellation/cost, execution policy/tool schemas.
- Smithy: clean-cache install integrity and Bedrock/provider paths.
- Node policy: full required matrix on exact minimum and current supported lines.

## Discovery evidence and cleanup

Candidate metadata, publication dates, lockfile-only simulations, and isolated characterization were collected in temporary pull-request CI. The temporary workflow and probe script are discovery instruments only and must not remain in the final PR. The final discovery branch must contain no `package.json` or `package-lock.json` diff.