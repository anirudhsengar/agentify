# GOALS.md / goal-file Format

The same per-unit shape is used at every level: the top-level `GOALS.md`, and every `docs/goals/*.md` file a Goal or Sub-goal escapes into when it splits.

## Top level — GOALS.md only

```md
# {Project name} — Goals

## Final system goal

{1-3 paragraphs: the overall thing being built, from the wide discussion.}

---

# Phase 1 — {Phase name}

## Goal 1: {Goal title}
...

# Phase 2 — {Phase name}

## Goal 2: {Goal title}
...
```

Phases only exist here. Deeper files (one per Goal/Sub-goal that has split) have no Phase headers — just a flat list of unit headings.

## Per-unit fields (Goal or Sub-goal, any depth)

```md
## Goal 1: {Title}
<!-- or: ## Sub-goal 2: {Title}, inside a goal-file -->

**Status:** undrilled | split | prd-ready | planned | queued | implementing | implemented | blocked
**Mode:** Sequential | Parallel after Goal N

### Objective

{1-2 sentences: what this unit achieves.}

### Sub-goals

{Descriptive bullets at whatever detail is known so far — not yet a separate drillable unit. Stays descriptive until a scoped `/drill-me` session decides this unit needs to escape into its own file.}

### Required artifacts

{What this unit must produce.}

### Dependencies

{Other units this one is blocked by, or "None".}

### Definition of done

{How you'd know this unit is actually finished.}

### Spawned

{Links to child goal files, PRDs, plans, issues, specs, PRs, and/or post-launch Discussions this unit has produced, or "None yet".}

### Next action

{One concrete next action for this unit, e.g. "Run `/drill-me 1`", "Pick a Sub-goal in `docs/goals/goal-1.md`", "Review `docs/plans/foo.md`", "Add `agent:implement` to issue #12", or "None".}
```

## Rules

- **`GOALS.md`** holds only the top level (Final system goal + Phase → Goal). The moment a Goal needs Sub-goals, that breakdown moves to its own file — `docs/goals/goal-<N>.md` — never inlined back into `GOALS.md`.
- **Escaping deeper**: if a Sub-goal inside `goal-<N>.md` itself needs to split, its breakdown moves to `docs/goals/goal-<N>/subgoal-<M>.md`. Same pattern, one directory level deeper, however many times it recurses.
- **Status is the user's map.** Set new units to `undrilled`; mark a parent `split` when it escapes into child files; move units through `prd-ready`, `planned`, `queued`, `implementing`, `implemented`, or `blocked` as artifacts and work appear.
- **Next action keeps the workflow humane.** Every unit must tell the user the next useful command or decision. This is how users can drill one Sub-goal, implement it, then return later without remembering the pipeline.
- **Spawned is the single source of truth** for what a unit has produced. Update it the moment a child goal file is written, `/to-prd` returns an issue number, `/to-issues` creates implementation issues, or a post-launch child Discussion gets created — immediately, never batched, never left stale.
