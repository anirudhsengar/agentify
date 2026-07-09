# Agentify 10/10 Roadmap

This roadmap tracks the work required for agentify to become a production-grade
agentic engineering platform rather than only a bootstrap scaffold.

## Current Target

Agentify should let a maintainer run one command in a brownfield repository,
review the generated agentic surface, configure GitHub once, and then drive
work through issues and PRs while the repository keeps its agent knowledge
fresh.

## Release Gates

1. `npm test`, `npm run test:scaffold-e2e`, and `npm pack --dry-run` pass.
2. Brownfield audit output is deterministic, schema-validated, and only applied
   after all coverage dimensions close.
3. Generated experts are runtime-compatible directories under
   `.pi/prompts/experts/<domain>/`.
4. Generated specialist workflows are valid project workflow specs under
   `.pi/workflows/`, discoverable by the orchestrator `WorkflowRegistry`, and
   summarized into the GitHub implement prompts as routing guidance.
5. The stamped GitHub loop can implement, review, requeue, update branches, and
   report failures without exposing repository push tokens to the model process.
6. Public docs describe only behavior that the installed product actually
   provides.
7. Greenfield sessions record typed checkpoint state and do not install the
   GitHub runtime scaffold unless the planning artifacts pass the substance
   gate.
8. Greenfield planning artifacts are rendered deterministically from structured
   formation data submitted through `write_greenfield_artifacts`.
9. Greenfield structured formation enforces `stop_at` milestone gates, rejecting
   artifacts beyond the user-approved checkpoint.
10. Greenfield state persists resume context: source, `stop_at`, current focus,
   exact artifact paths, and local/GitHub continuation instructions.
11. The GitHub drill workflow injects rendered formation resume context into
   its prompt, runs Pi without GitHub credentials, and applies structured
   child/PRD/implementation issue requests through trusted shell steps.
12. External beta and public release candidates have a filled release evidence
   ledger that records local gates, staged GitHub smoke links, model/provider
   details, and expert outcome transcript scores.
13. Public release evidence is checked through one combined gate that requires
   both staged GitHub smoke evidence and expert outcome transcript evidence.

## Priority Tracks

### P0: Product Honesty

- Keep README, lifecycle docs, builder prompt, schema, renderer, and tests in
  lockstep.
- Remove or implement any generated artifact family before documenting it as a
  user-visible capability.
- Keep internal runtimes clearly marked as internal until they have a supported
  deployment path.

### P0: Expert Loop

- Render `expertise.yaml`, `question.md`, `self-improve.md`, `plan.md`, and
  `plan_build_improve.md` from structured map evidence.
- Prove rendered experts are discoverable through `ExpertRegistry.fromCwd`.
- Refresh expert knowledge after relevant agent or AIW runs.
- Keep expert plan prompts cited and risk-aware: they must carry key
  files/types, patterns, pitfalls, validation commands, and staleness checks
  from `expertise.yaml` into the planning surface.
- Score expert-guided plan/review/refresh transcripts against the generated
  expertise so generic outputs and expert-aware outputs are measurably
  different before relying on live dogfood evidence.
- Keep expert outcome replay executable through
  `npm run score:expert-outcomes -- <manifest>`, where the manifest references
  generated `expertise.yaml`, baseline transcripts, expert-guided transcripts,
  the required score delta, and the staged repository, candidate commit,
  capture timestamp, provider, and model.
- Render project workflow specs that connect generated specialists to the
  canonical plan/build/review/fix AIW loops and prove the orchestrator registry
  discovers them.
- Render project workflow context into the stamped GitHub implement prompts so
  generated workflows affect the shipped issue/PR loop before full orchestrator
  hosting exists, and validate orchestration-planner selections against that
  generated workflow/specialist/expert context.
- Keep selected and changed-path specialist/expert routes auditable after
  model runs: when the orchestration planner selects generated routes, or a PR
  diff matches generated routes, the transcript must cite the selected/matched
  `.pi/agents/*` and `expertise.yaml` files before the trusted workflow can
  publish a PR, push fixups, or post review handoff.

### P1: Audit Quality

- Keep the code-enforced per-dimension substance validators for D1-D10 in
  lockstep with the builder prompt.
- Feed validator failures back into `gap_filler` so the builder closes concrete
  gaps rather than vague coverage labels.
