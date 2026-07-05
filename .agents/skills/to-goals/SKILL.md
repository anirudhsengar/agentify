---
name: to-goals
description: Break the current wide-discussion conversation into a Phase -> Goal breakdown via a second drilling round, and publish it as GOALS.md.
disable-model-invocation: true
---

# To Goals

Turn a wide, just-drilled discussion into `GOALS.md` — the target repo's top-level map of Phases and Goals.

Run in the **same session** as the wide discussion that preceded it. `CONTEXT.md` and ADRs only capture glossary and hard-to-reverse decisions, not the shape of the whole project — this needs the live conversation, not just what got written down.

## Process

1. Run a **second `/drill-me` round**, scoped to "what are the goals/phases for this project" — a full relentless interview, not a light draft-and-approve. Resolve genuine fuzziness; don't rubber-stamp your own first guess at the breakdown.
2. Group resolved Goals into Phases — sequential or parallel relative to each other.
3. Write `GOALS.md` at the target repo's root using the format in [GOALS-FORMAT.md](./GOALS-FORMAT.md). Set every new Goal's `Status` to `undrilled`, `Spawned` to `None yet`, and `Next action` to the exact `/drill-me <Goal number>` command or dependency note.
4. Stop at a checkpoint. Do not immediately drill every Goal. Present the user with the best next 2-3 choices: drill the first unblocked Goal, pick another Goal, or stop here.

`GOALS.md` holds only the top level. Anything deeper than a Goal belongs to a later `/drill-me` invocation scoped to that Goal or Sub-goal, not here.
