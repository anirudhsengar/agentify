# Agentify Production Readiness Report

Date: 2026-07-07

## Executive Verdict

Agentify is a serious foundation, not a toy. It already has a coherent
one-command public CLI, a structured brownfield audit, deterministic artifact
rendering, transactional apply/rollback, managed-file manifests, a stamped
GitHub Actions runtime, a shipped skill pack, a defense hook, and a large test
surface.

It does not yet fully satisfy the most ambitious version of "install agentify,
run one command, and the repository lives on its own with specialized agents,
experts, complex workflows, and an orchestrator." The brownfield bootstrap and
GitHub-label PR loop are real. ADR 0015 now makes the product boundary explicit:
public v1 is orchestrated by the scaffolded GitHub Actions loop, including a
credential-free orchestration-planner pass over generated workflows,
specialists, and experts, while the internal OrchestratorHost remains
foundation code rather than the installed runtime.

My current production-readiness rating is:

- Private dogfood: yes, after fixing the failing docs link.
- External beta: close, but only with clear limitations around experts,
  greenfield, and the decision that public v1 uses GitHub Actions orchestration
  rather than the internal OrchestratorHost runtime.
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
  JSON, and a trusted script validates selected workflow/specialist/expert
  names plus validation-focus commands against the generated context before
  rendering that plan into the implementation prompt.
- The issue implementation workflow now delegates duplicate-open-PR refusal to
  `check-existing-issue-pr.sh`, with fixture coverage for closing-keyword
  matching, false positives such as `#420`, malformed JSON, and invalid issue
  numbers.
- PR review fixup pushes now use the same trusted `push-updated-branch.sh`
  path as update-branch, including the `agent/*` branch guard, `AGENT_PAT`
  token scoping, force-with-lease, and review-specific stale-branch failure
  reasons.
- PR review verdict side effects now delegate to
  `complete-review-handoff.sh`: approval comments/labels/ready transitions use
  `GITHUB_TOKEN`, while request-changes requeues implementation with
  `AGENT_PAT`.
- PR-scoped failure handoff for `agent:review` and `agent:update-branch` now
  delegates to `mark-pr-workflow-failure.sh`, which applies `agent:blocked`
  and posts the retry comment from one tested trusted path.
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
- The refresh workflow now validates the model's diff before the trusted
  commit/PR handoff. `validate-refresh-surface.sh` rejects product-code edits,
  oversized `AGENTS.md`, missing managed markers, and malformed expert YAML;
  `refresh-managed-manifest.mjs` updates managed-file manifest hashes for
  refreshed surface files before the PR is opened.
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
- The public GitHub model loops now verify routing evidence after model runs.
  Issue implementation checks the orchestration planner's selected specialists
  and experts with `verify-routing-evidence.sh`; PR feedback and review check
  changed paths against generated specialists/experts with
  `verify-diff-routing-evidence.sh`. Matching transcripts must include a
  `## Routing evidence` section citing the selected or matched `.pi/agents/*`
  and `expertise.yaml` files before PR publication, fixup push, or review
  handoff can continue.
- Re-running `agentify` in an initialized repository now reports managed
  feature-agent, workflow, expert, and repo-skill counts, so attach/status is a
  useful operator check of the installed agentic surface instead of just a
  rerun guard.
- `spawn_explorer` now enforces hard total-spawn, concurrent-spawn,
  per-subagent wall-clock, and provider-reported cumulative cost budgets
  instead of relying only on prompt guidance. Budget exhaustion now returns a
  structured resume contract that points the builder at the canonical map,
  run logs, completed reports, `write_map`/`write_map_delta`, and honest nulls
  for genuinely unobservable gaps.
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
  continuation instruction. It also persists a structured `github_handoff`
  with the next GitHub action, issue title, body, labels, and artifact paths,
  so spec-ready formation can hand off to `agent:queued` + `agent:implement`
  without relying on prose-only instructions.
