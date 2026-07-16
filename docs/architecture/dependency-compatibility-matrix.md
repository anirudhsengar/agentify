# Dependency compatibility matrix

Status: living implementation record for Issue #34  
Last updated: 2026-07-16

This file records the approved current dependency state and the evidence required for each isolated implementation group. The original 2026-07-12 discovery analysis remains available in repository history. Completed groups may change only their owned manifest, lockfile, configuration, documentation, and characterization surfaces; later groups remain frozen until their dedicated decision.

## Current decisions

| Group | Baseline | Final candidate or decision | Status | Issue |
| --- | --- | --- | --- | --- |
| TypeScript and Node declarations | TypeScript 5.9.3; root `@types/node` 22.19.21 | TypeScript 6.0.3; root `@types/node` 22.20.1 | **Implemented; Node 22 declaration line retained** | #60 |
| esbuild and tsx | esbuild 0.25.12; tsx 4.22.4 | esbuild 0.28.1; tsx 4.23.1 | **Implemented as one build-tooling group** | #61 |
| TypeBox | direct 1.2.9; Pi nested 1.1.38 | direct 1.3.6; Pi nested 1.1.38 | **Implemented; schema and tool contracts retained** | #62 |
| Pi runtime pair | 0.80.6 / 0.80.6 | 0.80.7 / 0.80.7 | **Implemented atomically; runtime contracts retained** | #63 |
| Smithy integrity override | root override 4.4.7 plus nested 2.2.0 | retain, update, narrow, or remove after provenance review | **Pending final integrity decision** | #64 |
| Node support | engine `>=22.19.0`; required Node 22.19.0 and Node 24 validation | retain current policy unless final dependency evidence requires change | **Pending final policy confirmation** | #65 |

## Current manifest and important resolved versions

```text
engines.node                              >=22.19.0
@earendil-works/pi-ai                     ^0.80.7 / 0.80.7
@earendil-works/pi-coding-agent           ^0.80.7 / 0.80.7
@earendil-works/pi-agent-core (nested)    0.80.7
@earendil-works/pi-tui (nested)           0.80.7
typebox                                   ^1.3.6 / 1.3.6
typebox (Pi-controlled copies)            1.1.38
typescript                                ^6.0.3 / 6.0.3
@types/node (root)                        ^22.20.1 / 22.20.1
esbuild                                   ^0.28.1 / 0.28.1
tsx                                       ^4.23.1 / 4.23.1
override @smithy/util-buffer-from         4.4.7
@smithy/util-buffer-from (nested)         2.2.0
```

The package version remains `0.2.1`. No dependency implementation in this backlog authorizes a release, tag movement, npm publication, GitHub release, package-export expansion, schema redesign, execution-policy weakening, or implicit Node-floor change.

## TypeScript and Node declarations — #60

TypeScript 6.0.3 and root Node declarations 22.20.1 are implemented as one direct development-dependency group. Obsolete `baseUrl`, wildcard `paths`, and temporary deprecation suppression were removed. Strict ESM/bundler resolution, `types: ["node"]`, the Node 22.19.0 runtime floor, package boundaries, schemas, Pi runtime, Smithy policy, and generated output remain unchanged. The lockfile changed only the two owned direct records.

## esbuild and tsx — #61

esbuild 0.28.1 and tsx 4.23.1 are implemented together because tsx depends on esbuild `~0.28.0`. Root esbuild and its platform packages moved to 0.28.1, tsx moved to 4.23.1, and the previous nested tsx/esbuild platform tree was removed through deduplication. Build options, Node-targeted ESM, source maps, runtime assets, executable startup, package exports, and the 181-file package inventory were preserved in the last complete package baseline.

## TypeBox — #62

The direct dependency is upgraded from resolved 1.2.9 to 1.3.6. Official TypeBox 1.3 documentation describes a low-impact maintenance line that removes deprecated `Base`, `Awaited`, `Promise`, `AsyncIterator`, `Iterator`, and `Value.Mutate` APIs and changes compiler/reference and TypeScript-inference internals. Agentify has no supported use of the removed APIs.

The lockfile effect is exactly one package record:

```text
node_modules/typebox: 1.2.9 -> 1.3.6
```

Both Pi-controlled TypeBox copies remain 1.1.38. Complete and partial audit schemas, write-map parameters and identity, model-visible tools, workflow/orchestrator/AIW/webhook/greenfield/state schemas, property ordering, required fields, literals, enums, descriptions, defaults, constraints, static types, validator acceptance/rejection, error paths/order, renderers, generated output, package exports, and unsupported deep-import rejection remain unchanged.

## Pi runtime pair — #63

