# ADR 0018: Codable harness targets — interactive picker + agent registry

Status: Accepted (2026-07-09)

## Context

Before this change, agentify always wrote harness surface files to **all
three** supported targets — Codex, Claude Code, Pi — at the end of a
brownfield audit. The default was hardcoded in
`src/core/agentify-app.ts` as `DEFAULT_TARGETS = ["codex", "claude", "pi"]`.

That meant `.agents/skills/`, `.codex/agents/*.toml`,
`.claude/skills/`, `.claude/agents/*.md`, and `CLAUDE.md` all landed in
the target repo whether the user wanted them or not. Users targeting only
one coding agent ended up with `.codex/` or `.claude/` dotfolders they
didn't ask for — and **all three harnesses auto-loaded the shipped skill
pack** on every session, polluting the session regardless of which harness
the user actually runs.

The user explicitly asked:

1. **Ask which coding agent(s) are targeted** before the audit. Mirror
   the prompt shape of [`vercel-labs/skills`](https://github.com/vercel-labs/skills)
   (`npx skills add … -a/--agent <agents…>`).
2. **Support the full agent registry** that `vercel-labs/skills` supports
   (~73 coding agents), not just the three currently implemented.
3. **Always prompt** — no persistence of the choice, so users stay in
   control of which targets are written each run.
4. **Prompt on greenfield too**, even though greenfield doesn't currently
   export agent surface — keeps the UX consistent.

## Decision

### New modules

- `src/core/agent-registry.ts` — the single source of truth for which
  coding agents agentify supports and where each one expects to find
  its skills. Mirrors `vercel-labs/skills` `src/agents.ts`; surfaces
  `AGENT_REGISTRY`, `isKnownAgent`, `getAgentById`, `getUniqueSkillsDirs`,
  `getPremiumTargets`, and `DEFAULT_AGENT_IDS`.
- `src/core/target-picker.ts` — `promptTargets(ui)` runs the multi-select
  picker against the full registry. Empty selection falls back to the
  three premium targets.

### CLI surface

`src/cli.ts` gains a `--targets <csv>` flag for non-interactive use:

```
agentify --targets claude-code,codex,cursor
```

Comma-separated agent IDs validated against the registry. Unknown IDs
throw with a clear message naming the bad entries.

### New UI method

`AgentifyUi` interface gains `promptMultiSelect(message, choices)`,
returning `ReadonlyArray<string>`. The `ConsoleUi` implementation in
`src/cli.ts` uses a numbered list and accepts `'all'`, `'none'`, or
comma-separated numbers.

### Exporter dispatch

`artifact-exporters.ts::exportAgenticSurface` now accepts an optional
`additionalAgents: ReadonlyArray<string>` parameter. Premium targets
(Codex / Claude / Pi) run through their existing full exporters; non-
premium agents run through a new generic `exportSkillPackToDir` helper
that copies `packaged/skills/<name>` to the agent's `skillsDir`.

A `writtenDirs` set deduplicates writes: if both Codex and Cursor are
selected, `.agents/skills/` is written once, not twice.

### Non-persistence

The picker does NOT persist the user's selection to
`~/.agentify/config.json`. The `AgentifyConfig.targets` field is loaded
for backward compatibility (in case anyone hand-wrote it), but the
picker never writes it. Every fresh run re-prompts.

## Why not persist?

The user explicitly chose fresh-prompt-every-run over persistence. The
trade-off:

- **Persistence (rejected)**: smoother UX for repeat users; one less
  prompt per repo. Down side: users forget the choice was made and are
  confused when `.codex/` files appear in a repo they only wanted to
  target with Claude Code.
- **No persistence (chosen)**: maximum transparency — what you pick is
  what's written. One extra prompt per run. CI users opt out via
  `--targets`.

## Why mirror the full vercel-labs/skills registry?

The user's stated preference was parity with `npx skills add`. The
picker feels complete only if the registry lists every agent the user
might be running. We expose all ~73 entries but only ship exporters
for the three premium targets (Codex / Claude / Pi) — selecting
anything else writes only the skill pack to that agent's directory
via the generic writer. The seam is in `AgentConfig.exportTarget`:
non-null → full exporter, null → generic writer.

## Consequences

- `tests/cli-main.test.ts`, `tests/agentify-core.test.ts`,
  `tests/first-run-picker.test.ts`, `tests/picker-presets.test.ts`,
  `tests/cli-commands.test.ts`, `tests/audit/coverage-gate.test.ts`
  each gain a `promptMultiSelect` stub on their `TestUi` (interface
  conformance only; behavior unchanged).
- Existing tests calling `runAgentify({ targets: ["codex", "claude", "pi"] })`
  continue to work — the new `additionalAgents` field is optional and
  defaults to empty.
- The picker's message lists "Claude Code, Codex, Pi" as defaults so
  the existing three remain the path of least surprise.
- The shipped skill pack now lands in `.pi/skills/`, `.agents/skills/`,
  `.claude/skills/`, AND any additional `skillsDir` the user picks.
  Universal-agent dedup keeps this to a single write per directory.

## Files changed

| Path | Change |
|---|---|
| `src/core/agent-registry.ts` | NEW — registry + helpers |
| `src/core/target-picker.ts` | NEW — picker |
| `src/core/types.ts` | + `isAgentifyTarget`, + `AgentifyUi.promptMultiSelect`, + `AgentifyConfig.targets`, + `RunAgentifyOptions.additionalAgents` |
| `src/cli.ts` | + `promptMultiSelect` impl, + `--targets` parsing, + help text |
| `src/core/agentify-config.ts` | + `readTargets` helper |
| `src/core/agentify-app.ts` | + `resolveTargets` function with picker wiring |
| `src/core/artifact-exporters.ts` | + `additionalAgents` parameter, + generic `exportSkillPackToDir`, + dedup |
| `src/core/run-agentify.ts` | + `additionalAgents` plumbing |
| `tests/agent-registry.test.ts` | NEW — 9 checks |
| `tests/target-picker.test.ts` | NEW — 7 checks |
| 6 existing test files | + `promptMultiSelect` stub on `TestUi` |
| `package.json` | + 2 new tests in `test:unit` |