# Audit schema domain migration design

Status: contract-freeze and design only  
Issue: #33  
Baseline: `main` at `44a069d3443e2a523ef0597614247cc3d0ce3ac2`  
Implementation gate: issue #32 implementation PRs must merge before the final schema-movement PR is rebased and validated.

## Purpose

This document defines how the audit TypeBox declarations can move from the single
`src/core/audit/schema.ts` owner into cohesive domain modules without changing the
serialized contract, inferred TypeScript types, validation behavior, generated output,
or write-map protocol.

This first change deliberately does **not** move declarations. It freezes the current
contract and records the dependency graph that later movement must follow.

## Frozen contract

The migration treats the following as immutable unless a separate semantic schema
change is approved:

- `CodebaseMapSchema` and `CodebaseMap`;
- `PartialCodebaseMapSchema` and `PartialCodebaseMap`;
- `WriteMapParamsSchema` and `WriteMapParams`;
- `WriteMapDeltaParamsSchema` and `WriteMapDeltaParams`;
- all currently exported evidence and artifact-intent schemas and static types;
- every required and optional property at every object level;
- literals, enums, defaults, descriptions, patterns, and array/string/number bounds;
- validation success/failure, error ordering, keywords, and instance paths;
- schema object identity used by write-map tool definitions;
- existing imports through `src/core/audit/schema.ts`.

The committed `tests/fixtures/audit-schema-contract.json` fingerprints the complete
JSON serialization of all four top-level schemas. Because the current TypeBox output is
stable, the baseline uses exact serialization rather than a normalizer. Any future
normalizer may sort object keys only; it may not drop or rewrite semantic fields.

`tests/audit/schema-contract-characterization.test.ts` freezes representative valid and
invalid runtime behavior. `tests/audit/schema-static-compatibility.fixture.ts` freezes
load-bearing static TypeScript relationships and accepted literal unions.

## Current declaration dependency map

The current declaration order in `schema.ts` already exposes the dependency direction
that extraction must preserve.

| Current declaration group | Direct schema dependencies | Current top-level consumers |
| --- | --- | --- |
| Coverage status and confidence | `StringEnum`, `Type.Object` | coverage matrix, delta params |
| Meta, lifecycle, documentation | local leaf schemas | top-level complete/partial maps, renderers |
| Skeleton | entry-point and topology leaves | top-level complete/partial maps, coverage logic |
| Module graph | edge, workspace, split leaves | top-level complete/partial maps, coverage logic |
| Type/contract surface | type, DB, API, trace leaves | top-level complete/partial maps, compatibility helpers |
| Conventions | naming, error, logging, pattern leaves | top-level complete/partial maps, renderers |
| Pitfalls | category enum and pitfall object | top-level complete/partial maps, coverage logic |
| Validation surface | per-change and CI-gate leaves | top-level complete/partial maps, renderers |
| Operational surface | build/run/deploy/env/workflow leaves | top-level complete/partial maps, candidate renderers |
| Security surface | path, credential, network, damage-control leaves | top-level complete/partial maps, compatibility helpers |
| Customization evidence | custom-tool and skill candidates | complete/partial maps, skills/extensions renderers |
| Expert evidence | expert-domain leaves | complete/partial maps, expert renderers |
| Coverage matrix | dimension status | complete/partial maps, coverage gate |
| Open questions and exploration log | primitive arrays and log entry | complete/partial maps |
| Artifact intents | safe-name/path primitives and intent leaves | complete/partial maps, deterministic renderers |
| Complete map composition | every domain schema | validation, storage, renderers, write-map tools |
| Partial map composition | every domain schema and `COVERAGE_DIMENSIONS` | delta validation and merge tools |
| Write-map parameters | complete/partial maps, coverage enums | `write-map-tools.ts` tool definitions |

### Current façade consumers

Production consumers import through `src/core/audit/schema.ts`:

- `map-storage.ts` — complete map schema/type for persisted state;
- `map-validation.ts` — complete and partial validation;
- `write-map-tools.ts` — complete/partial and parameter schemas plus static types;
- Phase C removal guards — prove deprecated singleton and mutable-state surfaces stay absent;
- `map-defaults.ts` — schema-derived complete-map type;
- `map-coverage.ts`, `map-observability.ts`, and `coverage.ts` — coverage types/constants;
- `schema-compatibility.ts` — schema-derived compatibility input types;
- `src/core/artifacts/renderers/index.ts` and renderer families — complete map,
  artifact-intent types, coverage helpers, and validation.

