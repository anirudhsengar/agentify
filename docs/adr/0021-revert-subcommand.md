# ADR 0021: `revert` subcommand

- Status: Accepted (2026-07-09)
- Supersedes: n/a
- Required by: ADR 0008 (operational subcommands that mutate the repo need a new ADR)
- Related: ADR 0022 (non-destructive apply), the plan at `~/.claude/plans/polished-snacking-valley.md`

## Context

The alongside-write machinery (Step 1 / ADR 0022) means agentify's
runs now leave `*.agentify.*` files next to the user's originals.
That is the right default — never clobber — but it also means the
user accumulates alongside files over time, and if they decide
agentify's audit was wrong they need a way to roll back. Without a
revert path, the user is stuck either:
- Deleting files by hand and hoping they remember what was theirs
  vs. agentify's.
- Re-running agentify to refresh the alongside set, which makes
  things worse.

This ADR documents the `agentify revert` subcommand: a single-shot
undo for the most recent run, with explicit limits so the user is
never surprised by what gets touched.

## Decision

### Scope: single run, not a history

`agentify revert` undoes the **most recent run only**. It does not
maintain a stack of past runs. A second `revert` on the same
manifest is a no-op (the manifest's `run_id` is the same, the
snapshot is the same, no files move).

Rationale: agentify is a tool, not a version-control system. Users
who want history should use git. Keeping `revert` single-shot makes
the safety story simple — there is exactly one previous state to
consider, and it's the one in `<stateDir>/runs/<run-id>/`.

### What gets reverted

For each file in the manifest, `revert` does exactly one of:

1. **alongside-saved file** (manifest entry has `alongsidePath`):
   delete the alongside file. The user's canonical file was never
   touched, so it stays as-is.
2. **pre-existing user file** (snapshot has the path): restore the
   original content from the snapshot. Mode (file permissions)
   is also restored.
3. **agentify-created file** (no snapshot entry): delete it.

After processing all files, the manifest itself is replaced with
the pre-run manifest (if any) or removed. The `<run-id>/` directory
is left in place for forensic inspection — the user can `ls
.pi/agentify/runs/<run-id>/` to see the snapshot and pre-run manifest.

### Snapshot persistence

Every non-dry-run audit persists two artifacts before the apply
step (see `persistRunArtifacts` in `src/core/revert.ts`):

- `<stateDir>/runs/<run-id>/snapshot.json` — the pre-run
  AuditArtifactSnapshot (every file in the generated surface, base64-
  encoded). ~50KB on a 50-file surface, ~500KB on a 500-file surface.
- `<stateDir>/runs/<run-id>/manifest.previous.json` — a copy of
  the pre-existing manifest, so `revert` can restore the manifest
  itself. Omitted on first-run (no pre-existing manifest).

The same `run_id` is stamped on the new manifest, tying the
snapshot and the new state together. `revert` reads this from the
manifest, not from the filesystem scan, so it always operates on
the run the user expects.

Dry-run (`--plan`) does NOT persist the snapshot. There is nothing
to revert when nothing was applied.

### v1 manifest error

Manifests written before this ADR don't have `run_id` and are not
revertable. `revert` reports a clear error:

> agentify: revert: manifest is v1 (no run_id). Run agentify once
> to upgrade before reverting.

The user runs `agentify` once (any mode) to write a v2 manifest,
then `revert` works. This is a deliberate one-time upgrade cost.

### Subcommand surface

```
agentify revert [--to <run-id>] [--keep-alongside] [--json]
```

- `--to <run-id>`: override the run id from the manifest. Default
  is the manifest's own `run_id`. Useful only for forensics.
- `--keep-alongside`: keep the `*.agentify.*` files (do not delete
  them). Default is to delete. The user's canonical files are
  always restored regardless of this flag.
- `--json`: emit structured JSON to stdout. Default is human-
  readable text with counts and (optionally) the first 8 errors.

Output (text mode):
```
agentify: revert complete
  alongside removed: 1
  user files restored: 0
  agentify-created files removed: 0
  errors: 0
```

Output (JSON mode): `{ alongsideRemoved, userRestored, createdRemoved, kept, errors }`.

### Subcommand registration

Per ADR 0008, `revert` is an operational subcommand that mutates
the repo. It follows the same pattern as `login`/`logout`/`models`:

- `SUBCOMMAND_NAMES` in `src/core/cli-commands.ts:25` includes
  `"revert"`.
- `dispatchSubcommand` in `src/core/cli-commands.ts:775` handles it.
- `runUnknownSubcommand`'s "Known subcommands" string includes
  `revert`.
- `src/cli.ts:209` and `src/core/agentify-app.ts:106` include
  `revert` in their defense-in-depth guards.
- `tests/cli-main.test.ts:343` asserts the "Known subcommands"
  string.

## Consequences

### Positive

- The user has a real undo path. If agentify's audit was wrong or
  the user just wants to start over, `agentify revert` gets them
  back to a clean state.
- The single-shot scope keeps the safety story simple. There is
  no "what if the user reverts twice" question to answer.
- The snapshot persists whether or not the user intends to revert,
  so the option is always available until the next run overwrites
  the `<run-id>/` directory.
- The v1-manifest error is a clean upgrade path: one run, then
  revert works.

### Negative

- The snapshot is per-run, not global. A second `agentify` run
  writes a new snapshot to a new `<run-id>/` directory under
  `<stateDir>/runs/`. The first run's snapshot is still on disk
  but the manifest no longer points at it. To revert to the
  first run, the user would need to use `--to <first-run-id>`
  AND restore the first run's manifest manually. This is a
  known limitation; documenting in the ADR is enough for now.
  A future `agentify revert --to <run-id>` with proper manifest
  restoration is a follow-up.
- The snapshot file is base64-encoded JSON, which adds ~33% size
  overhead vs. raw binary. For a 500-file surface this is ~500KB
  vs. ~375KB. Acceptable.
- The `agentify revert` subcommand mutates the repo, so it is
  gated by ADR 0008's "operational subcommand requires a new ADR"
  rule. This ADR satisfies that.

### Neutral

- The runs/ directory accumulates on disk. A future
  `agentify clean` subcommand is a follow-up (mentioned in ADR
  0022).
- The revert subcommand is single-shot. A future
  `agentify history` or `agentify revert --to <id>` with proper
  manifest restoration is a follow-up.

## References

- `src/core/revert.ts` — `revertLastRun`, `persistRunArtifacts`,
  `newRunId`
- `src/core/cli-commands.ts` — `revertCommand` (line ~690), the
  `REVERT_FLAGS` / `REVERT_TAKES_VALUE` sets, and the four
  "Known subcommands" touchpoints
- `src/core/run-agentify.ts` — `persistRunArtifacts` is called
  before `applyStagedBundle` in both `runBrownfieldAudit` and
  `runGreenfield`
- `src/core/manifest.ts` — v2 schema with `run_id`,
  `alongsidePath`, `preservedSha256`
- `tests/revert.test.ts` — 6 tests covering all three revert
  paths, v1-manifest error, previous-manifest restoration, and
  `--keep-alongside`
- `tests/cli-main.test.ts:343` — the "Known subcommands" string
  assertion
