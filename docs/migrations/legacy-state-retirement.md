# Legacy state and write-map API retirement design

Status: proposed implementation contract for issue #32  
Design branch: `migration/32-legacy-state-design`  
Scope: compatibility detection, state migration, recovery, and retirement of repository-internal deprecated APIs

## Implementation status — Phase C complete

Phase A detection and Phase B retained-source migration are merged. Phase C now
removes the deprecated callable compatibility layer: singleton write-map tools,
mutable state setters, omitted renderer context, and obsolete manifest,
greenfield, draft, and path wrappers. Supported code uses explicit
provider-scoped factories and contexts.

The following compatibility remains intentionally:

- Pi canonical `.pi/agentify` state;
- safe legacy-layout detection and retained-source migration;
- durable journals, crash recovery, deterministic conflicts, and explicit
  provider switching;
- old v1 and absent-`state_dir` manifest readers needed for installed upgrades;
- schema, generated-output, package-export, symlink, permission, and ownership
  contracts.

Historical inventory tables below describe the pre-removal baseline and the
review gates used to authorize Phase C. They are retained as migration design
evidence, not as a statement that the removed APIs still exist.

## Decision summary

Agentify will retire **cross-provider fallback reads and writes** involving the historical `.pi/agentify` tree. It will not retire `.pi/agentify` as Pi's provider-scoped canonical state directory.

The migration is deliberately staged:

1. **Phase A — detection and deprecation** keeps compatibility behavior intact, detects every fallback use, emits deterministic guidance, and proves the installed CLI and supported runtime use explicit state contexts.
2. **Phase B — atomic state migration** introduces a single state-layout detector and a journaled, no-overwrite migration. The selected provider determines the destination. Legacy source state is retained and is never silently deleted.
3. **Phase C — deprecated API retirement** removes singleton/global write-map and renderer adapters only after all supported callers, tests, scaffold scripts, and operational commands use explicit state contexts.

No phase may select between divergent state trees silently. No phase may follow symlinks, overwrite an occupied destination, discard revert snapshots, change state schemas, or change generated artifact formats.

## Evidence reviewed

This design is based on the current `main` implementation and the compatibility decisions already merged for issues #26, #28, #30, and #31.