Test consumers include the schema and write-map characterization suites, renderer and
generation suites, parity helpers, coverage-gate tests, generated-output tests, and the
shared `tests/fixtures/codebase-map.ts` fixture. These imports must remain valid.

## Proposed module graph

```text
src/core/audit/
  coverage.ts                    # existing non-schema algorithm owner
  map-defaults.ts                # existing non-schema algorithm owner
  schema-compatibility.ts        # existing non-schema algorithm owner
  schema.ts                      # stable compatibility façade
  schema/
    primitives.ts
    meta.ts
    skeleton.ts
    module-graph.ts
    type-contract.ts
    conventions.ts
    pitfalls.ts
    validation-surface.ts
    operational-surface.ts
    security-surface.ts
    evidence.ts
    artifact-intents.ts
    coverage.ts
    codebase-map.ts
    write-map-params.ts
    index.ts
```

The suggested `evidence.ts` initially owns both customization and expert evidence.
They share the same composition tier and have no dependency on each other. Split them
later only if their size makes review materially harder.

## One-way dependency direction

```text
TypeBox + StringEnum
        |
        v
schema/primitives.ts
        |
        +-------------------------------+
        v                               v
independent domain/leaf modules     artifact-intents.ts
        |                               |
        +---------------+---------------+
                        v
                 schema/coverage.ts
                        |
                        v
                 schema/codebase-map.ts
                        |
                        v
              schema/write-map-params.ts
                        |
                        v
                  schema/index.ts
                        |
                        v
          src/core/audit/schema.ts façade
                        |
                        v
              algorithms and consumers
```

Rules:

1. Domain modules may import only `primitives.ts` and lower-level domain leaves they
   explicitly compose.
2. Domain modules must not import `codebase-map.ts`, `write-map-params.ts`, `index.ts`,
   or the compatibility façade.
3. `codebase-map.ts` is the only cross-domain composition owner.
4. `write-map-params.ts` may import only top-level map schemas and primitive enums.
5. `index.ts` and `schema.ts` declare no TypeBox schemas.
6. Existing non-schema algorithm modules continue importing schema-derived types from
   the stable façade until a later import-boundary change is justified.
7. No schema module imports a renderer, storage module, write-map tool, or non-schema
   algorithm.

## Stable façade strategy

`src/core/audit/schema.ts` remains the canonical compatibility import path. After the
movement it will:

- re-export the same currently exported schema constants and static types from
  `./schema/index.ts`;
- retain the existing re-exports from `coverage.ts`, `map-defaults.ts`, and
  `schema-compatibility.ts`;
- add no wrapper schemas, clones, intersections, or recomposed duplicates;
- preserve reference identity so `writeMapTool.parameters === WriteMapParamsSchema`
  and equivalent identity checks continue to pass.

Leaf declarations that are currently private may be exported from their owning module
for internal composition, but they must not automatically become façade exports. The
public internal façade inventory is frozen to the names currently exported by
`schema.ts`.

## Static type export strategy

- A schema and its `Static<typeof Schema>` alias live in the same domain module when
  that type is already exported or is needed across modules.
- `CodebaseMap`, `PartialCodebaseMap`, `WriteMapParams`, and
  `WriteMapDeltaParams` remain exported from the façade.
- Existing exported types for customization evidence, expert evidence, artifact
  intents, and feature-agent intents remain façade exports.
- Private leaf types stay private unless a later implementation needs an explicit
  internal import. Extraction is not permission to expand the supported package API.
- Type-only edges use `import type` so runtime initialization follows schema-value
  dependencies only.

## Shared primitives and enums

`primitives.ts` is limited to declarations reused by at least two domain modules or
needed by composition:

- coverage status and confidence;
- safe kebab-case names and repository-relative paths;
- genuinely shared literals/enums that are currently duplicated and can be moved
  without changing serialized output.

A primitive is not a dumping ground. Domain-specific enums remain with their domain.
No enum arrays may be reordered. `COVERAGE_DIMENSIONS` remains owned by the existing
non-schema `src/core/audit/coverage.ts`; schema modules consume that canonical value.

## Cycle avoidance

The implementation must avoid cycles by construction rather than by casts:

- top-level composition never flows back into leaves;
- algorithms remain outside the schema module graph;
- runtime schema values and type-only imports are separated;
- no broad `any`, unsafe assertion, lazy global registry, or duplicate declaration is
  accepted as a cycle workaround;
- the implementation PR adds a maintenance check for forbidden upward imports inside
  `src/core/audit/schema/` before replacing the sole-file ownership rule.

