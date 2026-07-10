---
name: review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/PRD asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
tier: core

---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings. When the change is to a runnable app, a third **visual-proof** pass adds screenshots.

agentify uses GitHub Issues and PRs as the default spec source. Fetch referenced issues/PRs with the GitHub CLI when available; otherwise use the local spec/PRD files the user provides.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue or PR references in the commit messages (`#123`, `Closes #45`, etc.) — fetch with the GitHub CLI when available.
2. A path the user passed as an argument.
3. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written: `AGENTS.md` (the audited conventions / pitfalls / path-safety tiers), `CONTEXT.md` (domain language), ADRs under `docs/adr/`, the `/<feature>` specialist for the touched area, and any `CODING_STANDARDS.md` / `CONTRIBUTING.md`.

### 4. Spawn both sub-agents in parallel

Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3.
- The brief: "Report — per file/hunk where relevant — every place the diff violates a documented standard. Cite the standard (file + the rule). Distinguish hard violations from judgement calls. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 4b. Visual proof (only when the change is to a runnable app with UI)

If `AGENTS.md` / the operational surface defines a way to prepare and start the app
(`prepare_app`: reset db, start server, health check) and the diff touches UI, take
visual proof:

1. Prepare the app per the operational surface. If any prepare step fails, record a
   `blocker` and skip the rest of this axis.
2. Use a headless browser (Playwright) to navigate the critical paths and capture 1–5
   screenshots into `app_review/<branch>/<id>/review_img/`.
3. Verify each spec step against the running app; cite the file/line that implements it,
   or log a `blocker` with a proposed fix for any that's missing or wrong.
4. Stop the app and background processes.

Skip this axis entirely (don't invent it) when there is no `prepare_app`, no app URL, or
the change has no UI surface. Findings here use the severity taxonomy below.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

**Severity taxonomy** (for findings, especially visual-proof ones): `skippable`
(cosmetic, ship as-is) / `tech_debt` (worth fixing, track in a follow-up chore) /
`blocker` (spec violation or hard standards violation). Only `blocker` fails the review.

If the context that invoked this review already requires a specific output format — e.g.
agentify's CI review run, which must end in a single `<output>{"verdict": "approve" | "request_changes", "summary": "..."}</output>` block for `.github/scripts/extract-output.sh` to parse — produce the two-axis findings as your analysis, then convert them into that required format as the actual final step. `request_changes` if either axis has a `blocker` (hard violation or unmet requirement); `approve` otherwise. The `## Standards`/`## Spec` markdown above is this skill's own default presentation for interactive sessions, not a replacement for a calling context's explicit output contract.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