- Build a fixture suite that scores generated surfaces across representative
  repository shapes. Current fixtures cover TypeScript CLI, no-test TypeScript
  CLI with strong typecheck, complex generated-code app, monorepo, frontend
  app, backend service, sparse-test, small library, Rails-style app,
  domain-doc-heavy, and expert-domain surfaces, including expert planning
  prompt substance, source-of-truth boundaries for generated code, generated
  skill operational guidance, line-cited pitfalls, per-change validation
  commands, and feedback-loop report templates.

### P1: GitHub Runtime

- Keep the model process credential-free.
- Maintain scaffold contract tests for malformed model output, stale branches,
  no-change turns, blocked issues, duplicate open-PR refusal, and retry paths.
- Keep PR mutation pushes, including update-branch and review fixups, behind
  trusted scripts with agent-branch guards and force-with-lease.
- Keep PR review side effects behind trusted scripts, including approval
  labels, draft-ready transitions, and request-changes requeueing.
- Keep review/update-branch failure handoff behind a shared trusted script so
  blocked labels, retry comments, failure reasons, and workflow links stay
  deterministic.
- Ship a no-LLM live GitHub smoke gate that exercises workflow events and
  trusted implement preflight refusal before model-backed smoke tests run.
- Ship a no-LLM live GitHub smoke gate that exercises the post-launch drill
  workflow's trusted smoke marker and proves it exits before Pi starts.
- Ship a no-LLM live GitHub smoke gate that exercises `/agent retry` from a
  blocked issue through the trusted command router.
- Ship a model-backed GitHub smoke gate that creates a queued issue and waits
  for the implement workflow to open a draft PR.
- Ship a model-backed review smoke gate that waits for automated approval,
  request-changes requeue, or blocked failure on an agent-owned PR.
- Ship a model-backed refresh smoke gate that dispatches the self-refresh
  workflow and waits for a successful run.
- Keep a durable release evidence ledger for staged no-LLM/model-backed smoke
  results, workflow links, provider/model details, and expert outcome transcript
  scores. Every staged smoke script should write `agentify.smoke-evidence.v1`
  JSON through `--evidence-file` so release proof is durable by default. That
  evidence must include the candidate commit SHA, and
  `npm run verify:smoke-evidence -- <files>` should fail release candidates with
  missing, duplicate, failed, cross-repo, cross-commit, or URL-thin smoke
  evidence.
- Keep public-release qualification as one composed command:
  `npm run qualify:release-evidence -- --repo <owner/name> --commit <sha> --since <iso> --expert <manifest> --smoke <file>...`.
  It must fail when evidence is stale, from the wrong repository or commit,
  when either staged GitHub evidence or expert outcome evidence is absent or
  weak, when expert outcome metadata is not pinned to the same repository,
  commit, and evidence window, and when expert evidence does not cover plan,
  review, and refresh modes.
- Make refresh trigger the actual default branch, not only `main` and `master`.
- Keep refresh git handoff trusted: the model edits only, while the workflow
  commits, pushes, opens PRs, and still handles already-committed changes.
- Keep refresh handoff deterministic: validate that the model changed only the
  agentic surface and refresh managed-file manifest hashes before opening the
  PR.
- Ensure drill-me issues can post a structured follow-up reply even when no repo
  files changed.

### P1: Greenfield

- Keep strengthening greenfield beyond typed formation rendering, checkpoint
  state, `stop_at` gates, persisted resume context, structured GitHub handoff
  data, and the artifact substance gate.
- Treat local terminal formation and post-launch GitHub drilling as one
  resumable workflow, with trusted issue creation and broader edge-case
  simulation coverage.

### P2: Orchestrator Boundary

- Preserve ADR 0015: public v1 orchestration is the GitHub Actions plane, and
  OrchestratorHost remains internal foundation code.
- If a future release promotes OrchestratorHost, define deployment, auth, state,
  cost/log visibility, upgrade, resume, and rollback behavior in a superseding
  ADR before documenting it as product surface.

## Non-Negotiables

- No generated file is written without a managed marker and ownership check.
- No partial brownfield success writes the user-facing agentic surface.
- No greenfield scaffold install happens from placeholder or thin planning
  artifacts.
- No model process receives ambient push credentials.
- No expert feature is considered complete unless the generated files are
  consumed by the runtime that claims to use them.
