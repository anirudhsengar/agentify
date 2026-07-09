# ADR 0020: Provider-scoped audit state directory

Status: Accepted (2026-07-09)

## Context

agentify originated as a Pi extension called "GreenField." Every
internal path was therefore hardcoded under `.pi/agentify/...`.
When the packaging changed (ADR 0008, accepted 2026-07-09)
agentify became a standalone npm package — but the `.pi/` prefix
was kept. Then the picker (ADR 0018) introduced a UI for
selecting the harness target at runtime, supporting ~73 coding
agents (Claude Code, Codex, Pi, Cursor, OpenCode, Windsurf, …).

The combination breaks the implicit invariant: a user picking
Claude Code expects the audit to write under `.claude/...`, not
`.pi/...`. The hardcoded `.pi/agentify/` directory is a relic
of the Pi-extension era and now creates user-visible friction
whenever a Claude-Code or Codex user inspects their repo.

## Decision

A single source of truth — `src/core/state-dir.ts` — resolves
the audit's state dir from the user's selected targets. The
audit's state and canonical scratch surface (codebase map,
managed manifest, formation / greenfield-state, sub-agent
logs, feature agents, expert directories, workflow specs,
skill extensions, conditional docs) now live under that
resolved state dir.

### Dispatch rule

When the user picks multiple targets, one state dir owns the
audit. Precedence (`claude > codex > pi > universal`):

| Selected target(s)              | State dir (relative)        |
|---------------------------------|-----------------------------|
| `claude-code` in pick            | `.claude/agentify/`         |
| `codex` in pick (no `claude`)   | `.agents/agentify/`         |
| `pi` in pick (no others)        | `.pi/agentify/`             |
| only non-premium `additionalAgents` | `.agents/agentify/`   |

The per-harness output dirs (`.claude/agents/`, `.codex/agents/`,
`.codex/agents/*.toml`, `CLAUDE.md`, `.pi/skills/`,
`.agents/skills/`, `.claude/skills/`, …) are unchanged — they
remain the registry-driven fan-out destinations driven by
`artifact-exporters.ts`.

### Constants that moved to functions

- `MANIFEST_RELATIVE_PATH` → `manifestRelativePath(stateDir)`
- `CODEBASE_MAP_RELATIVE_PATH` → `codebaseMapRelativePath(stateDir)`
- `GREENFIELD_STATE_RELATIVE_PATH` → `greenfieldStateRelativePath(stateDir)`
- `GREENFIELD_FORMATION_RELATIVE_PATH` → `greenfieldFormationRelativePath(stateDir)`
- `MANIFEST_RELATIVE_PATH` and friends are kept as
  `@deprecated` aliases pointing at the legacy `.pi/agentify/`
  path for backward compatibility.

### LLM-facing prompts

`builder.md` and `audit/prompts/explorers/*.md` use the literal
placeholder `<stateDir>` for every audit path reference.
`loadBuilderPrompt(stateDir)` and `readSubagentPrompt(mode,
stateDir)` substitute the resolved state dir at runtime.

### Migration handling (read-only, no auto-migrate)

`resolveCanonicalStateDir(cwd, targets, additionalAgents)`:

1. If the *new* resolved dir already exists on disk, use it.
2. Otherwise, if `.pi/agentify/` exists on disk, return it and
   set `legacy: true`. The audit logs one info line so the user
   knows to move files.
3. Otherwise, return the new dir (the audit creates it on first
   write) and set `legacy: false`.

The audit does **not** auto-copy or auto-delete legacy files.
After the first successful apply, the next run returns
`legacy: false`. Users reclaim disk space with
`mv .pi/agentify <newStateDir>` (or `rm -rf .pi/agentify`) when
ready.

### Manifest schema change

`ManagedManifest` gains an optional `state_dir: string` field
recorded at apply time. New manifests always carry it; legacy
manifests read without it (the read path falls back to
`LEGACY_PI_STATE_RELATIVE_DIR`).

### Scaffold script discovery

