---
name: to-plan
description: Interview the user about implementation ordering for the current PRD, then write a reviewable PLAN.md.
disable-model-invocation: true
---

# To Plan

Turn a just-synthesized PRD into a reviewable implementation plan. Unlike `/to-prd`, this interviews — sequencing and ordering decisions are exactly the kind of thing that benefits from being asked, not assumed.

Run in the same session as the `/to-prd` that just produced the PRD this plan is for.

## Process

1. **Drill** the user on implementation ordering: which slices come first, what's genuinely sequential versus safe to parallelize, where the risk is concentrated, what's worth validating earliest. One question at a time, with your recommended answer, same as any other drilling round.
2. **Write** `docs/plans/<slug>.md` using the template below. One plan per PRD.
3. Update the current Goal/Sub-goal's `Status`, `Spawned`, and `Next action` immediately.
4. Tell the user the plan is ready for `/to-issues`, which reads a plan exactly like it reads a PRD.

<plan-template>

## PRD

A reference to the PRD this plan is for (issue number or link).

## Ordering

A numbered sequence of implementation slices, each with a one-line rationale for its position — why it's safe to do now, what it unblocks, what risk it retires early.

## Open risks

Anything still uncertain enough that `/to-issues` or implementation should re-confirm, rather than treating this plan as final.

</plan-template>