- The GitHub drill-me workflow now renders that greenfield resume state through
  a trusted scaffold script and injects it into the prompt before the model
  makes its one-transition issue move. That rendered context now includes the
  structured `github_handoff` section, so the model sees the generated next
  action, issue title, labels, artifact paths, and body. The drill prompt now
  maps those actions into `childIssues[]` or `implementationIssues[]` final
  output, while still requiring approval before creating implementation slices.
  Approved, unblocked implementation handoffs can set `activate: true`; the
  trusted issue applier then checks referenced blockers and applies both
  `agent:queued` and `agent:implement` only when no blocker remains open. When
  a matching issue already exists, activation uses that issue's current GitHub
  body and state as authoritative, so stale handoff text cannot bypass blockers
  recorded on the live issue.
  The drill model reads captured issue JSON without GitHub credentials and
  returns structured child/PRD/implementation issue requests; a trusted shell
  step creates or reuses the issues and appends links before the state marker.
  The scaffold contract suite now simulates the formation-state -> drill-prompt
  -> trusted queued-issue path.
- The stamped scaffold now includes `smoke-github-runtime.sh`, a no-LLM live
  GitHub smoke gate that creates a temporary issue, applies `agent:implement`
  without `agent:queued`, and waits for the trusted implement preflight refusal
  before closing the issue. The script now preflights that
  `agent-implement.yml` is actually installed before creating a smoke issue,
  has fake-`gh` contract coverage, and is documented in stamped `SETUP.md`.
- The stamped scaffold now also includes `smoke-drill-github-runtime.sh`, a
  no-LLM live GitHub smoke gate that creates a temporary `agent:drill-me` issue
  with an exact smoke title plus trusted smoke marker and waits for
  `agent-drill-me-issue.yml` to comment, remove the trigger label, and exit
  before checkout or Pi starts. The smoke now requires `AGENT_BOT_LOGIN`, which
  matches the drill workflow's need to ignore comments authored by `AGENT_PAT`
  and avoid reply loops.
- The stamped scaffold now also includes `smoke-retry-github-runtime.sh`, a
  no-LLM live GitHub smoke gate that creates a temporary blocked issue, posts
  `/agent retry`, waits for the trusted command router to remove
  blocked/in-progress state and queue `agent:implement`, then closes the issue.
- The no-LLM implement, drill, and retry smokes were run against a private
  staged repository stamped from the scaffold:
  `anirudhsengar/agentify-staging-no-llm-20260708053113` at
  `e20d03d47de5a8c7c1958ab51ab5077c13277ba8`. Evidence JSON is stored under
  `docs/release/no-llm-20260708053113/` and passes
  `npm run verify:smoke-evidence -- --profile no-llm ...`. The default
  verifier profile still requires all six public-release gates. The no-LLM
  evidence now records both the issue URL and the matching Actions workflow run
  URL for each gate. Workflow run lookup is time-bounded to runs created after
  the smoke starts, so evidence cannot silently reuse a stale run from an
  earlier issue. The first drill smoke exposed a real bug: the drill workflow
  skipped bot-authored events before checking the exact no-model smoke marker.
  The workflow now handles that exact marker before bot self-loop skipping, and
  the staged rerun passed.
- Staged `Validate agentify` then exposed a shell robustness bug: GitHub list
  preflights piped fake or real `gh` output directly into early-exiting `grep`
  under `set -euo pipefail`, so long output could produce a broken pipe. The
  smoke/setup scripts now capture full list output before matching required
  labels, secrets, and variables; contract coverage includes a long variable
  list regression. The final staged push has both `Validate agentify` and
  `Agent Refresh Surface` passing. Refresh now skips cleanly when model runtime
  configuration is absent instead of failing a no-LLM repository on every
  default-branch push.
- The stamped scaffold now also includes `smoke-model-github-runtime.sh`, an
  explicit-confirmation staged-repo smoke gate that creates a queued issue,
  applies `agent:implement`, and waits for the model-backed implement workflow
  to open a draft PR. It checks required workflow installation, labels,
  secrets, and implement variables before triggering the model run, without
  incorrectly requiring the drill-only `AGENT_BOT_LOGIN` variable.
