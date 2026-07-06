# Agentify Production Readiness Report

Date: 2026-07-06

## Executive Verdict

Agentify is a serious foundation, not a toy. It already has a coherent
one-command public CLI, a structured brownfield audit, deterministic artifact
rendering, transactional apply/rollback, managed-file manifests, a stamped
GitHub Actions runtime, a shipped skill pack, a defense hook, and a large test
surface.

It does not yet fully satisfy the stated vision of "install agentify, run one
command, and the repository lives on its own with specialized agents, experts,
complex workflows, and an orchestrator." The brownfield bootstrap and
GitHub-label PR loop are real. The expert system, prompt/skill generation, and
orchestrator-led self-management story are only partially connected to the
public product, though generated workflow specs are now injected into the
public implement prompts as routing guidance and issue implementation now runs
a credential-free orchestration-planner pass before the build agent.

My current production-readiness rating is:

- Private dogfood: yes, after fixing the failing docs link.
- External beta: close, but only with clear limitations around experts,
  greenfield, and the orchestrator being internal.
- Public "best agentic engineering tool" release: not yet.

If I had to score it today, I would call it a 7/10 engineering foundation and
a 5.5/10 realization of the full product vision. The gap is not lack of code;
the gap is coherence between the promised agentic surface, the generated files,
and the runtime that actually consumes those files.

## Progress Since Initial Report

The first remediation pass closed several issues found below:

- `npm test` now passes. The missing
  `docs/roadmap/10-10/README.md` link was fixed by adding the roadmap.
- Expert rendering now emits runtime-compatible directories under
  `.pi/prompts/experts/<domain>/` from `grade7_evidence`, including
  `expertise.yaml`, `question.md`, `self-improve.md`, `plan.md`, and
  `plan_build_improve.md`.
- The renderer test now proves generated experts are discoverable through
  `ExpertRegistry.fromCwd()`.
- Brownfield rendering now emits project workflow specs under `.pi/workflows/`
  that connect generated specialists to the canonical
  plan-build-review-fix AIW loop, and the renderer test proves
  `WorkflowRegistry.fromCwd()` discovers them.
- The stamped GitHub implement and implement-PR workflows now render
  `.pi/workflows/*.json` into prompt context, so generated specialist
  workflows influence the public issue/PR loop without giving the model
  GitHub credentials or executable workflow control.
- The issue implementation workflow now runs a separate credential-free
  orchestration planner before the build agent. The planner consumes generated
  workflow, specialist, and expert context, emits bounded structured routing
  JSON, and a trusted script renders that plan into the implementation prompt.
- Generated expert routing context now carries bounded durable knowledge from
  `expertise.yaml`, including key files, key types, patterns, pitfalls,
  conventions, and test paths. The public implement, implement-PR, and review
  prompts therefore receive more than a domain name and file path; they receive
  the expert's concrete invariants and validation hints before the model runs.
- The defense hook now applies zero-access, credential-store,
  protected-path, and repo-jail checks to `write_file` and `multi_edit`,
  not just `write` and `edit`.
- `agent-refresh-surface.yml` no longer hard-codes `main` and `master`; it
  guards against `github.event.repository.default_branch`.
- The refresh workflow now has a consistent git handoff: the model leaves edits
  uncommitted, the trusted workflow commits/pushes/opens the PR, and the
  workflow still opens a PR if the model already committed changes.
- The drill-me issue workflow now requires final structured output, validates
  it with a trusted shell renderer, and posts the success-path issue reply
  itself after any PR work. "No repo file changes" now still advances the
  GitHub conversation.
- `write_map` and `write_map_delta` now return the same D1-D10 closure
  reasons enforced by the final gate, so the builder can send `gap_filler`
  back to the exact weak dimension before the run ends.
- Expert refresh now has deterministic stale detection. The core expert module
  can identify stale domains from `expertise.yaml` timestamps, and the stamped
  refresh workflow writes a stale-experts JSON report before the model runs.
- Expert matching now normalizes absolute and relative touched paths, so
  internal AIW/orchestrator self-improve triggers can actually match generated
  expert domains.
- `spawn_explorer` now enforces hard total-spawn, concurrent-spawn, and
  per-subagent wall-clock budgets instead of relying only on prompt guidance.
- Generated-output tests now include quality fixtures that check fallback
  specialists are actionable, not just present. They verify scope, first files,
  validation commands, pitfalls, shared package boundaries, and user-workflow
  e2e coverage across TypeScript CLI, monorepo, frontend, backend service,
  sparse-test, and domain-doc-heavy maps. They also now score generated
  expert expertise for durable domain knowledge: key files, key types,
  patterns, pitfalls, conventions, test commands, and self-improve discipline.
- Greenfield now writes a TypeBox-validated checkpoint state file at
  `.pi/agentify/greenfield-state.json`, including the current checkpoint,
  completed artifact stages, deterministic next actions, and artifact
  validation reasons.
- Greenfield scaffold installation now depends on a code-enforced substance
  gate. Placeholder/thin `CONTEXT.md`, `GOALS.md`, PRD, plan, issue, or spec
  artifacts leave the run `partial`, record validation reasons, and do not
  install the GitHub runtime scaffold.
- Greenfield formation now has a structured `write_greenfield_artifacts` tool
  and deterministic renderer. The model submits typed formation data, agentify
  renders `CONTEXT.md`, `GOALS.md`, PRDs, plans, issues, and specs with managed
  markers, validates the rendered bundle before scaffold install, and writes a
  greenfield manifest on success.
