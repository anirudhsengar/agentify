# Agentify state lifecycle

Agentify stores audit state under the dot-directory family selected by the user's
premium harness targets:

- Claude Code: `.claude/agentify/`
- Codex and universal targets: `.agents/agentify/`
- Pi: `.pi/agentify/`

The historical location is `.pi/agentify/`. When another provider is selected
and only the historical state exists, Agentify migrates that complete tree to
the selected provider location as part of the next successful audit.

## Transaction boundary

A brownfield audit never deletes the current state tree in place. Before the
model session starts, Agentify creates a repository-local transaction under:

```text
.agentify/state-transactions/<run-id>/
├── journal.json
└── backup/
```

The complete existing state tree is renamed into `backup/`. A fresh destination
directory is then created at the provider-selected path. Every later audit
operation runs inside the transaction boundary.

The journal is written atomically with mode `0600` and records:

- source state directory;
- destination state directory;
- whether prior state existed;
- transaction run ID;
- lifecycle phase.

## Lifecycle phases

```text
prepared
  → backup_created
  → destination_ready
  → committed
```

`committed` is the durable commit point. Agentify writes that marker before it
deletes the backup. This ordering ensures a process termination during cleanup
cannot cause recovery to restore obsolete state or delete a successful provider
migration.

## Commit

Agentify commits state only after all of the following complete:

1. the structured map passes schema and coverage validation;
2. deterministic rendering succeeds;
3. required-file conflict preflight succeeds;
4. the staged bundle is applied;
5. the managed manifest is written;
6. repository status and project state are persisted.

After the durable `committed` journal is written, Agentify removes the old backup
and transaction directory. Cleanup is best-effort after the commit point; an
interrupted cleanup is completed automatically on the next run.

## Rollback

Agentify rolls back the state transaction when an audit is aborted, incomplete,
invalid, conflicts on a required file, throws before completion, or fails while
writing the commit marker.

Rollback removes the partial destination and restores the complete prior state
tree, including maps, manifests, history, logs, and any future state files. A
repository that had no previous state returns to having no state directory.

Generated repository-facing artifacts use their own ownership snapshot and
rollback path. State rollback and generated-surface rollback are coordinated but
remain separate so user-owned files are never restored from Agentify state.

## Interrupted-process recovery

`beginStateTransaction` first scans `.agentify/state-transactions/` for unfinished
runs.

- A journal before `committed` is rolled back to its previous state.
- A `committed` journal keeps the new destination and finishes deleting the old
  backup and transaction metadata.
- Missing, malformed, or mismatched journals stop execution rather than guessing.

Recovery is deterministic by run ID and occurs before a new transaction starts.

## Migration rules

A legacy-to-provider migration is attempted only when:

- the provider-selected destination does not already exist; and
- legacy `.pi/agentify/` state exists.

If both source and destination are occupied, Agentify refuses to overwrite either
location. The user must resolve the ambiguity explicitly.

On migration rollback, legacy state returns to `.pi/agentify/`. On migration
commit, the provider-selected destination remains authoritative and the legacy
location is removed.

## Draft transport

When `write_map` receives an inline map larger than its inline limit, an
explicit per-run tool factory writes the transport file atomically to:

```text
<provider-state-dir>/.agentify/draft.json
```

The directory and final filename are derived from the same provider-scoped
state context. Claude and universal/Codex runs therefore do not create, read,
or overwrite a `.pi/agentify/.agentify/draft.json` file implicitly. An existing
legacy draft is left untouched; explicit `map_file` input may still reference
any caller-selected path.

Deprecated singleton tools and the exported `DRAFT_PATH` constant retain the
historical `.pi/agentify/.agentify/draft.json` behavior. Completed `draft.json`
files remain available for inspection or retry, while atomic `.tmp` files are
removed by the successful rename. Draft files are not treated as migration or
restart checkpoints.

## Implementation references

- State-directory resolution: `src/core/state-dir.ts`
- Transaction and recovery: `src/core/state-transaction.ts`
- Brownfield coordination: `src/core/run-agentify.ts`
- State transaction tests: `tests/core/state-transaction*.test.ts`
