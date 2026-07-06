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
- Render project workflow specs that connect generated specialists to the
  canonical plan/build/review/fix AIW loops and prove the orchestrator registry
  discovers them.
- Render project workflow context into the stamped GitHub implement prompts so
  generated workflows affect the shipped issue/PR loop before full orchestrator
  hosting exists.

### P1: Audit Quality

- Keep the code-enforced per-dimension substance validators for D1-D10 in
  lockstep with the builder prompt.
- Feed validator failures back into `gap_filler` so the builder closes concrete
  gaps rather than vague coverage labels.
- Build a fixture suite that scores generated surfaces across representative
  repository shapes. Current fixtures cover TypeScript CLI, monorepo, frontend
  app, backend service, sparse-test, small library, Rails-style app,
  domain-doc-heavy, and expert-domain surfaces.

### P1: GitHub Runtime

- Keep the model process credential-free.
- Maintain scaffold contract tests for malformed model output, stale branches,
  no-change turns, blocked issues, and retry paths.
- Make refresh trigger the actual default branch, not only `main` and `master`.
- Keep refresh git handoff trusted: the model edits only, while the workflow
  commits, pushes, opens PRs, and still handles already-committed changes.
- Ensure drill-me issues can post a structured follow-up reply even when no repo
  files changed.

### P1: Greenfield

- Keep strengthening greenfield beyond typed formation rendering, checkpoint
  state, `stop_at` gates, persisted resume context, and the artifact substance
  gate.
- Treat local terminal formation and post-launch GitHub drilling as one
  resumable workflow, with trusted issue creation and broader edge-case
  simulation coverage.

### P2: Orchestrator Promotion

- Decide whether the orchestrator remains internal foundation code or becomes
  the public runtime.
- If promoted, define deployment, auth, state, cost/log visibility, upgrade,
  resume, and rollback behavior before documenting it as product surface.

## Non-Negotiables

- No generated file is written without a managed marker and ownership check.
- No partial brownfield success writes the user-facing agentic surface.
- No greenfield scaffold install happens from placeholder or thin planning
  artifacts.
- No model process receives ambient push credentials.
- No expert feature is considered complete unless the generated files are
  consumed by the runtime that claims to use them.
