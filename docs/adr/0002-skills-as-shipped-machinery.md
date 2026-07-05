# ADR 0002: Skills are shipped machinery

Status: Accepted

## Context

agentify has two kinds of agent surface: generic engineering
primitives (how to plan, review, test, fix, write specs) and
codebase-specific intelligence (what *this* repo's modules,
conventions, and pitfalls are).

The generic primitives are the same for every repository. Regenerating
them per-repo would waste an audit's budget and produce lower-quality,
non-deterministic copies of things we can ship once and get right.

## Decision

The generic build chain ships as a **skill pack** under
`.agents/skills/`. The audit never regenerates these; it emits only
codebase-specific intelligence (see
[0009](0009-machinery-shipped-intelligence-generated.md)).

Once a skill is edited by agentify (forked from an upstream source),
it becomes agentify-owned and is removed from `skills-lock.json`; the
lock only tracks skills still mergeable with upstream.

## Consequences

- Shipped skills are versioned with the package and reviewed like code.
- The contract test `tests/test-unification-invariants.sh` enforces
  that agentify-owned skills are not tracked in the lock.
- The builder prompt carries an Emission Contract naming which skills
  are shipped so it never shadows them.
