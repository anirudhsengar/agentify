# Agentify state lifecycle

Agentify selects canonical audit state from the current harness targets:

- Claude Code: `.claude/agentify/`
- Codex and non-premium/universal targets: `.agents/agentify/`
- Pi: `.pi/agentify/`

The historical `.pi/agentify/` path remains Pi canonical state. For a non-Pi
selection, a safe pre-provider-scoping legacy tree is upgraded with a retained-
source copy → verify → atomic-install transaction. The original legacy tree is
never deleted or overwritten.

The complete retirement contract is in
`docs/migrations/legacy-state-retirement.md`.

## Detection and authority

Before attach, recovery, status, revert, brownfield, or greenfield work,
Agentify recovers interrupted transactions and safely inspects all known state
roots with `lstat`. Symlinked ancestors, unreadable paths, user-owned files,
malformed state, partial sources, and occupied destinations stop before writes.

A provider-scoped manifest whose `state_dir` matches its physical directory is
authoritative. A retained legacy tree may remain beside it and may later differ;
normal canonical readers never probe that retained tree. Two unstamped divergent
trees remain a conflict and are never selected by timestamps or provider
priority.

## Phase B migration policy

| Layout | Behavior |
| --- | --- |
| no state | Use the selected canonical destination. |
| Pi selected with `.pi/agentify` | Use it as Pi canonical state; no migration. |
| safe unstamped legacy-only state with non-Pi destination absent | Automatically migrate to the selected destination and retain legacy unchanged. |
| canonical-only | Use canonical; do not probe legacy. |
| identical unstamped legacy/canonical pair | Use canonical and retain legacy. |
| explicit canonical plus retained legacy | Use the manifest-declared canonical tree even after it changes. |
| divergent unstamped trees | Stop before writes. |
| partial, unreadable, permission-denied, user-owned, or symlinked path | Stop with the exact path and operation. |

Provider switching is separate from automatic legacy upgrade. Claude → Codex,
Codex → Pi, and Pi → Claude require an explicit target plus `--migrate-state`.
The source must be the only safe prior provider tree, its manifest must identify
its physical location, and the new destination must be absent. Non-premium
targets share `.agents/agentify` with Codex and do not require a switch.

## Retained-source transaction

Migration uses `.agentify/state-transactions/<run-id>/` and a schema-versioned
`0600` journal. The durable phases are:

```text
prepared
  → candidate_copy_started
  → candidate_copy_complete
  → candidate_verified
  → destination_installed
  → committed
  → cleanup_complete
```

The complete source tree is copied without following symlinks into a
transaction-owned candidate. File contents, relevant mode bits, manifests,
`runs/` revert snapshots, previous manifests, history, and unknown regular files
are retained. Source and candidate fingerprints must match before install. The
destination and all ancestors are rechecked, then the candidate is atomically
renamed into place.

When a copied manifest exists, the installed canonical copy records the new
`state_dir` and rewrites state-file manifest paths from the old root to the new
root. The source manifest remains byte-for-byte unchanged. The journal records
both the verified-copy fingerprint and the installed canonical fingerprint.

Recovery is phase-driven and idempotent. Before commit, rollback removes only
transaction-owned candidate or destination data whose fingerprint matches the
journal. It never removes or rewrites the source. After commit, recovery keeps
both trees and finishes cleanup. Malformed or mismatched journals stop for manual
recovery instead of guessing.

Normal same-directory brownfield updates continue to use rollback transactions;
the older destructive cross-directory move path is rejected.

## Command ownership

- attach resolves targets/state before readiness and inspects the exact canonical tree;
- partial recovery reports the exact tree;
- repository status verifies only the explicit manifest path;
- revert recovers transactions, discovers the exact authoritative manifest and snapshots, then passes that path explicitly;
- brownfield and greenfield share the same resolver and recovery entry point;
- canonical map and greenfield-formation readers no longer fall back across providers;
- scaffold scripts require one explicit manifest authority, accept one unstamped legacy manifest only as upgrade input, and fail on ambiguity or mismatch.

Deprecated singleton write-map tools, renderer setters, and legacy manifest and
greenfield wrappers remain only for Phase C compatibility gates.

## Manifest compatibility

Old v1 manifests and manifests without `state_dir` remain readable as legacy
upgrade input. A mismatched `state_dir` is a conflict, never a redirect. After a
migration, the canonical manifest names the provider-scoped destination while
the retained source manifest is unchanged.

## Draft transport

Explicit per-run `write_map` factories place oversized draft transport at:

```text
<active-state-dir>/.agentify/draft.json
```

The deprecated singleton and exported `DRAFT_PATH` retain historical
`.pi/agentify/.agentify/draft.json` behavior until Phase C removal gates are
satisfied.

## Implementation references

- Safe layout classifier: `src/core/state-layout.ts`
- State-directory resolution: `src/core/state-dir.ts`
- Explicit manifest verification: `src/core/manifest-verification.ts`
- Transaction and recovery: `src/core/state-transaction.ts`
- Brownfield coordination: `src/core/runs/brownfield-run.ts`
- Greenfield coordination: `src/core/runs/greenfield-run.ts`
- Attach/recovery entry point: `src/core/agentify-app.ts`
- Focused tests: `tests/core/state-layout-detection.test.ts`,
  `tests/core/state-transaction-legacy-preserve.test.ts`, and
  `tests/core/legacy-fallback-guidance.test.ts`