- Issue #26 / PR #41 introduced per-run write-map factories and explicit renderer contexts while retaining legacy adapters.
- Issue #28 / PR #44 decomposed write-map storage, validation, coverage, delta, observability, tools, and compatibility ownership without changing the façade.
- Issue #30 / PR #46 established supported, neutral, and experimental module boundaries.
- Issue #31 / PR #43 made draft transport provider-scoped for explicit factories and intentionally left the deprecated singleton pinned to `.pi/agentify/.agentify/draft.json`.
- `AGENTS.md`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/state-lifecycle.md`, `docs/build-and-package.md`, and `docs/release-process.md` define the supported CLI, transaction, ownership, packaging, and release boundaries.
- State-directory, transaction, write-map, draft, attach, recovery, manifest, revert, package, and parity tests were inspected before this policy was written.

## Terminology

| Term | Meaning |
| --- | --- |
| selected provider | Provider chosen from the current target set by `resolveStateDir` |
| canonical directory | Provider-scoped destination selected for the current operation |
| legacy directory | `.pi/agentify` when the selected provider is not Pi |
| Pi canonical directory | `.pi/agentify` when Pi is the selected provider |
| occupied tree | A path that exists and passes path-safety inspection as a real directory |
| safe tree | A non-symlink directory whose ancestors remain inside the repository and pass ownership/type checks |
| identical dual state | Legacy and canonical trees have the same deterministic tree fingerprint |
| divergent dual state | Both trees exist and their deterministic tree fingerprints differ |
| fallback read | Reading `.pi/agentify` because a requested non-Pi canonical file or tree is absent |
| compatibility adapter | Deprecated global, singleton, constant, or path helper retained for old source-checkout callers |

## Current behavior that must be characterized

The existing implementation has two separate compatibility mechanisms.

1. `resolveCanonicalStateDir` selects the provider path when it exists, otherwise returns the legacy `.pi/agentify` absolute path while keeping the selected provider's relative destination.
2. `loadCanonicalMapAt` probes the requested provider map and then independently probes `.pi/agentify/codebase_map.json`.

These mechanisms do not share a state-layout classification. As a result:

- a canonical directory wins whenever it merely exists, without comparing it with legacy state;
- divergent dual state is read from canonical silently;
- an absent canonical map can read a stale Pi map even when another provider was explicitly selected;
- an invalid canonical map returns `null` rather than consistently classifying the legacy candidate;
- attach and status inspection run before target selection and default to legacy manifest paths;
- `agentify revert` resolves with an empty target set, which selects `.agents/agentify` and does not reliably discover Claude or Pi state;
- greenfield resolution uses only the selected relative path and does not participate in the brownfield transaction migration path;
- the current state transaction can move legacy state to a backup and delete that backup after commit, which conflicts with issue #32's requirement not to silently delete legacy state.

The fixture `tests/fixtures/legacy-state-layouts.json` and test `tests/core/legacy-state-layout-characterization.test.ts` freeze these current decisions before implementation changes.

## Deprecated API inventory

### Write-map compatibility façade

Owner: `src/core/audit/legacy-write-map.ts`, re-exported by `src/core/audit/write-map-tool.ts`.

| API | Current behavior | Remaining consumers |
| --- | --- | --- |
| `AGENTIFY_OUTPUT_DIR` | Constant `.pi/agentify` | write-map characterization tests and direct source-checkout callers |
| `MAP_FILENAME` | Constant `codebase_map.json` | write-map characterization tests and direct source-checkout callers |
| `DRAFT_DIR` | Legacy `.pi/agentify/.agentify` | write-map characterization tests |
| `DRAFT_PATH` | Legacy draft path | provider draft tests, write-map characterization tests, direct callers |
| `DRAFT_TRANSPORT_DIR` | Alias of `DRAFT_DIR` | write-map characterization tests |
| `HISTORY_DIR` | Legacy history path | write-map characterization tests |
| `setMapSessionStateDir` | Mutates singleton write-map state | legacy and isolation tests; no supported brownfield orchestration call |
| `canonicalMapPath(cwd)` | Returns legacy map path | write-map characterization tests |
| `loadCanonicalMap(cwd)` | Reads only the legacy map | write-map characterization tests |
| singleton `writeMapTool` | Uses mutable legacy context and legacy draft transport | legacy, draft, coverage, and characterization tests |
| singleton `writeMapDeltaTool` | Uses mutable legacy context | coverage and characterization tests |

Replacement: `createWriteMapTools({ stateDir, mapFilename? })`, its returned paths/tools, and `loadCanonicalMapAt(cwd, stateDir)` after fallback reads are removed from that function.

### Renderer compatibility

Owner: `src/core/artifacts/renderers/context.ts`.

| API | Current behavior | Remaining consumers |
| --- | --- | --- |
| `setRendererStateDir` | Mutates the one-argument renderer default | legacy/isolation tests; no supported brownfield orchestration call |
| omitted render context | Uses the mutable legacy renderer default | compatibility tests and possible direct source-checkout callers |

Replacement: pass `{ stateDir }` as an explicit `RenderContext` to every renderer entry point.

### Manifest compatibility

Owner: `src/core/manifest.ts`.

| API | Current behavior | Remaining consumers |
| --- | --- | --- |
| `MANIFEST_RELATIVE_PATH` | Legacy manifest constant | compatibility surface only |
| `CODEBASE_MAP_RELATIVE_PATH` | Legacy map constant | `repo-status.ts` and compatibility tests |
| `REQUIRED_BROWNFIELD_FILES` | Required set containing the legacy map path | `repo-status.ts` and compatibility tests |
| `manifestPath(cwd)` | Legacy manifest absolute path | `readManifest`, `writeManifest`, tests |
| `readManifest(cwd)` | Reads legacy manifest | `verifyManifest`, tests |
| `writeManifest(cwd, manifest)` | Writes legacy manifest | repo-status/CLI fixtures and compatibility tests |
| `verifyManifest(cwd)` | Verifies legacy manifest | `repo-status.ts`, apply-policy/repo-status tests |

Replacement: `manifestRelativePath`, `codebaseMapRelativePath`, `requiredBrownfieldFiles`, `manifestPathFor`, `readManifestAt`, `writeManifestAt`, and a provider-explicit verification function.

### Greenfield compatibility

| API | Owner | Current consumers | Replacement |
| --- | --- | --- | --- |
| `GREENFIELD_FORMATION_RELATIVE_PATH` | `src/core/greenfield-artifacts.ts` | greenfield compatibility tests | `greenfieldFormationRelativePath(stateDir)` |
| legacy formation read/write wrappers | `src/core/greenfield-artifacts.ts` | tests and possible source-checkout callers | `*At(cwd, stateDir)` variants and explicit tool factories |
| `GREENFIELD_STATE_RELATIVE_PATH` | `src/core/greenfield-state.ts` | greenfield compatibility tests | `greenfieldStateRelativePath(stateDir)` |
| legacy state read/write wrappers | `src/core/greenfield-state.ts` | tests and possible source-checkout callers | `*At(cwd, stateDir)` variants |

### State fallback helpers

These are not all annotated `@deprecated`, but they are part of the retirement backlog.

| API/path | Remaining behavior to retire |
| --- | --- |
| `resolveCanonicalStateDir` | Cross-provider fallback to `.pi/agentify` |
| `isLegacyPiState` | Existence-only probing without a complete safe-layout inspection |
| `loadCanonicalMapAt` | Independent legacy fallback read |
| `inspectAgentifyRepoState(..., stateDir = .pi/agentify)` | Legacy default and legacy `verifyManifest` use |
| `agentify-app.ts` attach/recovery probe | Runs before target resolution and without explicit state context |
| `revertCommand` | Resolves state with an empty target set rather than explicit discovery |
| `greenfield-run.ts` | Ignores the resolved legacy source and has no migration transaction |
| scaffold `resolve-state-dir.sh` and refresh scripts | Shell-side legacy probing and legacy manifest assumptions |

## Legacy path inventory

The following production areas contain a legacy path read, write, fallback, default, or compatibility constant and must be handled explicitly rather than removed by broad search-and-replace:

- `src/core/state-dir.ts`
- `src/core/state-transaction.ts`
- `src/core/audit/map-storage.ts`
- `src/core/audit/legacy-write-map.ts`
- `src/core/audit/spawn-explorer-tool.ts`
- `src/core/manifest.ts`
- `src/core/repo-status.ts`
- `src/core/greenfield-artifacts.ts`
- `src/core/greenfield-state.ts`
- `src/core/runs/brownfield-run.ts`
- `src/core/runs/greenfield-run.ts`
- `src/core/cli-commands.ts`
- `src/core/agentify-app.ts`
- state-aware renderer and exporter compatibility paths
- scaffold state-directory and managed-manifest scripts

Literal `.pi` paths that represent Pi harness output—such as `.pi/agents`, `.pi/skills`, `.pi/prompts`, `.pi/workflows`, and `.pi/extensions`—are not legacy state fallbacks and must not be removed by this issue.

## Test and fixture inventory

Legacy paths and deprecated APIs are intentionally present in:

- `tests/core/state-dir.test.ts`
- `tests/core/state-directory-legacy-characterization.test.ts`
- `tests/core/state-directory-isolation.test.ts`
- `tests/core/state-context-production-ownership.test.ts`
- `tests/core/state-transaction.test.ts`
- `tests/core/state-transaction-commit-recovery.test.ts`
- `tests/core/legacy-state-layout-characterization.test.ts`
- `tests/audit/provider-draft-transport.test.ts`
- `tests/audit/write-map-contract-characterization.test.ts`
- `tests/parity/state-directory-matrix.test.ts`
- `tests/repo-status.test.ts`
- `tests/revert.test.ts`
- `tests/cli-main.test.ts`
- `tests/agentify-core.test.ts`
- `tests/generation-pipeline.test.ts`
- greenfield state/artifact tests
- scaffold state-resolution and manifest-refresh shell tests
- package installed-CLI smoke tests

Phase C must not simply delete these tests. Compatibility tests must first be converted into migration, import-failure, or explicit-context tests. Fixtures that are intended to model an old installed version remain justified upgrade fixtures even after deprecated TypeScript APIs are removed.

## Published-version compatibility

The supported package is the installed CLI; `package.json` exports no TypeScript library API and the tarball excludes `src/`. Therefore deprecated source exports are not supported npm package APIs. They still matter for:

- contributors and tests importing source files directly;
- older checkouts or integrations vendoring repository source;
- installed 0.1.x users whose repositories contain legacy state and manifests;
- scaffold files copied by an older package version into a user repository.

Retirement policy:

1. Phase A ships deterministic warnings and installed-package upgrade tests while the adapters remain.
2. Phase B ships migration and recovery while the adapters remain available to source-checkout consumers.
3. Phase C may remove the adapters only in a later minor release after Phase B has shipped successfully and all removal gates below are met.
4. Old manifest schema versions, absent `state_dir`, and old file formats remain readable for upgrade purposes even after the callable deprecated APIs are removed.

## Canonical destination selection

The destination is derived only from the current explicit target selection:

| Current selection | Destination |
| --- | --- |
| any selection containing Claude | `.claude/agentify` |
| Codex without Claude | `.agents/agentify` |
| Pi without Claude or Codex | `.pi/agentify` |
| non-premium-only selection | `.agents/agentify` |

Existing state does not change destination selection. In particular, finding `.pi/agentify` must never cause a Claude or Codex run to write there after Phase B.

For commands that currently have no target context, such as attach/status/revert, Phase A must introduce explicit state discovery:

1. inspect all known provider state directories safely;
2. accept exactly one valid occupied tree;
3. accept an identical legacy/canonical pair only when the canonical manifest identifies its own `state_dir`;
4. otherwise stop and require an explicit state-directory or target selection;
5. never choose by modification time, manifest timestamp, provider priority, or directory enumeration order.

## Source detection

Phase B will replace existence-only probes with a pure detector that performs no writes.

For each candidate path it must:

1. normalize the repository-relative path;
2. `lstat` every existing ancestor from the repository root to the candidate;
3. reject a symlink at the source, destination, transaction root, or any relevant ancestor;
4. reject non-directory candidate roots;
5. reject paths escaping the repository after lexical and real-path checks;
6. distinguish absent, unreadable, permission-denied, malformed, partial, valid, and user-owned/conflicting state;
7. inventory entries without following symlinks;
8. recognize Agentify ownership evidence, including manifests, known state filenames, transaction journals, and revert run snapshots;
9. retain unknown entries in an Agentify-owned tree rather than deleting them;
10. refuse to migrate a directory that has no Agentify ownership evidence.

A tree fingerprint is computed from sorted repository-relative entries containing entry type, mode, size, and SHA-256 content digest. Volatile metadata such as mtime, inode, and directory enumeration order is excluded. Symlinks make the tree unsafe rather than becoming fingerprint input.

## State-layout policy

| Layout | Approved behavior |
| --- | --- |
| no state | Create/use the selected canonical destination. |
| Pi selected and `.pi/agentify` exists | Treat it as Pi canonical state. No legacy warning or migration. |
| legacy-only, non-Pi destination absent | Emit migration guidance, copy the complete safe legacy tree through the journaled migration, verify it, make canonical authoritative, and retain legacy unchanged. |
| canonical-only | Use canonical. Do not probe or read legacy files. |
| identical legacy and canonical | Use canonical, retain legacy, emit one deterministic duplicate-state message, and never merge or delete either tree. |
| divergent legacy and canonical | Stop before any state or repository write. Show both paths and explicit resolution guidance. |
| canonical path exists but is empty/partial | Classify it; do not silently fall back. If legacy also exists, treat as divergent unless fingerprints are identical. |
| legacy path exists but is partial | Preserve it. Migrate only when Agentify ownership is established and every readable entry can be copied; otherwise stop. |
| unreadable or permission-denied candidate | Stop with the exact path and operation. Never reinterpret it as absent. |
| user-owned file at a state path | Stop. Never replace a file with a directory or move it aside automatically. |
| symlinked source, destination, transaction root, or ancestor | Stop before reads that follow the link and before all writes. |

## Provider-switch policy

Provider switching is distinct from legacy upgrade compatibility.

- **Claude → Codex**, **Codex → Pi**, and **Pi → Claude** must use the newly selected destination.
- A state tree from the previously selected provider is never read as fallback merely because the new destination is absent.
- Automatic legacy upgrade is allowed only for `.pi/agentify` that is classified as pre-provider-scoping legacy state and whose destination is absent.
- A valid Pi manifest whose `state_dir` is `.pi/agentify` is Pi canonical state, not automatically legacy. Switching away from it requires an explicit provider-switch migration decision.
- A provider switch may be migrated only when the source is unambiguous: exactly one safe source tree, destination absent, source manifest/location agree, and the user invoked or confirmed the provider switch through the approved CLI path.
- Multiple provider trees, missing ownership metadata, or disagreement between manifest `state_dir` and physical location stops the operation.
- Non-premium targets share `.agents/agentify` with Codex and therefore do not trigger a Codex/universal migration.

Phase A tests must cover the target transitions without moving state. Phase B tests must cover explicit migration, refusal, restart, attach, and revert for every transition.

## Conflict resolution

Agentify will not merge divergent state trees automatically. State contains manifests, snapshots, history, maps, and future files whose semantic merge cannot be inferred safely.

The actionable resolution surface should support explicit choices without making them defaults:

- continue with canonical after the user archives/moves the legacy tree;
- continue with legacy after the user archives/moves the canonical tree;
- invoke an approved explicit state migration command/flag when exactly one source is chosen and destination is empty;
- inspect deterministic tree-diff output that reports paths and hashes but does not print sensitive file contents.

No `--force` option may overwrite an occupied divergent destination.

## Atomic migration and journal

Phase B should reuse the state transaction primitives but must not reuse the current destructive source-move semantics for legacy retirement.

The migration journal requires:

- schema version and operation kind;
- run ID;
- repository identity/path binding;
- source and destination relative paths;
- source fingerprint captured before copy;
- destination expected-absent assertion;
- candidate fingerprint;
- phase;
- whether the source must be retained;
- creation version.

Approved phases:

```text
prepared
  -> candidate_copy_started
  -> candidate_copy_complete
  -> candidate_verified
  -> destination_installed
  -> committed
  -> cleanup_complete