- Greenfield structured formation now has a code-enforced `stop_at` checkpoint.
  A payload that claims to stop at `goals` cannot include PRDs/plans/issues/specs,
  and each later checkpoint must include its required artifact before the bundle
  can render.
- Greenfield state now persists resume context: whether it came from typed
  formation or filesystem fallback, the approved `stop_at` checkpoint, current
  focus, exact artifact paths, a local continuation instruction, and a GitHub
  continuation instruction.
- The GitHub drill-me workflow now renders that greenfield resume state through
  a trusted scaffold script and injects it into the prompt before the model
  makes its one-transition issue move. The drill model reads captured issue
  JSON without GitHub credentials and returns structured child/PRD/implementation
  issue requests; a trusted shell step creates or reuses the issues and appends
  links before the state marker. The scaffold contract suite now simulates the
  formation-state -> drill-prompt -> trusted queued-issue path.

Remaining major gaps are still real: greenfield is still weaker than
brownfield because local terminal formation and post-launch GitHub drilling
still need live GitHub smoke evidence beyond the now-stubbed readiness,
PR-publication, handoff, failure, and retry paths, more ecosystem-specific
generated-output fixtures are still useful beyond the newly added small
library and Rails-style app shapes, and the orchestrator remains internal
rather than a public installed runtime.

## What I Inspected

I read across the public CLI, brownfield audit, greenfield path, TypeBox
schemas, renderers, manifest/readiness code, harness exporters, defense hook,
explorer sub-agent tooling, shipped skills, GitHub scaffold workflows, AIW,
orchestrator, webhook internals, tests, ADRs, and release docs.

Important reference points:

- README positions agentify as "One terminal command for the full life of an
  agentic codebase" and says bootstrap audits code, generates intelligence,
  ships skills, and stamps GitHub runtime: `README.md:3-9`.
- The public command surface is intentionally only `agentify`, with no
  subcommands: `README.md:118-129`, `src/cli.ts:115-135`,
  `src/core/agentify-app.ts:42-48`, `docs/adr/0008-one-package-two-entry-modes.md:13-24`.
- Brownfield bootstrap runs an in-process Pi audit with a controlled tool
  allowlist: `src/core/run-agentify.ts:55-66`,
  `src/core/run-agentify.ts:722-735`.
- Public lifecycle is GitHub-first after bootstrap:
  `docs/lifecycle/README.md:63-86`.
- Internal runtimes are explicitly not public product surface:
  `README.md:147-148`, `docs/lifecycle/README.md:98-101`,
  `docs/18-the-orchestrator.md:1-6`, `docs/15-the-webhook-server.md:1-6`.

## What Is Strong

### 1. The one-command public shape is clean

The product has a simple public interface. The CLI accepts only flags and
rejects positional subcommands: `src/cli.ts:161-193`,
`src/core/agentify-app.ts:42-48`. That supports the stated user experience:
run `agentify`, then work through GitHub.

This is the right product decision. Exposing `webhook`, `aiw`, `orchestrator`,
and `expert` as public command families would make the tool feel like a
framework instead of a bootstrapper.

### 2. Brownfield audit has real engineering discipline

The brownfield flow is structured:

- The builder uses a fixed tool allowlist:
  `src/core/run-agentify.ts:55-66`.
- It runs in-process through the SDK rather than shelling out:
  `src/core/pi-sdk-runtime.ts:48-91`.
- It writes structured state through `write_map` and `write_map_delta`:
  `src/core/audit/write-map-tool.ts:430-630`,
  `src/core/audit/write-map-tool.ts:636-787`.
- It renders artifacts deterministically only after success:
  `src/core/run-agentify.ts:798-845`.
- It rolls back partial generated surface on failure:
  `src/core/run-agentify.ts:895-918`.

This is much better than a prompt that writes random files. The map and
renderer split is the right shape for production agentic tooling.

### 3. Transactional apply and ownership protection are mature

The generated surface is staged before apply:
`src/core/run-agentify.ts:819-845`. Required conflicts block application:
`src/core/run-agentify.ts:855-871`. Existing unmanaged files are protected:
`src/core/artifact-exporters.ts:30-44`, `src/core/manifest.ts:163-210`.

That matters because agentify will be run in mature brownfield repos. The
project is already designed around "do not clobber the user's codebase."

### 4. The GitHub Actions harness is credible

The scaffold implements a real issue-to-PR loop:

- `agent-implement.yml` listens for `agent:implement`, checks readiness,
  branches, runs Pi, validates that commits exist, writes PR metadata, opens a
  draft PR, and labels it for review: `scaffold/.github/workflows/agent-implement.yml:7-311`.
- `check-issue-ready.sh` requires `agent:queued`, closed blockers, and
  write/maintain/admin permissions for the actor:
  `scaffold/.github/scripts/check-issue-ready.sh:4-55`.
- `agent-review.yml` runs in `pull_request_target` but restricts itself to
  same-repo `agent/` branches, checks out trusted runtime from the base, and
  parses a structured approve/request-changes verdict:
  `scaffold/.github/workflows/agent-review.yml:10-24`,
  `scaffold/.github/workflows/agent-review.yml:59-65`,
  `scaffold/.github/workflows/agent-review.yml:107-121`.
