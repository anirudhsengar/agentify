# ADR 0006: Dual skill discovery (`.agents` + `.claude`)

Status: Accepted

## Context

Different harnesses discover skills in different directories. Pi and
Codex read `.agents/skills/`; Claude Code reads `.claude/skills/`.

## Decision

`.agents/skills/` is the single source of truth. `.claude/skills/` is
a mirror: each entry is a symlink back to the corresponding
`.agents/skills/<name>` directory. The contract test
`tests/test-unification-invariants.sh` verifies the mirror is complete
in both directions.

For a target repository, the artifact exporter copies the skill tree
into whichever harness layouts the user selected.

## Consequences

- Editing a skill is a single edit under `.agents/skills/`.
- A broken or missing mirror fails the contract test.
