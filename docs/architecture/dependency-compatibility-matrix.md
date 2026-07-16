# Dependency compatibility matrix

Status: final implementation record for Issue #34  
Last updated: 2026-07-16

This file records the approved dependency and runtime-support state and the evidence for each isolated implementation group. The original 2026-07-12 discovery analysis remains available in repository history. Completed groups may change only their owned manifest, lockfile, configuration, documentation, and characterization surfaces.

## Current decisions

| Group | Baseline | Final decision | Status | Issue |
| --- | --- | --- | --- | --- |
| TypeScript and Node declarations | TypeScript 5.9.3; root `@types/node` 22.19.21 | TypeScript 6.0.3; root `@types/node` 22.20.1 | **Implemented; Node 22 declaration line retained** | #60 |
| esbuild and tsx | esbuild 0.25.12; tsx 4.22.4 | esbuild 0.28.1; tsx 4.23.1 | **Implemented as one build-tooling group** | #61 |
| TypeBox | direct 1.2.9; Pi nested 1.1.38 | direct 1.3.6; Pi nested 1.1.38 | **Implemented; schema and tool contracts retained** | #62 |
| Pi runtime pair | 0.80.6 / 0.80.6 | 0.80.7 / 0.80.7 | **Implemented atomically; runtime contracts retained** | #63 |
| Smithy integrity override | root 4.4.7 plus shrinkwrapped nested 2.2.0 | retain root override 4.4.7; document residual nested 2.2.0 | **Completed; integrity protection retained** | #64 |
| Node support | engine `>=22.19.0`; required Node 22.19.0 and Node 24 validation | retain the floor; require exact Node 22.19.0 and a current Node 24 patch; keep Node 22 declarations; make no Node 26 support claim | **Completed; policy retained** | #65 |

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

The package version remains `0.2.1`. No dependency decision in this backlog authorizes a release, tag movement, npm publication, GitHub release, package-export expansion, schema redesign, execution-policy weakening, or implicit Node-floor change.

## TypeScript and Node declarations — #60

TypeScript 6.0.3 and root Node declarations 22.20.1 are implemented as one direct development-dependency group. Obsolete `baseUrl`, wildcard `paths`, and temporary deprecation suppression were removed. Strict ESM/bundler resolution, `types: ["node"]`, the Node 22.19.0 runtime floor, package boundaries, schemas, Pi runtime, Smithy policy, and generated output remain unchanged. The lockfile changed only the two owned direct records.

## esbuild and tsx — #61

esbuild 0.28.1 and tsx 4.23.1 are implemented together because tsx depends on esbuild `~0.28.0`. Root esbuild and its platform packages moved to 0.28.1, tsx moved to 4.23.1, and the previous nested tsx/esbuild platform tree was removed through deduplication. Build options, Node-targeted ESM, source maps, runtime assets, executable startup, package exports, and the 181-file package inventory were preserved in the last complete package baseline.

## TypeBox — #62

The direct dependency is upgraded from resolved 1.2.9 to 1.3.6. Agentify has no supported use of the removed TypeBox 1.3 APIs. The lockfile changes only `node_modules/typebox`; both Pi-controlled copies remain 1.1.38. Complete and partial audit schemas, write-map parameters and identity, model-visible tools, workflow/orchestrator/AIW/webhook/greenfield/state schemas, property ordering, required fields, literals, enums, descriptions, defaults, constraints, static types, validator acceptance/rejection, error paths/order, renderers, generated output, package exports, and unsupported deep-import rejection remain unchanged.

## Pi runtime pair — #63

The post-#62 gate found a newer official compatible pair: `@earendil-works/pi-ai` 0.80.7 and `@earendil-works/pi-coding-agent` 0.80.7, both published 2026-07-14 and both requiring Node `>=22.19.0`. They are upgraded atomically with matching nested `pi-agent-core`, `pi-ai`, and `pi-tui` 0.80.7 packages.

The exact registry-generated lock object was replayed onto post-#62 `main`. No package record was added or removed. The two direct Pi records and three matching nested family records moved from 0.80.6 to 0.80.7. Five existing optional clipboard Linux records gained registry-provided `libc` metadata. No provider SDK, networking, undici, AWS/Smithy, TypeBox, TypeScript, declaration, or build-tool version moved.

Final policy validation on exact Node 22.19.0 and Node 24.18.0 with npm 10.9.2 confirmed clean installs, a valid dependency graph, unchanged direct/nested TypeBox and Smithy topology, byte-identical export/model/session/tool characterization across Pi 0.80.6 and 0.80.7, and zero production vulnerabilities.

## Smithy integrity override — #64

### Decision

Retain the root override at `@smithy/util-buffer-from` 4.4.7. Do not update, narrow, or remove it in this backlog.

### Integrity and provenance evidence

Commit `bf53892336ad69cf3653e7497b391b5b9ddf033e` added the override after the registry-served 2.2.0 bytes stopped matching the existing lockfile integrity. The original lock expected an integrity containing `...DR+AIW5...`; current official registry metadata reports `...DR+ADW5...`. The current 2.2.0 artifact is signed, but it has no SLSA provenance attestation and the byte replacement remains unexplained by an immutable upstream release record.

The retained 4.4.7 artifact was published 2026-07-08 and has:

```text
SHA-1: b500151e92f829535444c7423d4438ea0a206d9a
Integrity: sha512-FJ6my36UZskwn1RTFwTemwIhbx0YmsGlvJxYsEXdA3YFECkCi4hpjfCcwQOMAv57kkw9WrG3BvAheI0x04F+Cg==
Signature key: SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U
Provenance: SLSA provenance v1 attestation
Engine: Node >=18
```

