# ADR 0022: Non-destructive apply with per-repo `.agentifyrc`

- Status: Accepted (2026-07-09)
- Supersedes: n/a
- Related: ADR 0020 (provider-scoped state dir), the plan at `~/.claude/plans/polished-snacking-valley.md`

## Context

Before this change, agentify treated a conflict at a generated file's
canonical path as a hard error: the run aborted with a list of conflicts
and the user had to manually move or delete their files before re-running.
This was safe but unhelpful — a user with a hand-written `AGENTS.md`
got nothing from agentify, and a user with a single `CLAUDE.md` they
liked could not adopt agentify without first backing up their file.

The new stance (reaffirmed in the brainstorming that produced this
plan) is: **agentify is a tool, not a coding agent.** It should run to
completion, never silently clobber user files, and tell the user what
happened in a clear post-run report. The alongside-write machinery
(Step 1) gives us the mechanism; this ADR documents the policy layer
and the per-repo configuration file that lets users opt into different
behavior when the default is wrong for them.

## Decision

### Default policy: alongside, always

The default `ApplyPolicy` is:

```ts
{
  defaultAction: "alongside",
  requiredAction: "alongside",
  paths: [],
}
```

`alongside` means: copy the staged content to a sibling file with a
`.agentify.<ext>` suffix next to the user's file, leave the user's
file untouched. This applies to *all* tiers — required files
(`AGENTS.md`, the codebase map) and optional files (skills, workflows,
harness exports) — so a user with an existing `AGENTS.md` gets
`AGENTS.agentify.md` next to it and their file is preserved. The
next run sees the same alongside again and behaves identically.

The old "abort on required conflict" behavior is reachable but
opt-in: users who want loud failures can set `requiredAction: "abort"`
in `.agentifyrc`. The default never aborts.

### `.agentifyrc` config file

A new optional file, `agentifyrc.json`, at one of three locations
(discovered in order):

1. `<cwd>/<stateDir>/agentifyrc.json` — provider-scoped, travels
   with the state dir under ADR 0020.
2. `<cwd>/.agentifyrc` — project-root fallback.
3. `~/.agentify/agentifyrc.json` — user-global fallback.

The schema is intentionally minimal:

```json
{
  "schema_version": "1",
  "apply": {
    "defaultAction": "alongside",
    "requiredAction": "alongside",
    "paths": [
      { "pattern": "specs/**", "action": "keep" }
    ]
  }
}
```

`defaultAction` and `requiredAction` accept `"alongside"`, `"keep"`,
or `"abort"`. `paths` is an array of `{ pattern, action }` overrides
where the pattern is a small glob (`*`, `**`, `**/`, literal) and the
first match wins. `requiredAction` is consulted before per-path
overrides for required files.

### Tolerant read

The loader silently drops unknown fields and returns `undefined` for
malformed JSON or unknown `schema_version`. A typo in one location
does not shadow a valid file at another location — the loader walks
the discovery order and returns the first parseable candidate. This
matches the existing `loadAgentifyConfig` convention
(`src/core/agentify-config.ts:87`) so users never see a crash from a
config mistake.

### Post-run report

Every audit that reaches the apply step emits a structured report
after the existing summary line:

```
agentify: apply report: 238 created, 0 kept-user, 0 saved-alongside.
agentify: agentify's versions saved alongside (suffix .agentify.<ext>):
agentify:   - AGENTS.md -> AGENTS.agentify.md
agentify:   - ... and 2 more
```

Conflicts (only reachable when the user sets `requiredAction: "abort"`
or a per-path override to `"abort"`) are listed after the alongside
list with a note about how to resolve them. The report goes through
`ui.info` so it appears in the same channel as the rest of the run's
output.

### Defense hook stays

The `protectedPaths` mechanism
(`src/core/audit/defense-hardening.test.ts`,
`src/core/run-agentify.ts:662-664`) is the in-session guard that
stops the LLM from clobbering user files mid-audit. The alongside-save
is the post-audit complement. Both are needed: the defense hook
catches the builder's mid-session writes, the alongside-save catches
the post-render exporter's writes. A future maintainer should not
think one subsumes the other.

## Consequences

### Positive

- A user with a hand-written `AGENTS.md` no longer blocks agentify;
  the run completes and they get `AGENTS.agentify.md` alongside.
- Re-runs are deterministic: the same alongside path is used every
  time, so the manifest is stable.
- Users can opt into the old loud-failure behavior with a single
  field in `.agentifyrc` (`requiredAction: "abort"`), without
  losing the alongside default for everything else.
- The discovery order respects the state-dir migration (ADR 0020):
  a state-dir-scoped rc travels with the state dir.

### Negative

- Alongside files accumulate in the repo until the user deletes
  them or runs `agentify revert` (planned for Step 5). A future
  `agentify clean` subcommand is a follow-up.
- The default behavior is "always complete, never clobber." Users
  who *want* agentify to fail loudly on conflicts must opt in via
  the rc file. This is a deliberate trade — the tool is more
  usable by default, but the user must know the escape hatch.
- The tolerant loader hides typos. A user who fat-fingers
  `defaultActoin` will get the default behavior and wonder why
  their override isn't taking effect. We accept this trade to
  match the existing config convention; a future `agentify config`
  validation command is a follow-up.

### Neutral

- The manifest schema bumped to v2 to carry `alongsidePath` and
  `preservedSha256`. v1 manifests are still readable (the new
  fields are optional), but `revert` (Step 5) requires v2 because
  it needs `run_id` and the new fields.
- The default policy lives in `src/core/apply-policy.ts` as
  `DEFAULT_APPLY_POLICY`. The rc file is layered on top by
  `resolveApplyPolicy` in `src/core/agentifyrc.ts`.

## References

- `src/core/apply-policy.ts` — `ApplyPolicy`, `DEFAULT_APPLY_POLICY`,
  `alongsidePathFor`, `matchPattern`, `resolveActionForPath`
- `src/core/agentifyrc.ts` — `loadAgentifyRc`, `resolveApplyPolicy`
- `src/core/run-agentify.ts` — `formatApplyReport`,
  `applyStagedBundle` (policy-aware)
- `src/core/manifest.ts` — v2 schema
- `src/core/artifact-exporters.ts`,
  `src/core/scaffold-installer.ts` — writers that return
  `"alongside"` on conflict
- `tests/apply-policy.test.ts` — 16 tests covering alongside naming,
  glob matching, policy resolution, end-to-end manifest interaction
- `tests/agentifyrc.test.ts` — 11 tests covering discovery order,
  tolerant read, precedence, and merge semantics
