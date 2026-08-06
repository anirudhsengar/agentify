# State lifecycle

Agentify repository state has one authoritative root: `.agentify`.

## Durable and operational state

```text
.agentify/
  manifest.json              durable memory manifest
  agents/                    versioned identities and specialists
  knowledge/                 versioned facts and procedures
  history/                   versioned task and learning events
  policies/                  versioned protected policy
  runtime/audit/             canonical map plus ignored audit history
  state-transactions/        operational recovery journals
```

The audit map is `.agentify/runtime/audit/codebase_map.json`. It is the only
versioned runtime file so installed GitHub workflows receive the same validated
routing evidence as the local installer. Audit history and all other runtime
state remain ignored. Code must use the shared audit-path constant rather than
probing alternative locations.

Upgrades migrate the installer-owned nested ignore rules only when their legacy
bytes are attested by the current memory manifest. A user-owned parent ignore
rule that still hides the canonical map blocks readiness with explicit
remediation instead of silently installing an unusable workflow.

## Ownership

The memory manifest binds state to the canonical repository ID and records
real-byte hashes. Initialization is allowed only when the root is absent, empty,
or covered by a recognized initialization journal. Unrecognized files, unsafe
symlinks, invalid paths, or unexpected bytes block mutation.

Scaffold files use managed markers and expected-byte checks. Unmanaged files are
never overwritten. Conflicting Agentify content is written alongside the occupied
path and reported for explicit maintainer resolution.

## Transactions

Multi-file state changes use deterministic journals. A journal declares expected
input digests, bounded operations, target hashes, and progress. Temporary files
are created exclusively, flushed, and installed atomically where supported.

Recovery validates the journal, manifest, current bytes, repository confinement,
and symlink confinement before completing a transaction. Repeating recovery is
idempotent. Ambiguous state fails closed and is preserved for inspection.

## Version control

Versioned identity, policy, knowledge, history, and the canonical audit map are
committed. Audit history, other runtime data, and transaction journals are
ignored. Automatic learning may update only its explicit allowlist; operational
state never enters a committed learning change.