`scaffold/.github/scripts/resolve-state-dir.sh <repo_root>` is
a one-liner that inspects candidate manifests in
priority order (`.agents/agentify/`, `.claude/agentify/`,
`.pi/agentify/`) and prints the resolved state dir. Scaffold
shell scripts (`refresh-managed-manifest.mjs`,
`validate-refresh-surface.sh`, etc.) consult it instead of
hardcoding `.pi/agentify/`.

## Implementation

- New: `src/core/state-dir.ts` — single source of truth.
- New: `tests/core/state-dir.test.ts` — 14 checks covering
  precedence, legacy detection, and the canonical fallback.
- New: `scaffold/.github/scripts/resolve-state-dir.sh` — bash
  helper used by scaffold scripts.
- New: `docs/adr/0020-provider-scoped-state-dir.md` (this file).
- Threaded through every state-touching module:
  `manifest.ts`, `greenfield-state.ts`, `greenfield-artifacts.ts`,
  `write-map-tool.ts`, `spawn-explorer-tool.ts`, `run-agentify.ts`,
  `repo-status.ts`, `artifact-exporters.ts`,
  `artifacts/renderers.ts`.

## Consequences

### Behavior changes

- A user picking Claude Code / Codex writes the canonical map,
  managed manifest, and audit-state under their chosen
  provider's dotdir. Per-harness skill/agent exports still
  fan out to `.claude/agents/`, `.codex/agents/`, etc.
- The `exportPi` skill-dir bug (it wrote to `.agents/skills/`
  rather than Pi's `.pi/skills/`) is fixed as a side effect:
  Pi now gets its skill pack at `.pi/skills/` and the
  `writtenDirs.add(".pi/skills")` dedup entry matches what's
  actually on disk.

### Risks

1. **Sub-agent-registry walks up from cwd.** With
   state-dir parameterization the walker accepts the resolved
   state dir and probes that prefix first; legacy `.pi/`
   bases are checked as a fallback for backward compat with
   partially-migrated repos.
2. **Subagent discovery in monorepos.** Walking up `cwd` for
   the nearest `<stateDir>/agents/` could shadow the user's
   project if a parent directory happens to have a different
   state dir. Mitigation: callers pass an explicit `stateDir`
   to the registry; the walker only inspects that prefix plus
   the legacy fallback.
3. **`.pi/skills/` (Pi's skillsDir) vs `.pi/agentify/` (audit
   state dir).** Distinct paths; both can coexist under the
   same dotdir. No collision.
4. **`state_dir` field absent on existing manifests.** The
   read path tolerates absence and falls back to the legacy
   path.

### Affected test surface

- `tests/core/state-dir.test.ts` (NEW)
- `tests/audit/builder-prompt-state-dir.test.ts` (NEW) — guards
  the source prompt against hardcoded `.pi/agentify/` literals.
- Existing tests using `ExpertRegistry.fromCwd(cwd)`,
  `inspectAgentifyRepoState(cwd, configDir)`,
  `findNearestProjectAgentsDir(cwd)`, etc. continue to work
  with default `stateDir = ".pi/agentify"` (preserved by the
  optional parameter). Migration of those tests to an explicit
  state dir is a follow-up.
- Test fixtures using `path.join(cwd, ".pi", "agentify")`
  keep working under the legacy default; the next fixture
  refresh will thread state dirs explicitly.

## Open questions

- Should the legacy dir be auto-deleted after the first
  successful apply (the audit currently logs a one-liner and
  leaves the file in place)?
- Should the audit ship a `agentify migrate` subcommand that
  performs the copy described in the migration section of
  the original draft? Currently left as a follow-up.

## Related ADRs

- [0008 — One package, two entry modes](./0008-one-package-two-entry-modes.md):
  the Pi extension → standalone package transition that
  preceded this ADR.
- [0014 — Coverage gate in code](./0014-coverage-gate-in-code.md):
  references to `.pi/agentify/codebase_map.json` update to
  `<stateDir>/codebase_map.json`.
- [0018 — Codable harness targets](./0018-codable-harness-targets.md):
  the picker mechanism that introduced the per-user target
  dimension this ADR resolves.