- `run-pi-safe.sh` unsets `AGENT_PAT`, `GH_TOKEN`, and `GITHUB_TOKEN` before
  invoking the model process: `scaffold/.github/scripts/run-pi-safe.sh:13-31`.

This is good harness engineering. It treats GitHub as a state machine, keeps
credentials out of the model process, and puts humans at the merge gate.

### 5. The defense model is not superficial

The defense hook blocks compound bash, blacklisted destructive commands,
script-content patterns, zero-access paths, credential-store reads/writes,
repo-jail violations, protected generated files, orchestration depth escapes,
and domain-lock writes:
`src/core/audit/defense-hook.ts:232-357`.

The scaffold also avoids exposing push tokens to Pi:
`scaffold/.github/scripts/run-pi-safe.sh:13-21`.

This is the right safety posture for an agentic coding product.

### 6. The repository has a serious test surface

`npm test` runs typecheck, many unit tests, and bash contract tests:
`package.json:47-54`. The unit suite covers the core app, CLI, scaffold
installer, readiness, project state, config permissions, coverage gate,
renderers, defense hardening, webhook, AIW, orchestrator, experts, coms, and
domain lock.

The current validation surface passes, including typecheck, the unit suite,
the scaffold shell tests, and the repo contract tests. See "Current
Validation" below.

## Vision Fit Matrix

| Vision element | Current status | Assessment |
|---|---:|---|
| One-command install/bootstrap | Strong | `agentify` is the only public command and handles bootstrap, attach, and recovery. |
| Brownfield repository audit | Strong | Structured TypeBox map, explorer sub-agents, deterministic renderers, coverage gate. |
| Greenfield project formation | Improved | Uses typed formation output, code-enforced `stop_at` gates, deterministic renderers, checkpoint state, persisted resume context, managed markers, a manifest, a substance gate, credential-free GitHub drill prompt handoff, trusted structured issue creation/reuse, blocked-dependency gating, and a simulated handoff to `/agent implement`; still needs live/stubbed full CI workflow coverage. |
| Specialized feature agents | Improved | `.pi/agents` are generated, exported to Codex/Claude surfaces, and injected into GitHub implement/review prompts as trusted routing context. |
| Agent experts | Improved | The renderer emits runtime-compatible expert directories, the runtime discovers them, refresh receives stale-domain signals, and GitHub implement/review prompts receive trusted expert routing context with durable patterns, conventions, pitfalls, key files/types, and test paths. |
| Complex AI workflows | Bridged into prompts | AIW and orchestrator workflow code exists and is tested; generated repos now include project workflow specs that the orchestrator registry can discover, and the GitHub implement loop receives those specs as trusted routing context. |
| Orchestrator agent | Public routing planner + internal host | Strong foundation code, plus generated agents/workflows/experts now line up with registry consumers and prompts. Issue implementation now has a credential-free orchestration-planner pass, but the installed public runtime still does not execute the internal OrchestratorHost DAG/control-plane loop. |
| GitHub issue -> PR loop | Strong | Label-driven implement/review/update loops are real, drill-me can now post structured success replies, generated specialist/expert/workflow context is injected before model runs, the public orchestration planner selects a route for issue implementation, and token isolation is preserved. |
| Self-refresh / evolution loop | Improved | The default-branch trigger is fixed, stale experts are detected deterministically, and refresh PR handoff is robust when edits are uncommitted or already committed; refresh is still prompt-driven and needs broader output-quality checks. |
| Production packaging | Improved | Package fields and ADRs are coherent, the missing roadmap link is fixed, and `npm test` passes. |

## Production Blockers

### Fixed P0. Expert artifacts were incompatible with the expert runtime

This was the biggest product coherence bug in the initial report.

The builder prompt promises expert directories:

- `.pi/prompts/experts/<domain>/expertise.yaml`
- `.pi/prompts/experts/<domain>/question.md`
- `.pi/prompts/experts/<domain>/self-improve.md`
- optional `plan.md`
- optional `plan_build_improve.md`

Evidence: `src/core/audit/prompts/builder.md:937-950`.

The schema also has `grade7_evidence.expert_domains`, explicitly saying each
domain becomes `.pi/prompts/experts/<domain>/` with those files:
`src/core/audit/schema.ts:970-1067`,
`src/core/audit/schema.ts:1268-1275`.

The deterministic renderer now writes that directory shape from
`grade7_evidence`, with a legacy fallback for older `artifact_intents.experts`
maps.

The runtime expert registry only scans directories and requires
`expertise.yaml`:
`src/core/agent-expert.ts:4-13`,
`src/core/agent-expert.ts:80-113`.

The renderer test now asserts the directory files and writes the rendered
bundle to a temporary repository, then proves the runtime can discover the
expert with `ExpertRegistry.fromCwd()`.

Impact: the generated expert surface is now aligned with the runtime consumer.

Completed fix:

1. Changed the renderer to emit expert directories from `grade7_evidence`.
2. Emit `expertise.yaml`, `question.md`, `self-improve.md`, and optional
   planning prompts.
3. Updated tests to assert the directory shape.
4. Added an integration test that runs `ExpertRegistry.fromCwd()` against a
   rendered brownfield bundle and confirms the generated experts are discovered.
5. Updated schema and builder prompt descriptions to use the runtime-compatible
   expert shape.

### Fixed P1. Generated specialists were not connected to orchestrator workflows