- The stamped scaffold now also includes `smoke-review-github-runtime.sh`, an
  explicit-confirmation staged-repo smoke gate that applies `agent:review` to
  an agent-owned PR and waits for approval, implementation requeue, or a
  blocked failure. It checks the review workflow installation before editing PR
  labels.
- The stamped scaffold now also includes `smoke-refresh-github-runtime.sh`, an
  explicit-confirmation staged-repo smoke gate that dispatches
  `agent-refresh-surface.yml` and waits for the workflow run to complete
  successfully.
- Release qualification now has a durable evidence ledger at
  `docs/release-evidence.md`, and the invariant suite requires release
  readiness to point at it. The ledger records local gates, staged GitHub smoke
  links, model/provider details, and expert outcome transcript scores so
  release decisions do not depend on memory or console scrollback.
- Expert outcome evidence now has an executable replay gate:
  `npm run score:expert-outcomes -- <manifest>` loads generated
  `expertise.yaml`, baseline transcripts, and expert-guided transcripts, then
  fails if the expert-guided output misses required expertise checks or fails
  to beat the baseline by the configured delta. File-backed manifests are
  pinned to the staged repository, candidate commit, capture timestamp,
  provider, and model.
- The six stamped GitHub smoke scripts now accept `--evidence-file` and write
  `agentify.smoke-evidence.v1` JSON with the gate, repository, candidate
  commit SHA, pass result, completion time, issue/PR URL where applicable, and
  a repository-matching workflow run URL that proves the Actions execution. The
  workflow run lookup is time-bounded to runs created after each smoke starts,
  so concurrent or stale runs cannot satisfy the evidence contract. This turns
  staged smoke output into durable release evidence instead of console
  scrollback.
- Smoke evidence now has an executable verifier:
  `npm run verify:smoke-evidence -- <files>` fails if a required smoke gate is
  missing, duplicated, failed, from a different repository, or lacks a
  repository-matching URL that proves the run. The verifier also has an
  explicit `--profile no-llm` mode for beta hardening evidence that requires
  only implement preflight, drill preflight, and retry command gates, while the
  default profile remains the full six-gate public-release check. All six gates
  now require repository-matching workflow run URLs, not just issue or PR URLs.
- Public release qualification now has a composed gate:
  `npm run qualify:release-evidence -- --repo <owner/name> --commit <sha> --since <iso> --expert <manifest> --smoke <file>...`
  requires staged GitHub smoke evidence from the expected repository and
  candidate commit, inside an explicit evidence window, plus expert outcome
  transcript evidence pinned to the same repository, commit, and evidence
  window to pass together, and requires expert evidence across plan, review,
  and refresh modes, so release candidates cannot satisfy only one side of the
  evidence contract, stale evidence, evidence from the wrong repo/commit, or a
  single narrow expert replay.

