# ADR 0003: Structured output only (TypeBox map)

Status: Accepted

## Context

The audit produces a large amount of structured knowledge about a
codebase. If the builder emitted free-form text and we parsed it, we
would inherit every hallucination and formatting drift the LLM
produced.

## Decision

The builder writes its findings through the `write_map` /
`write_map_delta` custom tools into a single strict TypeBox schema:
the **codebase map** (`src/core/audit/schema.ts`, the only file that
defines the map schema). Every write is validated against the schema
before it is persisted to `<stateDir>/codebase_map.json`.

Downstream artifacts (AGENTS.md, feature agents, experts) are grounded
in this validated map. We never parse free-form LLM text as data.

## Consequences

- `src/core/audit/schema.ts` is the single source of truth for the map
  shape.
- The map's `coverage` block is the completion gate (see
  [0014](0014-coverage-gate-in-code.md)).
- Explorer sub-agent reports are prose today; converting them to typed
  deltas is tracked as future work.