The orchestrator can discover project workflows from `.pi/workflows/*.json`:
`src/core/orchestrator/workflow-registry.ts`. Before this pass, the brownfield
renderer emitted specialists and experts but no project workflow specs that
composed those specialists with the internal AIW loops.

The renderer now emits a valid project workflow per generated/suggested
specialist. Each workflow scouts with the generated specialist, then runs the
canonical `plan_build_review_fix` AIW with the specialist report in context.
The artifact is a JSON-managed workflow spec using manifest `sha256` ownership,
and `.pi/workflows` is included in the generated-surface snapshot/rollback
surface.

`tests/artifacts-renderers.test.ts` writes the rendered bundle to a temporary
repo and proves `WorkflowRegistry.fromCwd()` discovers
`<domain>_plan_build_review_fix`, with a `subagent` scout step followed by the
AIW step. The stamped `agent-implement` and `agent-implement-pr` workflows now
also run `render-workflow-context.sh` and inject that summary into the
credential-free implementation prompts. This is not yet public orchestrator
hosting, but it closes a real schema -> renderer -> runtime-consumer -> public
prompt gap.

### Fixed P0. The builder prompt promised artifacts the renderer did not emit

The initial report found that the builder prompt was ahead of the
implementation.

The prompt promises feedback-loop storage:
`app_review/README.md`, `app_docs/README.md`,
`app_fix_reports/README.md`, `app_docs/agentic_kpis.md`, and
`.pi/conditional_docs.md`.

Evidence: `src/core/audit/prompts/builder.md:478-503`.

It promises `.pi/skills/<name>/SKILL.md` generation:
`src/core/audit/prompts/builder.md:537-559`,
`src/core/audit/prompts/builder.md:646-695`.

It promises custom-tool extensions and expert directories:
`src/core/audit/prompts/builder.md:937-950`.

It finishes with a success message that claims those generated surfaces:
`src/core/audit/prompts/builder.md:1693`.

That gap is now narrowed. The renderer now emits:

- feedback-loop storage: `app_review/`, `app_docs/`,
  `app_fix_reports/`, `app_docs/agentic_kpis.md`, and
  `.pi/conditional_docs.md`;
- `.pi/skills/<name>/SKILL.md` from `grade3_evidence.skill_candidates`;
- `.pi/extensions/<name>.ts` from shell-free
  `grade3_evidence.custom_tool_candidates`;
- runtime-compatible expert directories from `grade7_evidence`.

The renderer tests now cover feedback-loop state, skill candidates,
custom-tool extensions, lifecycle prompt templates, and expert discovery.

Remaining alignment work: keep the builder prompt, schema descriptions, and
public docs in lockstep as the generated surface evolves. The artifact families
named by the current builder prompt now have deterministic renderer coverage.

### Fixed P0. `npm test` failed

I ran:

```bash
npm test
```

Typecheck and the unit suite passed, but `tests/run.sh` failed in
`test-doc-package-links.sh`:

```text
ERROR: README.md link target is missing: docs/roadmap/10-10/README.md
1 doc/package link error(s).
```

Evidence:

- README link: `README.md:180-185`.
- Contract test that checks README links: `tests/test-doc-package-links.sh:16-26`.
The missing roadmap now exists at `docs/roadmap/10-10/README.md`, so the
repo's own external beta gate in `docs/release-readiness.md:21-31` is no
longer blocked by this link.

### Fixed P1. Coverage closure was too shallow for "best in world"

The code enforces coverage from the map, not just prompt compliance. ADR 0014
describes the intended mechanical gate:
`docs/adr/0014-coverage-gate-in-code.md:17-30`.

The gate now has per-dimension substance validators for D1-D10. It rejects
covered-but-weak maps missing entry points, module evidence, type/contract
evidence, naming/logging conventions, pitfalls, validation commands,
operational run/build commands, security damage-control evidence, process issue
types, or documentation surface evidence.

The closure reasons are also fed back into the audit loop immediately:
`write_map` and `write_map_delta` now return `coverage_closure` details and
human-readable `D<n>: reason` warnings whenever status-level coverage is too
weak. The builder prompt tells the agent to use those reasons as the next
`gap_filler` focus list. `tests/audit/coverage-gate.test.ts` covers both the
per-dimension validators and the immediate `write_map` feedback.

Remaining audit-quality work: keep broadening the output-quality fixtures into
more ecosystem-specific shapes beyond the current TypeScript CLI, monorepo,
frontend, backend service, sparse-test repo, domain-doc-heavy repo, small
library, and Rails-style application coverage.

### Partially fixed P1. The public product does not use the internal orchestrator

The stated vision includes an orchestrator agent that can call specialized
agents and workflows. That code exists. `OrchestratorHost` owns an agent
manager, AIW bridge, workflow registry, workflow runner, management tools, and
auto-improve scheduler: `src/core/orchestrator/host.ts:99-162`. Its chat
session intentionally has no built-in read/write/bash tools, only management
tools: `src/core/orchestrator/host.ts:233-247`.

The architecture docs are clear that this is internal:
`docs/18-the-orchestrator.md:1-14`. They also state the shipped async loop is
the GitHub Actions scaffold, not orchestrator or AIW:
`docs/18-the-orchestrator.md:34-50`,
`docs/lifecycle/README.md:98-101`.