Remaining major gaps are still real: greenfield is still weaker than
brownfield because local terminal formation and post-launch GitHub drilling
still need model-backed staged evidence beyond the now-passing no-LLM
preflight/drill/retry smoke gates, the shipped model-backed
issue-to-draft-PR/review/refresh smoke gates, and the stubbed
readiness/PR-publication/handoff/failure/retry paths. The evidence ledger now
records the no-LLM staged run, but it is not a substitute for model-backed
implementation/review/refresh runs with real provider credentials. More
ecosystem-specific generated-output fixtures are still useful beyond the newly
added small library and Rails-style app shapes, and the orchestrator remains
internal rather than a public installed runtime.

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
| One-command install/bootstrap | Strong | `agentify` is the only public command and handles bootstrap, attach, recovery, and installed surface status. |
| Brownfield repository audit | Strong | Structured TypeBox map, explorer sub-agents, deterministic renderers, coverage gate. |
| Greenfield project formation | Improved | Uses typed formation output, code-enforced `stop_at` gates, deterministic renderers, checkpoint state, persisted resume context, structured GitHub handoff data, managed markers, a manifest, a substance gate, credential-free GitHub drill prompt handoff, trusted structured issue creation/reuse, blocked-dependency gating, and a simulated handoff to `/agent implement`; still needs live/stubbed full CI workflow coverage. |
| Specialized feature agents | Improved | `.pi/agents` are generated, exported to Codex/Claude surfaces, and injected into GitHub implement/review prompts as trusted routing context. |
| Agent experts | Improved | The renderer emits runtime-compatible expert directories, the runtime discovers them, refresh receives stale-domain signals, and GitHub implement/review prompts receive trusted expert routing context with durable patterns, conventions, pitfalls, key files/types, and test paths. |
| Complex AI workflows | Bridged into prompts | AIW and orchestrator workflow code exists and is tested; generated repos now include project workflow specs that the orchestrator registry can discover, and the GitHub implement loop receives those specs as trusted routing context. |
| Orchestrator agent | Public GitHub orchestration plane + internal host | ADR 0015 makes the public v1 decision explicit: issue implementation uses a credential-free orchestration-planner pass over generated workflows/specialists/experts, while the internal OrchestratorHost DAG/control-plane remains foundation code for a future product line. |
| GitHub issue -> PR loop | Strong | Label-driven implement/review/update loops are real, drill-me can now post structured success replies, generated specialist/expert/workflow context is injected before model runs, the public orchestration planner selects a route for issue implementation, and token isolation is preserved. |
| Self-refresh / evolution loop | Improved | The default-branch trigger is fixed, stale experts are detected deterministically, refresh PR handoff is robust when edits are uncommitted or already committed, refresh diffs are validated before commit/PR handoff, and managed-file manifest hashes are refreshed deterministically. |
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
credential-free implementation prompts. This is the public v1 orchestration
bridge, not internal OrchestratorHost hosting, and it closes a real schema ->
renderer -> runtime-consumer -> public prompt gap.

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
custom-tool extensions, lifecycle prompt templates, expert discovery, and
expert planning prompts that force cited, risk-aware plans from durable
expertise.

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
more ecosystem-specific shapes beyond the current TypeScript CLI, no-test
TypeScript CLI with strong typecheck, complex generated-code app, monorepo,
frontend, backend service, sparse-test repo, domain-doc-heavy repo, small
library, and Rails-style application coverage.

### Fixed P1. The public orchestrator product line is now explicit

The stated vision includes an orchestrator agent that can call specialized
agents and workflows. That code exists. `OrchestratorHost` owns an agent
manager, AIW bridge, workflow registry, workflow runner, management tools, and
auto-improve scheduler: `src/core/orchestrator/host.ts:99-162`. Its chat
session intentionally has no built-in read/write/bash tools, only management
tools: `src/core/orchestrator/host.ts:233-247`.

The architecture docs and ADR now make the product decision explicit:
`docs/18-the-orchestrator.md:1-14`,
`docs/adr/0015-public-orchestration-plane.md`. The shipped async orchestration
plane is the GitHub Actions scaffold, not orchestrator or AIW:
`docs/18-the-orchestrator.md:34-50`, `docs/lifecycle/README.md:98-101`.

Impact: agentify now satisfies "GitHub issues drive Pi prompt workflows with a
separate orchestration-planner pass over generated workflows, specialists, and
experts." It does not claim "GitHub issues trigger the internal
OrchestratorHost to execute DAGs and delegate to managed worker agents."
That narrower scope is now an accepted v1 product decision, not an ambiguous
half-implemented promise.

Completed bridge:

1. `orchestrate-issue.md` is a public, credential-free routing prompt for
   issue implementation.
2. `extract-orchestration-plan.sh` validates the planner's structured output,
   rejects selected workflows/specialists/experts and validation-focus commands
   that are not present in the generated context, and renders bounded markdown
   for the implementation prompt.
3. `agent-implement.yml` runs the orchestration planner before the build agent
   and injects the rendered plan as `ORCHESTRATION_PLAN`.
4. Scaffold tests cover the extraction contract, unknown generated-context
   selections, unknown validation-focus commands, and prompt substitution.