```

Required ordering:

1. Recover any prior transaction before detecting a new layout.
2. Write and fsync `prepared` before copying.
3. Copy without following symlinks into a run-owned candidate directory under `.agentify/state-transactions/<run-id>/`.
4. Preserve file contents and relevant permission bits. Do not copy sockets, devices, FIFOs, or symlinks.
5. Re-fingerprint source and candidate. Abort if source changed or candidate differs.
6. Recheck that destination is absent and all ancestors remain safe.
7. Atomically rename the verified candidate to destination.
8. Write and fsync `committed` before cleanup.
9. Retain the legacy source unchanged.
10. Remove only transaction-owned temporary data after commit.

The new canonical tree must carry forward manifests, `runs/<run-id>` revert snapshots, previous manifests, history, and unknown regular files. Only explicitly documented transient files may be removed by later run logic.

## Interruption and recovery

Recovery is phase-driven and never guesses.

| Last durable phase | Recovery action |
| --- | --- |
| `prepared` | Remove transaction-owned empty/temp data; leave source and destination unchanged. |
| `candidate_copy_started` | Remove incomplete candidate; leave source unchanged; require destination absent. |
| `candidate_copy_complete` | Verify source is unchanged, then either resume verification or remove candidate safely. |
| `candidate_verified` | Recheck destination absence and resume install, or remove candidate; source remains authoritative until install. |
| `destination_installed` | Verify installed destination fingerprint; if valid, write commit; if invalid, stop without deleting source. |
| `committed` | Keep destination authoritative, keep source retained, and finish transaction cleanup. |
| malformed/missing/mismatched journal | Stop with the transaction path. Do not delete candidate, source, destination, or backup. |

Every failure injection point must be tested with a restart and a second recovery pass proving idempotence.

## Rollback

Before `committed`, rollback removes only paths proven to be transaction-owned by the journal. It never removes or rewrites the legacy source. It may remove a newly installed destination only when:

- the journal proves the destination was absent at start;
- the installed tree fingerprint equals the journaled candidate fingerprint; and
- path-safety checks still pass.

If any assertion fails, rollback stops and reports manual recovery instructions rather than deleting data.

After `committed`, rollback is not permitted. Recovery completes cleanup and leaves both canonical and retained legacy state intact.

## Ownership and symlink protections

Migration must be at least as strict as generated-bundle apply protections.

- Use `lstat`, not `stat`, for migration traversal.
- Never follow a symlink within a candidate tree.
- Reject a symlinked `.agentify`, `.pi`, `.claude`, `.agents`, transaction root, source, destination, or intermediate ancestor.
- Reject replacement of user-owned files/directories at destination.
- Preserve unknown regular files inside a proven Agentify-owned source tree.
- Do not infer ownership from path name alone.
- Permission errors are fatal and are not treated as missing files.
- Logs must not include state file contents, credentials, or full map payloads.

## Attach, recovery, revert, and manifest behavior

Before Phase C:

- `inspectAgentifyRepoState` must require an explicit resolved state context and verify the manifest at that path.
- attach must resolve targets/state before deciding that a repository is ready.
- partial recovery must report which state tree it is recovering.
- greenfield and brownfield must use the same state-layout detector and recovery entry point.
- `revert` must discover or receive the exact state directory containing the selected manifest and run snapshot.
- manifests without `state_dir` remain readable as legacy upgrade input.
- manifests with a mismatched `state_dir` are conflicts, not authority to read another path.
- scaffold scripts must consume explicit manifest state or fail with guidance; they must not independently implement a different fallback precedence.

## User messages and logging

Messages are deterministic and contain paths but not file contents.

Examples:

```text
agentify: legacy state detected at .pi/agentify; selected state directory is .claude/agentify. No state was deleted.
agentify: migrating retained legacy state .pi/agentify -> .claude/agentify (transaction <run-id>).
agentify: state migration committed at .claude/agentify; legacy state remains at .pi/agentify.
agentify: canonical and legacy state are identical; using .claude/agentify and retaining .pi/agentify.
agentify: conflicting state trees found at .pi/agentify and .claude/agentify; no files were changed.
agentify: unsafe state path .claude/agentify: ancestor .claude is a symlink; no files were changed.
agentify: state path .agents/agentify is unreadable: EACCES; no fallback was attempted.
```

Structured logs should record event name, run ID, source, destination, layout classification, fingerprints, phase, result, and error code. They must not record state contents.

Phase A warnings should be emitted once per command execution, not once per file read.

## Temporary compatibility behavior

The following remains temporarily through Phase B:

- `.pi/agentify` as canonical state for Pi;
- read compatibility for old manifest schemas and absent `state_dir`;
- deprecated source-level write-map constants, wrappers, setters, and singleton tools;
- deprecated renderer default/setter;
- deprecated greenfield and manifest wrappers required by old tests/source callers;
- legacy draft behavior for the deprecated singleton only;
- old installed scaffold files as upgrade inputs.

Ordinary explicit factory/context code must not use any of these adapters. After Phase B, legacy probing is confined to the migration detector and upgrade readers, not normal canonical loaders.

## Exact removal gates for Phase C

Deprecated APIs may be removed only when all of the following are true:

1. Phase A and Phase B PRs are merged.
2. At least one released version has shipped detection/deprecation guidance.
3. A released version has shipped atomic migration and recovery.
4. `npm run test:all`, `test:package`, `test:security-redteam`, `test:parity`, and `release:check` pass on the Phase B release line.
5. Supported brownfield and greenfield orchestration use explicit state objects/factories only.
6. attach, status, recovery, revert, manifest verification, scaffold scripts, and installed CLI upgrade tests use explicit state discovery.
7. Code search and a maintenance test prove no supported production import or call of the deprecated APIs.
8. Singleton/global-state tests have been replaced with import/removal guards or retained only as old-version fixture tests that do not import removed symbols.
9. All migration layouts, provider switches, symlink cases, permission failures, manifests, snapshots, and journal interruption points have passing tests.
10. Package deep-import rejection still passes and no new library export was added.
11. Documentation and changelog clearly state what was removed and what file-format compatibility remains.
12. Maintainers approve removal in the Phase C PR; merging Phase B alone does not authorize deletion.

## Phase implementation boundaries

### Phase A — detection and deprecation

- Add the safe, read-only layout classifier without moving state.
- Detect every legacy fallback invocation and emit one actionable warning.
- Make attach/status/revert/provider-switch decisions explicit.
- Add static maintenance guards proving supported orchestration does not use setters/singletons.
- Add installed-package upgrade fixtures representing a 0.1.x repository.
- Keep fallback behavior and deprecated APIs intact.

### Phase B — atomic state migration

- Implement the approved copy-verify-install journal.
- Preserve and carry forward manifests, run snapshots, history, and unknown regular files.
- Retain legacy source state.
- Block divergent, unsafe, unreadable, and user-owned conflicts.
- Add failure injection for every journal phase and restart/recovery tests.
- Integrate brownfield, greenfield, attach, recovery, and revert.

### Phase C — deprecated API retirement (completed)

- Remove singleton `writeMapTool`/`writeMapDeltaTool` exports and mutable map session state.
- Remove `setRendererStateDir` and omitted-context behavior.
- Remove legacy path constants and wrappers that no supported caller needs.
- Remove obsolete fallback helpers from canonical loaders.
- Keep only explicit file-format/old-manifest upgrade readers justified by tests.
- Update architecture, state lifecycle, contributor, release, package, README, and changelog documentation.

## Required test matrix

Every implementation phase must add focused tests in addition to the full validation floor.

- legacy-only state
- canonical-only state
- identical dual state
- divergent dual state
- absent, empty, malformed, and partially written files
- interruption and restart at every journal phase
- repeated recovery idempotence
- Claude → Codex
- Codex → Pi
- Pi → Claude
- non-premium/Codex shared destination
- user-owned conflicting files/directories
- symlinked source, destination, transaction root, and every ancestor family
- permission denied and read-only source/destination/transaction paths
- v1 and v2 manifests, absent/matching/mismatched `state_dir`
- existing `runs/` snapshots and previous manifests
- attach to initialized repositories
- recovery from partial repositories
- revert after migration and after provider switch
- installed CLI upgrade from a packed prior-version fixture
- deprecated API imports before removal and compile/import failure after removal
- no schema fingerprint or generated artifact parity drift

## Validation floor

Each implementation PR must run:

```bash
npm run typecheck
npm run test:all
npm run test:package
npm run test:security-redteam
npm run test:parity
npm run release:check
npm pack --json --ignore-scripts
```

It must also run all focused state-directory, state-transaction, write-map, attach, recovery, revert, manifest, package-upgrade, and migration tests.

## Documentation truth to resolve

Current documentation describes both manual legacy continuation and automatic transactional migration. Phase A must make one behavior authoritative:

- before Phase B: compatibility fallback remains, with explicit deprecation guidance;
- after Phase B: canonical provider state is authoritative, migration is journaled, and legacy state is retained;
- Pi continues to use `.pi/agentify` canonically.

`README.md`, `docs/architecture.md`, and `docs/state-lifecycle.md` must use the same wording and state matrix.

## Non-goals

This issue does not:

- change TypeBox schema semantics;
- change generated artifact formats or renderer output;
- upgrade dependencies;
- decompose schemas further;
- graduate experimental runtimes;
- redesign provider precedence;
- merge divergent state semantically;
- automatically delete retained legacy state;
- remove Pi harness output paths.