Impact: agentify now satisfies "GitHub issues drive Pi prompt workflows with a
separate orchestration-planner pass over generated workflows, specialists, and
experts" more than "GitHub issues trigger the internal OrchestratorHost to
execute DAGs and delegate to managed worker agents." That is a much closer
public loop than raw prompt routing, but still narrower than the full vision.

Completed bridge:

1. `orchestrate-issue.md` is a public, credential-free routing prompt for
   issue implementation.
2. `extract-orchestration-plan.sh` validates the planner's structured output
   and renders bounded markdown for the implementation prompt.
3. `agent-implement.yml` runs the orchestration planner before the build agent
   and injects the rendered plan as `ORCHESTRATION_PLAN`.
4. Scaffold tests cover the extraction contract and prompt substitution.

Strategic choice:

- Option A: keep v1 honest. Market agentify as a GitHub Actions agentic
  harness that generates repo-specific instructions and specialists.
- Option B: promote orchestrator to the installed runtime. That means a real
  hosted/deployed control plane story, queue, auth, logs, and failure handling.

Do not claim Option B until it is actually wired into the public lifecycle.

### P1. Greenfield is materially weaker than brownfield

Brownfield has a schema, coverage dimensions, deterministic rendering, and
transactional apply. Greenfield is a local-first Pi session with a prompt, the
shipped skills, a typed formation payload, a deterministic markdown renderer,
and a typed checkpoint state file:
`src/core/pi-sdk-runtime.ts:151-181`.

The prompt is sensible: interview the user, move through goals, PRDs, plans,
issues, specs, and implementation, one selected unit at a time:
`src/core/pi-sdk-runtime.ts:158-168`.

`src/core/greenfield-state.ts` now defines the TypeBox-validated
`greenfield-state.json` contract, deterministic next actions, and artifact
validation result. `src/core/greenfield-artifacts.ts` defines the
`write_greenfield_artifacts` structured tool plus deterministic renderers for
`CONTEXT.md`, `GOALS.md`, PRDs, plans, issues, and specs. The formation payload
now carries a `stop_at` checkpoint that the renderer enforces: downstream
artifacts beyond the user-approved milestone are rejected, and later milestones
must include their required artifacts. `runAgentify` renders that typed payload
into a staged bundle, validates the rendered artifacts before installing
scaffold, applies the bundle with managed markers, and writes a greenfield
manifest on success. The state file now persists resume context with exact
artifact paths and local/GitHub continuation instructions. The stamped
`agent-drill-me-issue.yml` workflow renders that state into a markdown prompt
section with `render-formation-resume-context.sh`, so post-launch drilling sees
the terminal formation checkpoint before making its next state transition. The
same workflow captures issue context before Pi runs, keeps GitHub credentials
out of the model process, and applies structured issue requests through
`apply-drill-issues.sh` after the model returns. Thin, placeholder, overrun, or
missing structured artifacts keep the run `partial` and report concrete
validation reasons instead of producing a ready-looking GitHub scaffold.
Implementation issue bodies requested through drill-me now must include
`## What to build`, `## Acceptance criteria`, and `## Blocked by`; the trusted
issue applier rejects malformed queued slices before creating GitHub issues,
and `check-issue-ready.sh` refuses `agent:implement` while any listed blocker
issue is still open. The `agent-implement.yml` readiness step now delegates to
`run-issue-readiness.sh`, which is covered by a stubbed CI-style test proving
open blockers remove `agent:implement`, post a refusal comment, and set
`proceed=false` before any model run. The post-implementation PR metadata
handoff now delegates to `extract-pr-meta.sh`, with fixture coverage proving
malformed title/description output is rejected before branch push or PR
creation. Branch naming now delegates to `compute-implementation-branch.sh`,
with newline, empty-title, truncation, and issue-number coverage. Branch push
and draft PR creation now delegate to `publish-implementation-pr.sh`; a
stubbed test proves only `agent/*` branches are force-pushed, `AGENT_PAT` is
scoped into `gh`, malformed `gh pr create` output is rejected, and the PR
number is written to the workflow output before the review-label step runs.
No-change implementation detection now delegates to
`verify-implementation-commits.sh`; a real temporary-git-repo scaffold test
proves a branch with zero commits writes the trusted failure reason before the
workflow can continue, while a branch with commits passes with the expected
commit count.
Update-branch stale-push protection now delegates to
`push-updated-branch.sh`; a stubbed scaffold test proves only `agent/*`
branches are pushed, `AGENT_PAT` is scoped into `gh`, force-with-lease is used
with the expected remote head SHA, and stale remote rejection writes the
trusted failure reason.
Review verdict extraction now delegates to `extract-review-verdict.sh`, with
fixture coverage for approve, request-changes, unsupported verdicts, missing
summaries, and missing structured output.
Update-branch merge-resolution comment extraction now delegates to
`extract-update-branch-comment.sh`, with fixture coverage for valid comments,
missing comments, empty comments, and missing structured output.
Post-PR handoff side effects now delegate to
`complete-implementation-handoff.sh`; a stubbed test proves `agent:review` is
applied with `AGENT_PAT`, source issue cleanup/commenting use `GITHUB_TOKEN`,
and the issue comment includes the draft PR number and workflow run URL.
Failure handoff now delegates to `mark-implementation-failure.sh`; fixture
coverage proves a created PR is marked `agent:blocked` while the source issue
points to it, and no-PR failures mark the source issue blocked with the stored
or default failure reason.
The command router now has direct retry coverage: issue comments requeue
`agent:implement`, PR comments requeue `agent:review`, and stale
`agent:in-progress` labels are cleared before retry labels are added.