Accepted decision: keep public v1 honest as a GitHub Actions orchestration
plane that generates and consumes repo-specific workflows, specialists, and
experts. Promoting OrchestratorHost later requires a superseding ADR with a
real hosted/deployed control plane story, queue, auth, logs, budget controls,
and failure recovery.

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
Duplicate open-PR refusal now delegates to `check-existing-issue-pr.sh`; its
contract test proves the trusted preflight only refuses PR bodies that actually
close/fix/resolve the source issue and avoids false positives such as `#420`
or non-closing references.
No-change implementation detection now delegates to
`verify-implementation-commits.sh`; a real temporary-git-repo scaffold test
proves a branch with zero commits writes the trusted failure reason before the
workflow can continue, while a branch with commits passes with the expected
commit count.
Update-branch stale-push protection now delegates to
`push-updated-branch.sh`; a stubbed scaffold test proves only `agent/*`
branches are pushed, `AGENT_PAT` is scoped into `gh`, force-with-lease is used
with the expected remote head SHA, and stale remote rejection writes the
trusted failure reason. PR review fixup pushes now use the same trusted script
with an operation label, so review-time fixup commits get the same branch guard
and stale-remote handling as update-branch.
Review verdict extraction now delegates to `extract-review-verdict.sh`, with
fixture coverage for approve, request-changes, unsupported verdicts, missing
summaries, and missing structured output.
Review verdict side effects now delegate to `complete-review-handoff.sh`; a
stubbed test proves approval comments, approval labels, draft-ready
transitions, request-changes comments, and implementation requeue use the
expected token boundary.
PR-scoped failure handoff now delegates to `mark-pr-workflow-failure.sh` for
review and update-branch runs; the contract test proves both retry labels,
stored/default reasons, blocked labeling, workflow links, and input validation.
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

Remaining gap: greenfield still needs live GitHub evidence around real API
behavior after draft PR creation and model-backed implementation/review runs.
The local/stubbed side is now much stronger:
`test-implementation-handoff-flow.sh` composes branch naming, PR metadata
extraction, draft PR creation, and final source-issue handoff through fake
`gh`/`git` with token checks. The new `smoke-github-runtime.sh` and
`smoke-drill-github-runtime.sh` add real GitHub no-LLM preflight smoke paths
for implementation and post-launch drilling, but brownfield remains the primary
credible path until greenfield has equivalent live evidence to its rendering,
gate, resume-state, dependency gating, trusted drill handoff, branch naming, PR
metadata, trusted PR publication, trusted post-PR handoff, failure handoff, and
command retry layers.

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

The workflow now also validates the refresh boundary after the model run and
again after manifest refresh. `validate-refresh-surface.sh` allows only the
agentic surface files refresh is supposed to touch, enforces the 200-line
`AGENTS.md` cap, requires managed markers, and rejects malformed expert YAML.
`refresh-managed-manifest.mjs` updates hashes in `.pi/agentify/manifest.json`
for changed or newly added managed surface files and drops removed optional
refresh-managed files. Scaffold tests cover allowed refresh edits, product-code
rejection, oversize `AGENTS.md`, malformed expert YAML, manifest hash refresh,
new surface file insertion, expert manifest entries, and removed optional files.

### Fixed P1. Defense path guards did not cover all declared write tools

The defense hook defines:

- `PATH_SENSITIVE_TOOLS = ["read", ...WRITE_TOOLS]`
- `WRITE_TOOLS = ["write", "edit", "write_file", "multi_edit"]`

Evidence: `src/core/audit/defense-hook.ts:59-60`.

The zero-access, credential-store, protected-file, and repo-jail checks now run
for `write_file` and `multi_edit` too. `tests/audit/defense-hardening.test.ts`
now covers repo-jail and protected-path blocking for those write-like tools.

### Fixed P2. `spawn_explorer` needed enforced audit budgets and recovery

The explorer tool initially said there was no hard cap on parallel sub-agents
or action limits, then only warned after the fact when read/bash caps were
exceeded.

That is now corrected for dispatch, provider-reported spend, and continuation
after exhaustion.
`spawn_explorer` enforces:

