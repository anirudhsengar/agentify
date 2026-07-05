---
name: drill-me
description: Interview the user about the wide project idea, a Goal, or a Sub-goal -- the single entry point for every drilling stage in agentify's pipeline.
argument-hint: "Optional: a Goal number, or a path to a Sub-goal heading. Omit for the wide project discussion."
disable-model-invocation: true
---

# Drill Me

One skill for every drilling stage — the wide project idea (no argument), a Goal (argument = Goal number from `GOALS.md`), or a Sub-goal (argument = path to its heading). Same interview mechanics throughout; what differs is what gets primed beforehand and what happens after.

Initial project formation is terminal-first and checkpointed. Work on one selected unit at a time, persist progress in `GOALS.md` or the relevant `docs/goals/*.md` file, and end each milestone by offering the user the next valid actions.

## Process

1. **Prime**, based on the argument:
   - **No argument** → wide mode. Nothing to read yet; this is where the project's shape gets defined.
   - **A Goal number** → read that Goal's entry in `GOALS.md` (Objective, Sub-goals as descriptive bullets, Dependencies, Definition of done).
   - **A Sub-goal path** → read that heading from its file. The file you're in tells you what this is nested under.
2. **Drill.** Interview the user relentlessly about the scoped idea until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. Ask one question at a time, waiting for feedback before continuing; asking multiple questions at once is bewildering. If a question can be answered by exploring the codebase, explore the codebase instead. In wide mode, run `/domain-modeling` as an active discipline throughout: write resolved domain terms to `CONTEXT.md` immediately and offer ADRs only for decisions that meet its threshold.
3. **Decide what happens next:**
   - **Wide mode** → always run `/to-goals`, then stop at a checkpoint that asks the user which Goal to drill next, whether to stop, or whether to switch to another action. A project is never PRD-sized — there's no "this idea is small enough to skip `GOALS.md`" branch here, unlike every level below it.
   - **Goal or Sub-goal mode** → judge whether this unit is PRD-sized, or needs to split into Sub-goals. State your read and **get explicit confirmation** before acting — this reshapes the file structure under `docs/goals/`.
     - **PRD-sized** → run `/to-prd` (one or more times, as needed — decided here, never predetermined upstream).
     - **Too big** → escape into a new file one level deeper than wherever you are (`GOALS.md` → `docs/goals/goal-<N>.md`; `goal-<N>.md` → `docs/goals/goal-<N>/subgoal-<M>.md`), using [GOALS-FORMAT.md](../to-goals/GOALS-FORMAT.md). Mark the parent `split`, mark children `undrilled`, then stop at a checkpoint instead of auto-drilling every child.
4. **Record.** Update the unit's **Status**, **Spawned**, and **Next action** immediately: in `GOALS.md` at the root, or the relevant goal-file otherwise. Never leave progress only in chat.
5. **Checkpoint.** After each unit reaches PRD, plan, issues, spec, or implementation readiness, ask the user whether to implement the first approved slice, drill another Goal/Sub-goal, or stop.