Remaining gap: greenfield still needs live GitHub smoke evidence around real
API behavior after draft PR creation. The local/stubbed side is now much
stronger: `test-implementation-handoff-flow.sh` composes branch naming, PR
metadata extraction, draft PR creation, and final source-issue handoff through
fake `gh`/`git` with token checks. For the user's stated vision, brownfield
remains the primary credible path until the greenfield workflow has equivalent
live evidence to its rendering, gate, resume-state, dependency gating, trusted
drill handoff, branch naming, PR metadata, trusted PR publication, trusted
post-PR handoff, failure handoff, and command retry layers.

### Fixed P1. Drill-me issue workflow could not ask follow-up questions on success

The drill workflow says posting replies happens through `gh issue comment`:
`scaffold/.github/workflows/agent-drill-me-issue.yml:15-17`.

Initially, the success path only pushed a branch and opened a PR when repo
files changed, and the only explicit issue comment step was the failure path.

Also, `run-pi-safe.sh` unsets GitHub tokens before the model process:
`scaffold/.github/scripts/run-pi-safe.sh:13-17`.

Impact: if the drill agent needed to ask a question, there was no success step
that took the model's response and posted it back to the issue. That weakened
the post-launch async intake loop.

Completed fix:

1. `drill-me-issue.md` now requires a final `<output>` JSON block with
   `reply`, `state`, and `filesChanged`.
2. `render-drill-reply.sh` extracts the final block, validates it with `jq`,
   writes the comment body, and appends the `agentify-event` /
   `agentify-state` marker.
3. `agent-drill-me-issue.yml` renders that reply immediately after Pi, handles
   branch/PR work, then posts the success-path issue comment with
   `gh issue comment --body-file`.
4. `scaffold/tests/test-drill-reply-output.sh` covers the no-change
   follow-up-question path and malformed-output failures; the unification
   invariant guards that the stamped workflow keeps this structured posting
   path.

### Fixed P1. Self-refresh was not actually default-branch agnostic

The lifecycle doc says refresh runs on every push to the default branch:
`docs/lifecycle/README.md:81-86`. ADR 0012 says the same:
`docs/adr/0012-evolution-loop.md:11-20`.

The stamped workflow initially only triggered for `main` and `master`. It now
accepts push events generally and guards execution with
`github.ref_name == github.event.repository.default_branch`. A contract test in
`tests/test-unification-invariants.sh` prevents returning to the hard-coded
branch list.

The refresh workflow also had a git handoff mismatch: the prompt told Pi to
commit, while the trusted shell step only opened a PR when it saw uncommitted
diffs. If the model obeyed the prompt, the workflow could skip pushing the
refresh branch. The prompt now says **do not commit**, and the workflow checks
`git rev-list --count "origin/${BASE_REF}..HEAD"` before declaring the surface
current, so already-committed refresh changes still produce a PR. Scaffold
validation and the unification invariant guard both sides of that contract.

### Fixed P1. Defense path guards did not cover all declared write tools

The defense hook defines:

- `PATH_SENSITIVE_TOOLS = ["read", ...WRITE_TOOLS]`
- `WRITE_TOOLS = ["write", "edit", "write_file", "multi_edit"]`

Evidence: `src/core/audit/defense-hook.ts:59-60`.

The zero-access, credential-store, protected-file, and repo-jail checks now run
for `write_file` and `multi_edit` too. `tests/audit/defense-hardening.test.ts`
now covers repo-jail and protected-path blocking for those write-like tools.

### Partially fixed P2. `spawn_explorer` needed enforced audit budgets

The explorer tool initially said there was no hard cap on parallel sub-agents
or action limits, then only warned after the fact when read/bash caps were
exceeded.

That is now partially corrected. `spawn_explorer` enforces:

- max total sub-agent dispatches per audit tool instance;
- max concurrent sub-agents across tool instances;
- max wall-clock duration per sub-agent prompt.

The builder prompt now tells the agent to treat explorer-budget exhaustion as
an instruction to reuse existing reports, narrow the target, or mark remaining
uncertainty honestly. `tests/audit/spawn-explorer-budget.test.ts` covers the
hard total and concurrent dispatch guards before any Pi session is created.

Remaining budget work: enforce a true cost budget once sub-agent usage/cost is
available from the SDK, and add explicit resume behavior after budget
exhaustion.

### Partially fixed P2. Harness exports needed stronger specialist routing

The exporter mirrors shipped skills and converts `.pi/agents/*.md` to Codex
and Claude agent surfaces:
`src/core/artifact-exporters.ts:159-205`.

The stamped GitHub loop now has a stronger public routing seam:
`render-specialist-context.sh` summarizes generated `.pi/agents/*.md`
specialists, their descriptions, and frontmatter globs into a bounded trusted
prompt block. `agent-implement.yml`, `agent-implement-pr.yml`, and
`agent-review.yml` inject that block before Pi runs. The implement and review
prompts tell the agent to map expected or changed paths to specialists, read
the matching `.pi/agents/*` file, and carry local pitfalls and validation
commands into implementation or review output.

This is still not universal hard enforcement. Codex and Claude exports remain
instruction surfaces, and prompt routing cannot guarantee domain locks or
expert use across every harness. The strongest enforced agent routing still
exists in the internal orchestrator code. The public claim is now stronger but
still honest: GitHub Actions provides trusted specialist routing context before
model execution; hosted orchestrator-level domain locks are a separate product
decision.