The post-#62 gate found a newer official compatible pair: `@earendil-works/pi-ai` 0.80.7 and `@earendil-works/pi-coding-agent` 0.80.7, both published 2026-07-14 and both requiring Node `>=22.19.0`. They are upgraded atomically with matching nested `pi-agent-core`, `pi-ai`, and `pi-tui` 0.80.7 packages.

Official 0.80.7 notes remove the deprecated `OpenAIResponsesCompat.sendSessionIdHeader` and equivalent `models.json` field in favor of `compat.sessionAffinityFormat`; Agentify source and configuration use neither removed field. The release adds cache-friendly dynamic tool loading and `toolChoice`, and fixes OpenRouter session affinity, Bedrock API-key and ambient SigV4 authentication, provider context windows, provider errors, reasoning replay, and Anthropic-compatible missing-usage handling. Agentify retains provider/auth ownership, explicit execution policy, repository confinement, model-visible tools, cancellation, events, and usage/cost behavior.

The exact registry-generated lock object was replayed onto post-#62 `main` to prevent unrelated refresh. No package record is added or removed. The two direct Pi records and three matching nested family records move from 0.80.6 to 0.80.7. Five existing optional clipboard Linux records gain registry-provided `libc` metadata only. No provider SDK, networking, undici, AWS/Smithy, TypeBox, TypeScript, declaration, or build-tool version moves.

Validation on exact Node 22.19.0 and Node 24.13.1 with npm 10.9.2:

- clean offline `npm ci --ignore-scripts --no-audit --no-fund` installed 235 packages on each lane;
- `npm ls --all` reported no dependency problems;
- direct and nested Pi packages resolved to 0.80.7;
- direct TypeBox remained 1.3.6 and Pi-controlled copies remained 1.1.38;
- root Smithy remained 4.4.7 and the residual shrinkwrapped nested copy remained 2.2.0;
- export, provider/model round-trip, function, in-memory session, subscribe/prompt/abort, tool-inventory, and session-stat characterization was byte-identical across Pi 0.80.6 and 0.80.7 and both Node lanes, SHA-256 `82ad06b58125b590fe44e17d784587c77ce6baea6f597afe00f8fa6f1bfb5b3a`;
- `npm audit --omit=dev --json` reported zero vulnerabilities with 230 production, 30 development, 38 optional, and 270 total dependencies.

A complete Agentify source checkout was unavailable in this execution environment, so no new full repository test, production bundle, or tarball result is claimed for this dependency-only transfer. No source, test, schema, validator, security rule, package boundary, engine, export, version, release, or tag is changed.

## Smithy integrity override — #64

The current root override remains 4.4.7 and Pi's shrinkwrap retains a nested 2.2.0. The override was introduced after npm republished 2.2.0 with bytes that no longer matched the recorded lock integrity, so a clean vulnerability audit alone is insufficient evidence to remove it. The final decision must review current registry integrity/provenance, clean installs, root override behavior, residual shrinkwrap copies, Bedrock/provider behavior, buffer conversion, ESM loading, Node 22.19.0 compatibility, package inventory, and audit output. This decision follows the final Pi graph and remains isolated from Node policy.

## Node support policy — #65

The current product policy is engine `>=22.19.0`, exact minimum validation on Node 22.19.0, separate required Node 24 validation, and root `@types/node` aligned with the Node 22 floor. No completed dependency requires a higher minimum. Node 26 is not a supported line without an explicit later approval and complete validation. The final decision must remain separate from dependency upgrades.

## Lockfile summary

| Group | Added records | Removed records | Versioned records changed | Other metadata |
| --- | ---: | ---: | ---: | --- |
| TypeScript 6.0.3 + Node 22.20.1 declarations | 0 | 0 | 2 | none |
| esbuild 0.28.1 + tsx 4.23.1 | 0 | 27 | 28 | nested esbuild tree deduplicated |
| TypeBox 1.3.6 | 0 | 0 | 1 | none |
| Pi 0.80.7 pair | 0 | 0 | 5 family records | five existing optional clipboard records gain `libc` metadata |
| Smithy decision | pending | pending | pending | must remain integrity-driven |
| Node policy | expected 0 | expected 0 | expected 0 | no manifest churn when retained |

## Mandatory validation policy

For every code-changing implementation group and the final parent gate:

```bash
npm ci
npm run typecheck
npm run test:all
npm run test:package
npm run test:security-redteam
npm run test:parity
npm run test:maintenance
npm run test:generated-output
npm run test:generation-pipeline
npm run release:check
npm pack --json --ignore-scripts
npm audit --omit=dev
```

Validation must cover exact Node 22.19.0 and a recorded Node 24 patch. No test, schema, validator, execution policy, package boundary, security control, or migration gate may be weakened to accommodate an upgrade. GitHub Actions remain disabled for this backlog; no hosted workflow may be dispatched or rerun. Release work, tag movement, npm publication, and GitHub releases remain prohibited.