If an unexpected cycle appears, the resolution order is: move a shared leaf downward,
split a type-only contract, or narrow the composition boundary. Duplicating a schema is
not an option.

## Contract normalization

The current baseline uses `JSON.stringify(schema)` exact hashes because ordering is
stable and validation error order is load-bearing. If TypeBox ordering proves unstable
after physical movement, the only permitted normalizer is a recursive object-key sort
used for an additional comparison. It must retain:

- `description`, `default`, `pattern`, formats, bounds, and every other keyword;
- `required` array order;
- enum/union/member order;
- property presence and optionality;
- references and identifiers if introduced;
- array item order.

The exact pre-migration fingerprints remain available to detect a normalizer that hides
real drift. A normalizer may supplement, not weaken, the freeze.

## Golden and compatibility gates

Every movement PR must prove:

1. Exact serialized fingerprints for complete, partial, write-map, and delta schemas.
2. Required and property inventories at all load-bearing composition levels.
3. Enum, literal, default, description, pattern, and bound parity.
4. Valid fixture acceptance and invalid fixture rejection.
5. Validation error count, order, keyword, and relevant instance paths.
6. Static assignability and literal-union compatibility through compile-time fixtures.
7. Tool parameter object identity and write-map protocol parity.
8. Renderer and generated-output parity.
9. Stable façade imports and package deep-import restrictions.

Fixtures must be updated only in a separate semantic-contract PR. A movement PR that
requires a golden update has detected drift and must stop.

## Implemented top-level composition

Issue #55 establishes the planned composition boundary:

- `schema/codebase-map.ts` owns complete and partial audit-map composition;
- `schema/write-map-params.ts` owns `write_map` and `write_map_delta` parameters;
- `schema/index.ts` is the internal re-export boundary and does not redeclare schemas;
- `schema.ts` is a declaration-free stable façade that forwards the original values and types.

The committed serialization, property order, validation errors, static types, parameter
identity, generated output, and package boundaries remain frozen by the existing golden
and characterization suites. Dependency-direction enforcement remains the dedicated
Issue #56 step.

## Ownership and maintenance rules

The existing rule that `src/core/audit/schema.ts` is the sole TypeBox declaration owner
remains in force during the design PR. It is replaced only in the final composition PR,
after declarations have moved and an import-direction maintenance test exists.

The replacement rule will state:

- audit TypeBox declarations live only under `src/core/audit/schema/`;
- each domain file owns its cohesive declaration set;
- `codebase-map.ts` owns complete and partial composition;
- `write-map-params.ts` owns tool parameter schemas;
- `schema.ts` is a declaration-free stable façade;
- semantic schema edits and structural movement must use separate PRs;
- golden drift requires explicit review and fixture regeneration in a semantic change.

## Ordered implementation plan

The declaration graph is broad enough that movement should use ordered sub-issues and
one PR per merged step:

1. **Shared primitives and independent leaves** — add the directory, primitives, meta,
   skeleton, module graph, type-contract, conventions, and pitfalls leaves while
   preserving the façade.
2. **Validation, operational, and security domains** — move the trust-boundary domain
   objects after step 1 merges.
3. **Evidence, artifact intents, and coverage** — move evidence and generated-intent
   declarations plus coverage composition.
4. **Top-level composition, partial map, write-map parameters, and façade** — establish
   canonical composition, preserve all exports, and remove declarations from the old
   file.
5. **Ownership and boundary enforcement** — replace documentation rules and enable the
   schema-module dependency scanner only after the replacement architecture exists.

Before each step: confirm the prior step merged, update from `main`, create a fresh
branch, move only the assigned declarations, run all focused and full gates, open one
PR, and stop.

## Issue #32 coordination

Work may be prepared while #32 is active, but schema movement must not edit legacy state
migration behavior, deprecated API retirement, or write-map storage. The final schema
composition PR must:

1. wait for all issue #32 implementation PRs to merge;
2. fetch the resulting `main`;
3. rebase the schema branch;
4. resolve imports against the final write-map/state architecture;
5. run the complete suite from a clean checkout;
6. report the exact rebased commit and results.

## Validation commands

Each implementation PR runs:

```bash
npm run typecheck
npm run test:all
npm run test:generated-output
npm run test:generation-pipeline
npm run test:maintenance
npm run test:package
npm run test:parity
npm run test:security-redteam
npm pack --json --ignore-scripts
```

Focused runs must include schema serialization, complete/partial validation, static
fixtures, write-map parameter identity, coverage/default behavior, renderer consumption,
import boundaries, and package deep-import restrictions.