## Current Validation

Commands run:

```bash
npx tsx tests/agentify-core.test.ts
npx tsx tests/generated-output-quality.test.ts
npx tsx tests/greenfield-state.test.ts
npx tsx tests/greenfield-artifacts.test.ts
bash scaffold/tests/test-expert-context.sh
bash scaffold/tests/test-extract-review-verdict.sh
bash scaffold/tests/test-extract-update-branch-comment.sh
bash scaffold/tests/test-push-updated-branch.sh
bash scaffold/tests/test-verify-implementation-commits.sh
bash scaffold/tests/test-workflow-simulation.sh
npm run typecheck
npm run release:check
npm run test:scaffold-e2e
git diff --check
```

Current result: all pass.

The initial failure was a missing `docs/roadmap/10-10/README.md` link. That
roadmap now exists, and `tests/test-doc-package-links.sh` passes as part of the
full suite. The new drill-me structured reply path is covered by
`scaffold/tests/test-drill-reply-output.sh` and the unification invariant. The
greenfield checkpoint/artifact/resume state is covered by
`tests/greenfield-state.test.ts` and the run-level behavior in
`tests/agentify-core.test.ts`. The structured greenfield formation
renderer/tool, including `stop_at` milestone gate rejection, is covered by
`tests/greenfield-artifacts.test.ts`. Greenfield resume prompt injection is
covered by `scaffold/tests/test-formation-resume-context.sh` and the broader
formation-to-drill prompt simulation in
`scaffold/tests/test-formation-drill-flow.sh`, including trusted creation of an
`agent:queued` implementation issue from structured output and handoff to the
`/agent implement` command router. The focused
`scaffold/tests/test-apply-drill-issues.sh` covers duplicate child issue reuse,
PRD issue creation with `artifact:prd`, and queued implementation issue
creation with source markers.
Generated expert prompt substance is covered by
`scaffold/tests/test-expert-context.sh`, which now asserts key files, key
types, pattern knowledge, conventions, pitfalls, and test paths are rendered
from `expertise.yaml`. `scaffold/tests/test-workflow-simulation.sh` also proves
an expert invariant is substituted into implement, implement-PR, and review
prompts.
No-change implementation handling is covered by
`scaffold/tests/test-verify-implementation-commits.sh`, which runs the trusted
script against a real temporary git repo and verifies both zero-commit failure
and commit-ahead success.
Stale update-branch push handling is covered by
`scaffold/tests/test-push-updated-branch.sh`, which verifies agent-branch
guarding, token scoping, force-with-lease arguments, and stale rejection
failure reasons.
Malformed review and update-branch model output handling is covered by
`scaffold/tests/test-extract-review-verdict.sh` and
`scaffold/tests/test-extract-update-branch-comment.sh`.

## Loop Engineering Assessment

Agentify already has important loops:

- Bootstrap loop: audit -> map -> coverage gate -> render -> stage -> apply.
- GitHub issue loop: queued issue -> implement -> PR -> review -> fix/requeue.
- Refresh loop: default branch push -> surface refresh PR.
- AIW internal loop: plan -> build -> review -> fix -> ship:
  `src/core/aiw/state.ts:31-80`.
- Expert intended loop: ACT -> LEARN -> REUSE:
  `src/core/agent-expert.ts:1-24`.

The main gap is that these loops are not equally real in the public product.
The GitHub loop is real. The AIW and orchestrator loops are internal. The
expert loop now has runtime-compatible generated artifacts and public GitHub
prompt routing that includes concrete expert knowledge, but still needs
measured outcome quality evidence. The refresh loop has the right
default-branch trigger, deterministic stale expert detection, and a trusted
git handoff, but remains prompt-driven and needs stronger deterministic
guarantees.

To reach "best in world", each loop needs:

1. Typed inputs.
2. Typed outputs.
3. Observable state transitions.
4. Clear retry semantics.
5. A stop condition.
6. Cost/time budgets.
7. Human review boundaries.
8. Tests that simulate success, failure, partial progress, and recovery.

Brownfield bootstrap is closest to that standard. Greenfield remains furthest;
experts have crossed the structural, routing, and prompt-substance thresholds
but still need outcome evidence.

## Harness Engineering Assessment

This is one of the strongest parts of the project.

The GitHub harness is not naive:

- trusted runtime checkout from default/base branch;
- model process has no ambient GitHub push token;
- label-state transitions;
- actor authorization;
- blocker checks;
- structured drill-me success replies posted by the trusted workflow;
- draft PR creation;
- structured PR metadata and review verdict extraction;
- requeue on review changes;
- force-with-lease for PR mutation.

The remaining harness gap is now more of a product-design decision than a
missing edge-case test: decide whether refresh should use deterministic
agentify renderers rather than direct prompt edits.

## Agentic Engineering Assessment

The project has the right vocabulary:

- feature agents;
- experts;
- prompt templates;
- skills;
- AIWs;
- orchestrator;
- domain locks;
- self-refresh;
- managed context files.

The main issue is mismatched maturity. Some parts are production-shaped
(brownfield audit, scaffold). The generated skills, extensions, experts, and
feedback-loop state now have renderer coverage, but only the first usefulness
fixture exists. Some runtime-shaped pieces remain internal rather than public
(orchestrator, AIW, webhook). This makes the repository feel like it contains a
future product and a current product at the same time.

