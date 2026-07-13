# Agentify state lifecycle

Agentify selects an audit-state destination from the user's current harness targets:

- Claude Code: `.claude/agentify/`
- Codex and universal targets: `.agents/agentify/`
- Pi: `.pi/agentify/`

The historical location is `.pi/agentify/`. It remains Pi's canonical state
directory when Pi is selected. For non-Pi selections, Phase A detects old state
whose manifest predates provider-scoped `state_dir` metadata and keeps using that
legacy tree temporarily. It reports the exact compatibility source and the
provider-selected future destination once per command. Phase A does not move,
merge, overwrite, or delete either tree.

The complete retirement and migration contract is in
`docs/migrations/legacy-state-retirement.md`.

## Read-only layout detection

Before attach, recovery, status, revert, brownfield, or greenfield work uses
state, Agentify inspects the known state directories without writing:

- `.claude/agentify/`
- `.agents/agentify/`
- `.pi/agentify/`

The classifier uses `lstat`, does not follow symlinks, and distinguishes empty,
legacy-only, canonical-only, identical dual, divergent dual, partial,
unreadable, permission-denied, user-owned, and symlink-unsafe layouts. Tree
fingerprints are deterministic and exclude volatile metadata such as mtime and
inode numbers.

Unsafe, unreadable, permission-denied, and user-owned paths stop the command.
Divergent legacy and canonical trees also stop before state or repository
writes. Agentify never chooses between divergent trees by timestamp, provider
priority, or directory enumeration order.

## Phase A compatibility rules

| Layout | Phase A behavior |
| --- | --- |
| no state | Use the provider-selected destination. |
| Pi selected with `.pi/agentify` | Treat `.pi/agentify` as Pi canonical state; do not call it legacy. |
| legacy-only for a non-Pi selection | Continue reading and writing the legacy source, name the future destination, and state that nothing was moved or deleted. |
| canonical-only | Use canonical state and do not fall back to another provider tree. |
| identical legacy and canonical | Use canonical, retain legacy, and report the duplicate once. |
| divergent legacy and canonical | Stop before writes and require explicit user resolution. |
| partial state | Name the exact tree and continue only through the existing compatibility/recovery path. |
| unsafe or unreadable state | Stop without treating the path as absent. |

A manifest at `.pi/agentify/` whose `state_dir` explicitly identifies
`.pi/agentify` is Pi canonical state. Selecting Claude or Codex does not
reinterpret it as pre-provider-scoping legacy state. Provider switches use the
newly selected destination and report other occupied provider trees rather than
reading them as fallback.

## Command ownership

Supported command paths carry an explicit state directory:

- attach and partial recovery inspect the discovered or selected tree;
- repository status verifies the manifest at that exact path;
- revert discovers the tree containing the manifest and run snapshots;
- brownfield write-map factories, explorer logs, renderers, staging, manifests,
  and transactions share one captured state context;
- greenfield formation, state, manifests, and readiness inspection share one
  captured state context.

Deprecated singleton write-map tools, renderer setters, and legacy manifest
wrappers remain available only for compatibility. Maintenance tests prevent
supported production orchestration from depending on them.

## Transaction boundary

Normal provider-scoped brownfield runs use a repository-local transaction under:

```text
.agentify/state-transactions/<run-id>/
├── journal.json
└── backup/
```

The journal is written atomically with mode `0600` and records the source,
destination, prior-state presence, run ID, and lifecycle phase:

```text
prepared
  → backup_created
  → destination_ready
  → committed
```

For Phase A legacy fallback, source and active destination are both the existing
`.pi/agentify/` tree. Agentify copies that tree to transaction-owned backup
storage for rollback while leaving the active source in place. A failed or
interrupted run restores the backup; a successful run keeps the updated legacy
tree. This is rollback protection, not provider migration.

The cross-provider copy → verify → atomic-install migration is intentionally
deferred to Phase B. Phase A never invokes the older destructive
legacy-to-provider move path.

## Commit and rollback

Agentify commits state only after schema and coverage validation, deterministic
rendering, required-file conflict preflight, staged apply, manifest write, and
repository/project status persistence succeed.

Before the durable commit point, rollback restores the complete prior active
state tree, including maps, manifests, history, logs, snapshots, and unknown
regular files. Repository-facing generated artifacts use a separate ownership
snapshot so user-owned files are not restored from Agentify state.

An interrupted transaction is recovered before a new one begins. Missing,
malformed, or mismatched journals stop execution rather than triggering guessed
cleanup. Recovery is deterministic by run ID and is idempotent.

## Manifest compatibility

A Phase A run that continues at pre-provider-scoping `.pi/agentify/` writes its
manifest without claiming that path as newly selected Pi state. This keeps the
legacy classification stable until Phase B can migrate safely. Normal canonical
runs record their exact provider-scoped `state_dir`.

Old v1 manifests and v2 manifests without `state_dir` remain readable upgrade
inputs. A manifest whose `state_dir` disagrees with its physical location is not
used to silently redirect the command.

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
