# agentify 10/10 roadmap

This roadmap turns the repository audit into agent-sized implementation
work. The target is not "more features"; it is making the product true:

> A user runs `agentify` once in a repo, reviews a safe generated diff,
> pushes it, and then drives most work through GitHub issues, comments,
> and PRs with Pi as the hardened agent harness.

## North-star product contract

agentify is 10/10 when all of these are true:

1. **One command is enough to bootstrap safely.** `agentify` performs
   auth/preflight, audits, stages generated output, validates it, applies
   it transactionally, and reports exact next steps.
2. **No partial user-facing writes.** Failed or partial audits leave no
   `AGENTS.md`, scaffold, harness exports, or generated prompt surface in
   the working tree unless they were part of a validated applied bundle.
3. **Generated intelligence is structured first.** The LLM writes only
   validated maps/reports/intents; TypeScript renderers produce files.
4. **Readiness is content-validated.** A repo is "ready" only when
   required files are agentify-managed and match the manifest/schema.
5. **The GitHub loop is real and safe.** Issues/comments/PRs route work,
   report state, enforce human gates, and run Pi through the same defense
   model as local bootstrap.
6. **The generated surface is evaluated.** Fixture repos, golden outputs,
   workflow simulation, and red-team tests prevent regressions.
7. **Docs match the shipped package.** Users can install from npm and every
   linked doc/setup file resolves in the environment where it is read.

## Evidence from the audit

The highest-priority failures are grounded in current files:

- `src/core/run-agentify.ts` lets the builder write files before
  `readFinalAuditState()` decides success. A partial audit can leave
  `AGENTS.md`, `specs/README.md`, and `ai_docs/README.md` behind.
- `src/core/repo-status.ts` treats path existence as readiness; it does
  not verify managed markers, hashes, or workflow content.
- `src/core/artifact-exporters.ts` and `src/core/scaffold-installer.ts`
  report conflicts, but `runAgentify()` can still persist `repoStatus:
  "ready"` with critical scaffold conflicts.
- `src/core/audit/prompts/builder.md` asks the LLM to write most of the
  agentic surface directly, including `.pi/prompts`, `.pi/extensions`,
  `.pi/skills`, experts, and feedback-loop state.
- `src/core/pi-sdk-runtime.ts` attaches the local defense hook, while
  `scaffold/.github/actions/run-pi/action.yml` runs raw `pi --approve`
  without the same hook.
- `scaffold/SETUP.md` links to `docs/adr/...`, but `npm pack --dry-run`
  does not publish `docs/`, and target repos do not receive agentify's
  ADR tree.

## Work sequencing

```text
Phase 0: product invariants and tests
  001, 002

Phase 1: safe bootstrap core
  003 -> 004 -> 005

Phase 2: deterministic generated intelligence
  006 -> 007

Phase 3: real GitHub loop and CI safety
  008 -> 009 -> 010

Phase 4: greenfield/docs/release hardening
  011 -> 012 -> 013
```

Parallelization:

- `001` and `002` can run together.
- `006` can begin after `003` defines the manifest/staging shape.
- `008` can begin after `005` defines ready/partial semantics.
- `012` can run any time, but should be finalized after scaffold changes.

## Agent operating rules

Use one issue file per coding agent. Each file is intentionally scoped to
fit one focused PR.

For every PR:

1. Read this README and the issue file.
2. Read the evidence files named in the issue.
3. Add or update tests before changing behavior where possible.
4. Run `npm run typecheck` and the narrow relevant tests.
5. If changing product behavior, update README/docs in the same PR.
6. Do not weaken the single public CLI contract in ADR 0008.
7. Do not add runtime dependencies without an ADR.

Full gate before merging a milestone:

```bash
npm test
npm pack --dry-run
```

## Issue index

| ID | Title | Depends on | Main outcome |
|---|---|---|---|
| [001](issues/001-product-invariants.md) | Product invariants test harness | none | Repro tests for audit failures |
| [002](issues/002-error-handling-and-cli-polish.md) | CLI error handling and UX polish | none | No stack traces for expected errors |
| [003](issues/003-managed-manifest-and-readiness.md) | Managed manifest and readiness model | 001 | Content-based initialized/partial detection |
| [004](issues/004-transactional-bootstrap.md) | Transactional bootstrap apply | 001,003 | No partial user-facing writes |
| [005](issues/005-conflict-policy.md) | Conflict policy blocks false success | 003,004 | Critical conflicts keep repo partial |
| [006](issues/006-structured-artifact-intents.md) | Structured artifact intents | 003 | LLM output contracts for generated files |
| [007](issues/007-deterministic-renderers.md) | Deterministic artifact renderers | 006 | TypeScript renders generated surface |
| [008](issues/008-ci-defense-wrapper.md) | Hardened CI Pi wrapper | 001 | Same safety floor in GitHub Actions |
| [009](issues/009-github-state-machine.md) | GitHub async state machine | 008 | Real label/comment routing and status |
| [010](issues/010-workflow-e2e-tests.md) | GitHub workflow E2E simulation | 008,009 | Fake-Pi workflow regression suite |
| [011](issues/011-greenfield-controller.md) | Greenfield session controller | 004 | Real checkpointed terminal formation |
| [012](issues/012-docs-and-package-alignment.md) | Docs/package/setup alignment | none | npm and stamped docs resolve correctly |
| [013](issues/013-release-readiness-gates.md) | Release readiness gates | all | Beta/publish checklist and gates |