The best next move is not to add more agent concepts. It is to make the
current concepts line up end to end:

- schema field -> builder instruction -> renderer -> manifest -> harness
  export -> runtime consumer -> tests -> docs.

Every agentic primitive should pass that chain before it is described as a
product feature.

## Prioritized Roadmap

### Phase 1: Make the current product honest and passing

1. Fix the missing README roadmap link or add the referenced file.
2. Align README/lifecycle docs with the actual public product:
   GitHub Actions loop first, orchestrator internal.
3. Keep generated expert claims tied to the runtime-compatible expert directory
   renderer.
4. Run `npm test`, `npm run test:scaffold-e2e`, and
   `npm pack --dry-run`.

Exit criteria: external beta gate passes and docs do not overclaim.

### Phase 2: Deepen experts end to end

Completed: generated experts now render from `grade7_evidence.expert_domains`
as runtime-compatible directories, with tests proving `ExpertRegistry.fromCwd()`
discovers them. The generated GitHub prompt context now includes expert
patterns, conventions, pitfalls, key files/types, and test paths, with scaffold
tests proving expert invariants survive through the public implement,
implement-PR, and review prompt rendering path. Generated-output quality tests
now also score expert expertise for actionable durable knowledge and
self-improve validation guidance.

Remaining work:

1. Add dogfood fixtures proving generated expertise improves planning and review
   outcomes.

Exit criteria: generated experts are not only discoverable, but measurably
improve the agent's plans, reviews, and refresh behavior.

### Phase 3: Strengthen brownfield audit quality

Completed: TypeScript CLI, monorepo, frontend, backend service, sparse-test,
small TypeScript library, Rails-style app, domain-doc-heavy, and expert-domain
quality fixtures now score fallback `AGENTS.md`, specialist output, AI docs,
conditional docs, project workflows, expert expertise, and lifecycle prompts
for actionable validation, pitfalls, scope, first-file guidance,
package-boundary evidence, user-workflow e2e coverage, honest missing-test
signaling, domain-doc routing, and expert durable-knowledge quality.

Remaining work:

1. Add more benchmark fixtures:
   - CLI with no tests but strong typecheck;
   - app with complex generated code.
2. Score output quality across generated skills, validation commands,
   pitfalls, and feedback-loop docs.

Exit criteria: agentify can prove that its generated surface is useful, not
just valid.

### Phase 4: Decide the orchestrator product line

Pick one:

- Keep orchestrator internal and focus public v1 on GitHub Actions.
- Promote orchestrator to the public installed runtime.

If promoted, it needs a deployment and operations story:

- where it runs;
- how it authenticates GitHub events;
- how it stores state;
- how users inspect logs/costs;
- how it resumes after failure;
- how it upgrades safely;
- how it avoids becoming a privileged always-on daemon with unclear blast
  radius.

Exit criteria: public docs and actual runtime match.

### Phase 5: Make greenfield first-class or explicitly secondary

If greenfield remains in scope:

Completed: typed greenfield checkpoint state now records the current stage,
completed artifact milestones, next valid actions, and artifact-validation
reasons. Scaffold installation is now blocked when greenfield artifacts are
only placeholders or otherwise too thin. Typed greenfield formation data now
renders deterministic managed `CONTEXT.md`, `GOALS.md`, PRD, plan, issue, and
spec artifacts before scaffold install. The formation payload also carries a
hard `stop_at` gate so a session cannot race ahead of the user-approved
milestone. The greenfield state file now persists resume source, stop gate,
current focus, exact artifact paths, and local/GitHub continuation instructions.
The GitHub drill workflow now renders that resume context into its prompt before
the model chooses a one-transition next step, and the trusted workflow applies
structured issue requests after the credential-free model run.

Remaining work:

1. Add live/stubbed GitHub edge-case simulations for post-readiness CI behavior
   such as branch creation, push/PR handoff, and reruns.
2. Decide whether greenfield should remain secondary to brownfield or receive
   the same release bar.

Exit criteria: greenfield has the same mechanical reliability as brownfield.

## Final Answer To The Vision Question

Does agentify satisfy the vision today?

Partially.

It satisfies the first major slice: a user can run one command in a brownfield
repo, agentify can audit it, generate repo-specific agent context, install
skills, stamp a GitHub runtime, and let GitHub issues drive implementation PRs.
That is a real product foundation.

It does not yet satisfy the full "agentic codebase lives on its own" vision.
The installed public product is not actually orchestrator-led. Experts,
skills, feedback-loop state, custom-tool candidates, and project workflow specs
now have deterministic renderer coverage, experts and workflows are proven
discoverable by their runtime registries, and generated workflows are injected
into the GitHub implement prompts. Generated specialists are also injected into
GitHub implement/review prompts as routing context, and generated experts are
injected into those prompts with concrete patterns, conventions, pitfalls, key
files/types, and validation hints, but these loops still need outcome fixtures.
Greenfield is still less mechanically constrained than brownfield, though it
now has typed formation rendering, checkpoint/resume state, scaffold prompt
handoff, and a first drill-flow contract.

The path to production is clear: stop expanding the concept surface, make each
existing primitive work end to end, and add empirical quality gates. Once
experts, refresh, greenfield, and audit closure are as deterministic as the
brownfield scaffold path, this project can become a genuinely strong agentic
engineering platform.