Current official metadata also offers 4.4.9, published 2026-07-14 with signature and SLSA provenance. It depends on `@smithy/core ^3.29.4`, while retained 4.4.7 depends on `@smithy/core ^3.29.2`. Updating would therefore expand the isolated override decision into additional Smithy graph movement without a vulnerability, compatibility, or integrity requirement. Retention minimizes change while preserving a signed, provenance-backed artifact.

### Final graph and validation

The final Pi 0.80.7 graph contains:

- root `@smithy/util-buffer-from` 4.4.7 through the root override;
- one Pi coding-agent shrinkwrapped nested 2.2.0 copy that the root override does not rewrite;
- no additional nested 2.2.0 path under the root `@smithy/util-utf8` graph.

Clean installs on exact Node 22.19.0 and Node 24.18.0 with npm 10.9.2 remained deterministic. `npm ls --all` reported no dependency problems. Dynamic ESM loading of both root and nested buffer packages, UTF-8 and hexadecimal string conversion, ArrayBuffer offset/length conversion, Buffer result identity, and Bedrock client construction produced identical results on both runtimes. The characterization file SHA-256 was `56f751477ecc02937e3d712890f2254913a09a883fafded973006d022270b494`; its embedded stable-result SHA-256 was `13dbfb31e252cf96ef319dcb31da999fc34db64761b56ef22258f4ecfed10afc`. Production audit remained zero vulnerabilities with 230 production, 30 development, 38 optional, and 270 total dependencies.

No manifest or lockfile change is required. Residual risk is the unavoidable Pi shrinkwrap-owned 2.2.0 copy; it remains integrity-pinned in the lockfile and is explicitly documented. A future Pi release that removes that copy should trigger a fresh override-removal review.

## Node support policy — #65

### Decision

Retain policy option 1:

- minimum supported runtime: Node `>=22.19.0`;
- required minimum lane: exact Node 22.19.0;
- required current-supported lane: a current Node 24 patch, validated here on Node 24.18.0;
- declaration policy: root `@types/node` stays on the Node 22 line, currently 22.20.1;
- package-manager policy: npm 10.9.2 is validated on both required runtimes;
- Node 26: no support claim or required lane before a separate explicit approval.

### Official lifecycle evidence

The official Node release schedule places Node 22 in maintenance through 2027-04-30 and Node 24 in LTS/maintenance support through 2028-04-30. Node 26 began its Current line on 2026-05-05 and is not scheduled to become LTS until 2026-10-28. The official distribution index identified Node 24.18.0, published 2026-06-23, as the current Node 24 patch at this decision gate.

### Dependency engine evidence

```text
Agentify package engine                 >=22.19.0
@earendil-works/pi-ai 0.80.7           >=22.19.0
@earendil-works/pi-coding-agent 0.80.7 >=22.19.0
typebox 1.3.6                           no engine field
typescript 6.0.3                        >=14.17
esbuild 0.28.1                          >=18
tsx 4.23.1                              >=18.0.0
@smithy/util-buffer-from 4.4.7          >=18.0.0
```

No completed direct dependency requires raising the product floor. Raising it would exclude supported Node 22 users without providing a compatibility or security benefit. Node 24 declarations remain intentionally excluded because the declaration surface must not imply APIs unavailable at the minimum runtime.

### Final runtime validation

A real clean `npm ci --no-audit --no-fund` ran on both exact lanes and installed 235 packages. `npm ls --all --json` reported no dependency problems. Pi characterization was byte-identical with SHA-256 `82ad06b58125b590fe44e17d784587c77ce6baea6f597afe00f8fa6f1bfb5b3a`; Smithy/Bedrock characterization was byte-identical with SHA-256 `56f751477ecc02937e3d712890f2254913a09a883fafded973006d022270b494`. `npm audit --omit=dev --json` reported zero vulnerabilities on both lanes, with 230 production, 30 development, 38 optional, and 270 total dependencies.

`README.md`, `CONTRIBUTING.md`, `docs/build-and-package.md`, and `docs/release-process.md` already state the retained minimum, Node 22/24 validation roles, Node-22-targeted bundle, and package gate accurately. No manifest, lockfile, workflow, release, or changelog change is required for a retained policy.

## Lockfile summary

| Group | Added records | Removed records | Versioned records changed | Other metadata |
| --- | ---: | ---: | ---: | --- |
| TypeScript 6.0.3 + Node 22.20.1 declarations | 0 | 0 | 2 | none |
| esbuild 0.28.1 + tsx 4.23.1 | 0 | 27 | 28 | nested esbuild tree deduplicated |
| TypeBox 1.3.6 | 0 | 0 | 1 | none |
| Pi 0.80.7 pair | 0 | 0 | 5 family records | five existing optional clipboard records gained `libc` metadata |
| Smithy integrity decision | 0 | 0 | 0 | retain root 4.4.7; document residual nested 2.2.0 |
| Node support decision | 0 | 0 | 0 | retain engine and Node-22 declaration policy |

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

Validation must cover exact Node 22.19.0 and a current Node 24 patch. No test, schema, validator, execution policy, package boundary, security control, or migration gate may be weakened. GitHub Actions remain disabled; no hosted workflow may be dispatched or rerun. Release work, tag movement, npm publication, and GitHub releases remain prohibited.
