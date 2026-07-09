---
name: document
description: Capture the institutional knowledge of a completed change so the next agent that touches the same area finds it — writes a feature doc, copies screenshots, and updates the conditional-docs index. Use after a slice is implemented and reviewed.
disable-model-invocation: true
---

# Document

Capture what a completed slice built so the **next** agent in this area can load it via
``<agentify-state-dir>/conditional_docs.md``. This is the **learn** step of the feedback loop — it is how the
codebase's comprehension compounds instead of resetting each change.

## Workflow

1. Find the spec (`specs/<type>-<slug>.md`, derived from the branch). Read the diff
   (`git diff <base> --stat`, then per-file for files with > 50 lines changed).
2. Read the `ReviewResult` (`app_review/<branch>/*.json`) if present; pull its screenshot
   list. Copy screenshots from `app_review/<branch>/<id>/review_img/*.png` to
   `app_docs/assets/<branch>-<NN>_<descriptive>.png`.
3. Write the feature doc to `app_docs/feature-<branch>-<slug>.md` (Overview, Screenshots,
   What Was Built, Technical Implementation, How to Use, Tests).
4. **Update ``<agentify-state-dir>/conditional_docs.md``:** append an entry for the new doc with 2–4
   conditions under which the next agent should load it.
5. **Update `app_docs/agentic_kpis.md`:** append a row to the per-run table (date, branch,
   change type, attempts, spec size, diff size).
6. Report: feature-doc path, the conditional-docs line, the KPIs row.

## Rules

- Document what was built, not what might be. Lift from the spec, the diff, and the
  review — do not invent capabilities.
- Conditions are how the next agent finds this; make them specific (a feature name, a
  file area, a keyword), not "when working on the app".
