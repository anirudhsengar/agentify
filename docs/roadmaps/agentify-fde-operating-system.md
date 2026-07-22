# Agentify FDE operating-system roadmap

This is a living roadmap for development after the verified Milestone 0
baseline. It describes direction, not a promise that planned FDE capabilities
already exist.

## Product thesis

Agentify can become an operating system for forward-deployed engineering by
combining evidence-based understanding of an unfamiliar repository with a
controlled delivery lifecycle. The product should turn an approved unit of
work into a reviewable change while preserving human authority, repository
policy, and reproducible evidence at every gate.

The initial vertical is deliberately narrow: **an approved GitHub issue to a
safe, human-reviewed draft pull request in an unfamiliar brownfield
repository**. Success means making that path dependable before generalizing it.

## Current product boundary

The supported product today is the installed `agentify` CLI. It provides
brownfield audit and comprehension, greenfield formation, deterministic
artifact rendering, provider-scoped state, crash-recoverable state
transactions, managed-file ownership protections, harness exports, and an
optional GitHub runtime scaffold. The documented CLI options and utility
commands are the public runtime surface.

The following remain internal and experimental:

- `src/core/aiw/`;
- `src/core/orchestrator/`, including its communications transport;
- `src/core/webhook/`; and
- the Agent Expert runtime.

Their source and tests do not make them supported APIs. Every milestone must
preserve this boundary unless a separate graduation decision satisfies
`docs/experimental-surfaces.md`. FDE work must not incidentally add a CLI
route, package export, build copy, or public service for an experimental
runtime.

## Starting position

Current strengths include structured model output, read-only brownfield
evidence collection, deterministic validation and rendering, transactional
apply and rollback, managed-file conflict protection, explicit capability
policies, provider-scoped state, installed-package checks, and broad parity,
maintenance, security, scaffold, and release tests.

The missing FDE layers are engagement qualification, explicit prioritization
and decision records, outcome-oriented evaluation, shadow and pilot controls,
measurement across engagements, and a governed path from repeated delivery to
productized capability. These are planned layers; no complete FDE engagement
implementation exists yet.

## Target lifecycle

The initial lifecycle is:

1. **Qualify** — confirm the issue, repository, access, constraints, owner, and
   success criteria are suitable.
2. **Audit** — collect read-only evidence about architecture, policy, tests,
   ownership, and risk.
3. **Map** — produce a structured, traceable model of the relevant code and
   change surface.
4. **Prioritize** — rank candidate work by value, risk, uncertainty, and
   dependency.
5. **Decide** — record the approved scope, acceptance criteria, constraints,
   and human decision maker.
6. **Build** — implement the smallest approved change within explicit
   capabilities.
7. **Evaluate** — run repository validations and assess the change against the
   decision record.
8. **Shadow** — exercise the workflow without granting production authority,
   comparing its proposal with human action.
9. **Draft** — publish a draft PR with evidence, limitations, and review
   instructions; never merge automatically.
10. **Pilot** — operate the bounded workflow with named humans and repositories.
11. **Measure** — track quality, reversals, review effort, cycle time, safety
    events, and outcome attainment.
12. **Productize** — promote only repeated, measured, governed capabilities
    into the supported product.

## Milestone sequence

1. **Milestone 0 — verified baseline.** Record the product boundary,
   architecture, test surface, environment, known gaps, and green validation
   baseline.
2. **Milestone 1 — engagement contract (complete).** Define typed qualification,
   approval, scope, evidence, and outcome records without exposing experimental
   runtimes. The supported `agentify engage init|status|validate|report` surface
   exposes deterministic records and analysis only; it is not an autonomous FDE.
3. **Milestone 2 — issue-to-plan evidence path.** Connect an approved issue to
   bounded audit, mapping, prioritization, and a human decision checkpoint.
4. **Milestone 3 — safe build and evaluation.** Produce a constrained change
   and repository-native validation evidence with deterministic handoff.
5. **Milestone 4 — shadow-to-draft pilot.** Exercise the full vertical in
   selected brownfield repositories and create human-reviewed draft PRs only.
6. **Milestone 5 — measurement and hardening.** Establish outcome metrics,
   failure taxonomy, recovery drills, security review, and pilot exit criteria.
   Milestone 5D hardening is complete: draft execution has measured/reserved
   budget admission, an active application deadline, idempotent PR recovery,
   and operator-confirmed owned-orphan cleanup. This does not begin Milestone 6.
7. **Milestone 6 — productization decision.** Graduate only evidence-backed
   capabilities through explicit architecture, security, package, and release
   review.

Each milestone must leave the supported installed-CLI boundary intact and the
existing validation surface green.

## Safety, evidence, and release discipline

- Human approval is required for scope, pilot participation, PR review, and
  any production decision.
- Model proposals remain untrusted until accepted by application-owned schemas,
  deterministic gates, and repository validations.
- Tools, readable and writable roots, protected paths, shell posture, network
  posture, limits, and ownership must be explicit for every model-backed run.
- User-owned files, branch protections, repository policies, and release hooks
  are never bypassed.
- Draft PRs carry provenance, validation results, unresolved risks, and a clear
  statement of what was not evaluated.
- A milestone needs reproducible tests, failure and recovery evidence, security
  review proportional to its trust boundary, and measured acceptance criteria.
- Releases remain tag-only and artifact-driven; experimental code is not
  graduated through documentation or incidental reachability.

## Explicit non-goals

- No general enterprise workflow platform yet.
- No hosted control plane yet.
- No public webhook service yet.
- No full public orchestrator yet.
- No automatic merging.
- No bounded autonomous production mode yet.
- No policy-autonomous production mode.
- No model-routing platform yet.
- No web dashboard yet.
- No replacement for the human FDE.
