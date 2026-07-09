# ADR 0009: Machinery shipped, intelligence generated

Status: Accepted

## Context

It must be unambiguous which files agentify *ships* (the same for every
repo) and which it *generates* (specific to the audited repo). Blurring
the two makes upgrades unsafe and makes the audit re-do work it should
not.

## Decision

- **Shipped machinery**: the skill pack (`packaged/skills/`) and the
  CI scaffold (`scaffold/`). Versioned with the package.
- **Generated intelligence**: `AGENTS.md`, `specs/README.md`,
  `ai_docs/README.md`, feature agents (`.pi/agents/<feature>.md`),
  experts, and conditional docs. Emitted by the audit from the
  validated codebase map.

The builder prompt carries an **Emission Contract** enumerating the
shipped skills so it emits intelligence only and never re-emits the
generic build chain.

## Consequences

- The audit emits codebase-emergent intelligence only.
- Generated files carry an `agentify:managed` marker so re-runs and
  exporters can tell them apart from user-owned files.
- The contract test asserts the builder prompt contains the Emission
  Contract and states the build chain ships as skills.
