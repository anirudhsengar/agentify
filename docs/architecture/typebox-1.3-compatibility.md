# TypeBox 1.3 compatibility record

Status: implemented for Issue #62  
Implementation date: 2026-07-15  
Direct dependency: TypeBox 1.3.6  
Minimum runtime: Node 22.19.0

## Decision

Agentify upgrades only its direct TypeBox dependency from resolved 1.2.9 to 1.3.6. The exact TypeBox 1.1.38 copies nested beneath the paired Pi 0.80.6 runtime packages remain unchanged.

This is a dependency compatibility update, not a schema redesign. No public schema, validator, tool parameter, write-map contract, façade export, package boundary, or runtime behavior is intentionally changed.

## Official compatibility review

TypeBox 1.3 removes deprecated `Base`, `Awaited`, `Promise`, `AsyncIterator`, `Iterator`, and `Value.Mutate` APIs and changes compiler/reference and future TypeScript inference internals. Repository inspection found no supported Agentify import of the removed APIs.

The migration therefore requires contract characterization rather than source adaptation. Validation, compilation, references, defaults, cloning, repair, error paths, Unicode handling, and static inference can change even when JSON schema serialization appears stable.

## Frozen contracts

The implementation preserves:

- serialized JSON schema structure and keyword values;
- required and optional property sets;
- literals, enums, bounds, constraints, descriptions, and references;
- static TypeScript assignability for audit maps and write-map inputs;
- validator acceptance and rejection behavior;
- error paths and model-visible tool parameter schemas;
- stable audit-schema façade exports and object identity;
- write-map full and delta parameter schemas;
- Pi session and tool construction boundaries; and
- generated bundle and installed-package boundaries.

## Lockfile isolation

The expected and accepted lockfile change is one direct package record:

```text
node_modules/typebox: 1.2.9 → 1.3.6
```

The following remain frozen:

```text
@earendil-works/pi-ai                         0.80.6
@earendil-works/pi-coding-agent               0.80.6
Pi nested typebox copies                       1.1.38
TypeScript                                     6.0.3
@types/node                                    22.20.1
esbuild                                        0.28.1
tsx                                            4.23.1
@smithy/util-buffer-from override              4.4.7
engines.node                                   >=22.19.0
```

No package record is added or removed, and no production dependency outside the direct TypeBox record is permitted to move.

## Validation

The isolated candidate was installed and checked on exact Node 22.19.0 and Node 24.13.1.

The validation surface included:

- clean `npm ci`;
- repository typecheck under TypeScript 6.0.3;
- production ESM build;
- static schema compatibility fixtures;
- schema composition and object-identity characterization;
- schema ownership and dependency-boundary tests;
- every available schema, write-map, validation, and tool-focused test in the reconstructed checkout;
- production dependency audit;
- package packing and inventory review; and
- installed CLI identity, version, help, inventory, and deep-import rejection checks.

The packed package remains 181 files. No raw `src/`, test, temporary, nested tarball, or release-scratch surface is introduced. Production audit remains at zero known vulnerabilities.

## Non-goals

This issue does not:

- change Pi runtime packages or their nested TypeBox copies;
- adopt a new schema design or weaken any validator;
- change TypeScript, Node declarations, esbuild, tsx, Smithy, or the Node engine;
- change package exports or publish a release; or
- authorize GitHub Actions execution, npm publication, GitHub release creation, or tag movement.

## Follow-up order

After this implementation, the dependency backlog continues with:

1. re-evaluate the closed Pi runtime-pair issue #63;
2. decide the Smithy override disposition in #64;
3. decide the Node engine and support policy in #65; and
4. close parent #34 only after every decision and gate is recorded.
