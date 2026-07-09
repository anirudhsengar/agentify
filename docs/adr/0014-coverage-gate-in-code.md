# ADR 0014: Coverage gate enforced in code

Status: Accepted

## Context

The builder prompt promises "no partial success": AGENTS.md and the
agentic surface should only be emitted once all ten coverage
dimensions of the codebase map are `covered`. Originally this was
enforced only by the prompt. The post-run success check
(`readFinalAuditState`) decided success purely from the existence of
`AGENTS.md` and two README files, and fabricated a full-coverage
summary regardless of the actual map. A prompt-only gate meant a
partial audit could still trigger harness export and scaffold install,
and the run log recorded coverage the map did not have.

## Decision

Success is decided from the **validated codebase map on disk**, not
from file existence. `readFinalAuditState` reads
`<stateDir>/codebase_map.json`, validates it against the schema, and
computes the real `coverage_summary`. A run is `success` only when:

1. the map exists and validates,
2. `coverage.gap` is empty (all ten dimensions `covered`), and
3. the always-on artifacts (`AGENTS.md`, `specs/README.md`,
   `ai_docs/README.md`) exist.

Otherwise the status is `partial` and no export or scaffold install
runs. The reported coverage numbers come from the map.

The final map is preserved as a managed artifact under
`.pi/agentify/` instead of being deleted on every run, so the audit
trail survives and recovery can inspect prior progress. Cleanup of the
transient draft/history happens, but the canonical map is kept on
success.

## Consequences

- The "no partial success" contract is now enforced mechanically.
- AGENTS.md's pointer to the codebase map resolves, because the map is
  persisted.
- Coverage in the run log reflects the real map.
