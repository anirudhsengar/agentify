# ADR 0006: Dual skill discovery (`.agents` + `.claude`)

Status: Accepted (amended 2026-07-09)

## Context

Different harnesses discover skills in different directories. Pi and
Codex read `.agents/skills/`; Claude Code reads `.claude/skills/`.

The dual layout is required in *target* repositories so every supported
harness can discover the shipped build chain regardless of which the
user runs.

## Decision

`.agents/skills/` is the conceptual source of truth for the shipped
skill pack. **The maintainer package (this repo) does not carry
`.agents/skills/` (or `.claude/skills/`) at its repo root.** The skill
pack lives at `packaged/skills/` in the package — a plain (non-dot)
directory that no coding harness auto-scans — so the maintainer's own
coding agent doesn't auto-load every shipped skill on every session.

The installer (`src/core/artifact-exporters.ts`) reads from
`<packageRoot>/packaged/skills/` and writes the dual
`.agents/skills/` + `.claude/skills/` layout into each **target**
repository at install time:

- `exportCodex` → `<cwd>/.agents/skills/<name>/SKILL.md`
- `exportClaude` → `<cwd>/.claude/skills/<name>/SKILL.md`
- `exportPi` → `<cwd>/.agents/skills/<name>/SKILL.md`

The dual-discovery contract in `tests/test-unification-invariants.sh`
step 4 asserts that the maintainer repo carries neither dotfolder;
the installer's mirror behaviour is covered by
`tests/agentify-core.test.ts::testArtifactExporter`.

`src/core/shipped-paths.ts::SHIPPED_SKILLS_SUBDIR` is the single
literal that names the source location; both `artifact-exporters.ts`
and `pi-sdk-runtime.ts` derive from it.

## Why the move

Carrying the shipped skills at `.agents/skills/` (Codex convention)
or `.claude/skills/` (Claude Code convention) at the maintainer
package root causes the maintainer's coding agent to auto-load every
shipped skill on every session. The shipped build chain is meant for
end users of `agentify`, not for the maintainer of `agentify`;
loading it makes the maintainer's own development loop noisier.

Keeping the source at `packaged/skills/` removes that pollution
without changing end-user behaviour: target repositories continue to
receive both layouts exactly as before, via the installer's existing
logic.

## Consequences

- Editing a skill is a single edit under `packaged/skills/`.
- Target repos continue to receive both `.agents/skills/` and
  `.claude/skills/` (dual discovery for the respective harnesses).
- The maintainer `.agents/` and `.claude/` directories are absent;
  per-developer `~/.claude/` settings are still respected, and any
  `settings.local.json` introduced locally is gitignored to avoid
  accidental commits of personal preferences.
- New contributors won't trip over the missing `.agents/skills/` if
  they read `docs/13-repository-layout.md`, which now lists
  `packaged/skills/` as the source location.