- max total sub-agent dispatches per audit tool instance;
- max concurrent sub-agents across tool instances;
- max wall-clock duration per sub-agent prompt;
- max cumulative provider-reported sub-agent cost per audit tool instance,
  with each completed sub-agent's assistant-message usage folded into future
  dispatch checks;
- structured `resume` details on every budget refusal, including the canonical
  map, run logs, completed report paths, concrete recovery actions, and the
  instruction to use honest null/open-question entries rather than fabricate
  coverage.

The builder prompt now tells the agent to treat explorer-budget exhaustion as
an instruction to inspect the `resume` details, reuse existing reports, persist
the strongest partial state through `write_map`/`write_map_delta`, narrow the
target only when budget remains, or mark remaining uncertainty honestly.
`tests/audit/spawn-explorer-budget.test.ts` covers the hard total/concurrent
dispatch guards, cumulative cost refusal with a fake sub-agent session, and the
shared structured resume contract on each exhaustion mode.

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

For issue implementation, this is now more than prompt guidance:
`verify-routing-evidence.sh` reads the trusted orchestration plan and generated
specialist/expert context after the implementation model run. If the plan
selected specialists or experts, the transcript must include a
`## Routing evidence` section citing each selected generated file path before
the workflow can proceed to commit verification and PR publication. Missing
evidence writes the trusted failure reason consumed by
`mark-implementation-failure.sh`.

For PR feedback and automated review, `verify-diff-routing-evidence.sh` derives
required routes from `git diff BASE...HEAD` plus generated specialist globs and
expert paths. If the changed paths match generated routes, the implement-PR or
review transcript must cite the matching generated files before fixup pushes or
review handoff proceed. Missing evidence writes the same trusted failure reason
path consumed by the PR blocked handoff.

This is still not universal hard enforcement. Codex and Claude exports remain
instruction surfaces, and prompt routing cannot guarantee domain locks or
expert use across every harness. The strongest domain-locking still exists in
the internal orchestrator code. The public claim is now stronger but still
honest: GitHub Actions provides trusted specialist/expert routing context
before model execution and a trusted transcript-evidence gate afterward;
hosted orchestrator-level domain locks are a separate product decision.

## Current Validation

Commands run:

```bash
npx tsx tests/agentify-core.test.ts
npx tsx tests/audit/spawn-explorer-budget.test.ts
npx tsx tests/generated-output-quality.test.ts
npx tsx tests/greenfield-state.test.ts
npx tsx tests/greenfield-artifacts.test.ts
bash scaffold/tests/test-expert-context.sh
bash scaffold/tests/test-complete-review-handoff.sh
bash scaffold/tests/test-extract-review-verdict.sh
bash scaffold/tests/test-extract-update-branch-comment.sh
bash scaffold/tests/test-check-existing-issue-pr.sh
bash scaffold/tests/test-mark-pr-workflow-failure.sh
bash scaffold/tests/test-orchestration-plan.sh
bash scaffold/tests/test-push-updated-branch.sh
bash scaffold/tests/test-refresh-managed-manifest.sh
bash scaffold/tests/test-smoke-github-runtime.sh
bash scaffold/tests/test-validate-refresh-surface.sh
bash scaffold/tests/test-verify-implementation-commits.sh
bash scaffold/tests/test-verify-routing-evidence.sh
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
Duplicate-PR preflight handling is covered by
`scaffold/tests/test-check-existing-issue-pr.sh`, which verifies exact closing
keyword matches, non-closing references, invalid issue numbers, and malformed
GitHub JSON before the implement workflow can run the model.
Stale update-branch push handling is covered by
`scaffold/tests/test-push-updated-branch.sh`, which verifies agent-branch
guarding, token scoping, force-with-lease arguments, and update-branch/review
stale rejection failure reasons.
Malformed review and update-branch model output handling is covered by
`scaffold/tests/test-extract-review-verdict.sh` and
`scaffold/tests/test-extract-update-branch-comment.sh`.
Trusted review side effects are covered by
`scaffold/tests/test-complete-review-handoff.sh`, which verifies the approval
path, request-changes requeue path, unsupported verdict failure, and the
`GITHUB_TOKEN`/`AGENT_PAT` boundary.
PR-scoped review/update-branch failure comments are covered by
`scaffold/tests/test-mark-pr-workflow-failure.sh`, which verifies blocked
labeling, retry instructions, stored/default failure reasons, workflow links,
and invalid input rejection.
The stamped no-LLM live smoke gate is covered locally by
`scaffold/tests/test-smoke-github-runtime.sh`, which verifies the fake-`gh`
sequence for repository resolution, implement-workflow discovery, label
checks, smoke issue creation, `agent:implement` labeling, preflight-refusal
polling, and cleanup.
The stamped drill no-LLM smoke gate is covered locally by
`scaffold/tests/test-smoke-drill-github-runtime.sh`, which verifies workflow
discovery, required label and `AGENT_PAT` checks, smoke issue creation,
`agent:drill-me` labeling, no-model preflight polling, cleanup, and durable
evidence output.
The stamped retry smoke gate is covered locally by
`scaffold/tests/test-smoke-retry-github-runtime.sh`, which verifies command
router workflow discovery, required label and `AGENT_PAT` checks, blocked issue
creation, `/agent retry` posting, retry-confirmation polling, and cleanup.
Refresh handoff safety is covered by
`scaffold/tests/test-validate-refresh-surface.sh` and
`scaffold/tests/test-refresh-managed-manifest.sh`, which verify the agentic
surface allowlist, `AGENTS.md` line cap, expert YAML checks, manifest hash
updates, new managed file insertion, and removed optional file cleanup.

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
expert loop now has runtime-compatible generated artifacts, public GitHub
prompt routing that includes concrete expert knowledge, and rendered plan
prompts that require cited invariants, pitfalls, file/type references,
validation selection, and stale-knowledge checks. It now also has a replay
scorer that compares generic versus expert-guided planning/review/refresh
transcripts against the expert's own files, patterns, pitfalls, validation, and
staleness requirements. That scorer is now executable against a JSON manifest
of real transcript files through `npm run score:expert-outcomes -- <manifest>`,
and public release qualification now requires passing plan, review, and refresh
expert cases. It still needs measured model-outcome evidence from a real
dogfood transcript corpus. The refresh loop has the right
default-branch trigger, deterministic stale expert detection, and a trusted
git handoff, and now has deterministic diff/manifest validation before PR
creation. It still needs real-world outcome evidence from live refresh PRs.

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
experts have crossed the structural, routing, and planning-prompt substance
thresholds, and now have a replay scorer plus a manifest-driven release gate,
but still need live dogfood outcome evidence.

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
- trusted script delegation for update-branch pushes and review fixup pushes.
- trusted script delegation for review verdict comments, approval labeling,
  draft-ready transitions, and request-changes requeueing.
- trusted script delegation for PR-scoped failure handoff in review and
  update-branch workflows.
- trusted transcript-evidence verification for issue implementation routes
  that selected generated specialists or experts.
- trusted changed-path routing-evidence verification for implement-PR and
  review runs whose diffs match generated specialists or experts.
- a stamped no-LLM live GitHub smoke script that exercises the implement
  workflow's trusted preflight refusal path.
- a stamped no-LLM live GitHub smoke script that exercises the drill workflow's
  trusted no-model smoke marker before Pi starts.
- a stamped no-LLM live GitHub smoke script that exercises the `/agent retry`
  recovery path through the trusted command router.
- a stamped model-backed GitHub smoke script that exercises issue-to-draft-PR
  creation after explicit confirmation.
- a stamped model-backed review smoke script that exercises automated PR review
  after explicit confirmation.
- a stamped model-backed refresh smoke script that dispatches the refresh
  workflow and waits for a successful run after explicit confirmation.

The remaining harness gap is now model-backed live-environment evidence: the
local/stubbed contracts are strong, the no-LLM preflight/drill/retry smokes have
passed in a staged GitHub repository, and the model-backed
implement/review/refresh smoke gates are shipped with machine-readable evidence
output plus separate and composed verifiers, but the model-backed gates still
need to be executed with real provider credentials before a broad public
release.

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
now also score expert expertise for actionable durable knowledge,
self-improve validation guidance, and plan prompts that require cited files,
types, patterns, pitfalls, validation commands, and staleness checks before
implementation. `tests/core/expert-outcome.test.ts` now replays generic versus
expert-guided plan/review/refresh transcripts and verifies the expert-guided
outputs score higher against durable expertise. The same module now loads a
release manifest of transcript file paths pinned to repo, commit, capture
timestamp, provider, and model, and
`src/core/scripts/score-expert-outcomes.ts` makes that scoring executable from
`npm run score:expert-outcomes -- <manifest>`.

Remaining work:

1. Capture real dogfood transcript manifests from model runs across planning,
   review, and refresh.

Exit criteria: generated experts are not only discoverable, but measurably
improve the agent's plans, reviews, and refresh behavior.

### Phase 3: Strengthen brownfield audit quality

Completed: TypeScript CLI, no-test TypeScript CLI with strong typecheck,
complex generated-code app, monorepo, frontend, backend service, sparse-test,
small TypeScript library, Rails-style app, domain-doc-heavy, and expert-domain
quality fixtures now score fallback `AGENTS.md`, specialist output, AI docs,
conditional docs, project workflows, expert expertise, and lifecycle prompts
for actionable validation, pitfalls, scope, first-file guidance,
package-boundary evidence, source-of-truth boundaries for generated code,
per-change validation commands such as codegen, line-cited pitfalls, generated
skill usage/precondition/validation/reporting discipline, feedback-loop report
templates, user-workflow e2e coverage, honest missing-test signaling,
domain-doc routing, expert durable-knowledge quality, and typecheck-only
validation surfaces.

Remaining work:

1. Add more benchmark fixtures for additional ecosystems as they become release
   targets.
2. Add replay/model-outcome fixtures once a stable dogfood corpus is available.

Exit criteria: agentify can prove that its generated surface is useful, not
just valid.

### Phase 4: Preserve the public orchestration boundary

ADR 0015 picks the public v1 line: keep OrchestratorHost internal and focus the
installed product on the GitHub Actions orchestration plane. Future promotion
of OrchestratorHost needs a superseding ADR and an operations story:

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
current focus, exact artifact paths, local/GitHub continuation instructions,
and a structured `github_handoff` with the next GitHub action, issue title,
body, labels, and referenced artifacts. The scaffold resume renderer now
includes that handoff in the drill prompt, and the prompt maps handoff actions
to final-output issue arrays. Approved, unblocked implementation handoffs can
activate the implement workflow through the trusted issue applier, with open
blockers downgraded to queued-only. Reused implementation issues are activated
against their current GitHub body and state, not the newly requested handoff
body.
The GitHub drill workflow now renders that resume context into its prompt before
the model chooses a one-transition next step, and the trusted workflow applies
structured issue requests after the credential-free model run.

Remaining work:

1. Execute and record the model-backed implement/review/refresh smoke gates in a
   staged GitHub repository.
2. Capture plan/review/refresh expert outcome transcript manifests from real
   dogfood runs.
3. Decide whether greenfield should remain secondary to brownfield or receive
   the same release bar.

Exit criteria: greenfield has the same mechanical reliability as brownfield.

## Final Answer To The Vision Question

Does agentify satisfy the vision today?

Partially.

It satisfies the first major slice: a user can run one command in a brownfield
repo, agentify can audit it, generate repo-specific agent context, install
skills, stamp a GitHub runtime, and let GitHub issues drive implementation PRs.
That is a real product foundation.

It does not yet satisfy the full "agentic codebase lives on its own" vision in
the sense of a hosted internal OrchestratorHost running DAGs. ADR 0015 now
defines the public v1 version of that vision: GitHub Actions is the shipped
orchestration plane, and it consumes generated workflows, specialists, and
experts through trusted prompt/context injection plus route validation.
Experts, skills, feedback-loop state, custom-tool candidates, and project
workflow specs now have deterministic renderer coverage, experts and workflows
are proven discoverable by their runtime registries, generated workflows are
injected into GitHub implement prompts, generated specialists are injected into
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
