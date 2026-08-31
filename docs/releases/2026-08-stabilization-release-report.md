# Specialist compiler stabilization release report

Not release-ready. Do not merge PR #13. The earlier release recommendation is withdrawn: bounded, atomic failure does not qualify specialist-team generation.

The archived candidate below is `e1186861095ac543b4bef9e4f97ca09a76918be8`, built from base `f2df9eb8563bfcb26919d82c7bf28c9fb7c19e8b`. Its Node 22.19.0 packed artifact is 8,060,372 bytes with SHA-256 `acf4a0f09b6739249b5418f7f1bc21ca4f99d98baa2d1c3286cf23dab0c5bb1e`. This is historical evidence, not qualification of the current branch.

The implementation now treats specialist generation as a bounded, fail-closed compiler. Repository evidence and application-attested explorer receipts feed concern proposals; deterministic normalization resolves ownership; validation checks normalized closure and fixed-point idempotence; only the exact validated output can materialize; and the installation transaction rolls back every operational artifact on failure or termination. Restrictive tracked policy is evaluated before persistent mutation. Repository validation runs in disposable checkouts.

## Archived qualification: failed

- `mise exec node@22.19.0 -- npm run verify:release` passed on the evaluated production SHA: delivery-integrity inspection, strict typecheck, 95 recursively discovered source test files, nine executable historical replay cases, documentation/package contracts, focused invariants, scaffold E2E, exact packed-package qualification, and a zero-vulnerability full dependency audit.
- The historical matrix on `b35b17e492bda6bbbd2d1cc90453da30e568b367` installed **0/8 non-policy teams**. Commander.js, aqa-tests, Click, Cobra, Hono, Gin, Axum, and Spring Petclinic were diagnostic-only: all failed product qualification. Lobsters correctly refused writes. These results cannot be carried forward as exact-candidate qualification.
- Both unchanged-production held-out rounds on `e118686` installed **0/6 non-policy teams**. Vitest, ItsDangerous, Groupcache, Anyhow, JUnit4, and Rack were diagnostic-only. Both rounds failed the required minimum of five installations. Emacs correctly refused writes.
- Every accepted live invocation stayed at or below 96 calls, 96 turns, two million input/cache tokens, 200,000 output tokens, USD 20, 16 explorers, and 1.8 million aggregate audit milliseconds. Every audit invocation emitted one budget event and one terminal result.
- Exact target comparisons found no application-code mutation or build/cache residue. Failed analyzable runs retained only `.agentify/runtime/audit/codebase_map.json`; restrictive-policy cases retained nothing.

The complete machine-readable evidence summary is [`2026-08-stabilization-evaluation.json`](./2026-08-stabilization-evaluation.json).

## Changed-file policy

The archived 80-file inventory in the machine-readable report is not the current branch inventory. A complete fresh changed-file enumeration and forbidden-artifact inspection are still required on the final candidate.

## Current development evidence

- Exact `f58ad2e36419a3d8aa4fb7a4c606036b0e4d72f3` passed local release qualification and CI on Node 22/24, including package/scaffold, audit, and CodeQL. Its live generation still failed.
- Hono, Gin, and Commander each failed two same-HEAD invocations, retaining six, nine, and eight draft concerns—not installed teams. Combined harness wall times were 1,829,722 ms, 1,766,563 ms, and 1,477,126 ms. Hono exceeded 30 minutes. Every invocation had one terminal event; original application-file hashes remained unchanged. Only the permitted diagnostic map changed.
- Hono lost previously traced concern bodies during repair and reopened receipt/public-surface obligations. Gin exhausted its explorer allowance with unresolved clusters and an invalid delegated owner. Commander retained seven core owners for `lib/command.js` and lacked public-type ownership.
- Actual installed-SDK tests reproduced denied HTTP requests escaping swallowed extension errors. Explicit transport cancellation now prevents dispatch, and synthetic denial messages are not charged as provider responses. Valid typed reports can execute at the tracer's local call limit and terminate the child without a prose acknowledgement.
- Session deadlines no longer erase the existing bounded coverage-recovery allowance; aggregate time includes prior checkpoints and reported overruns remain charged. The unaccounted connectivity probe was removed from production installation; the real audit already provides credential recovery. Configured models, authentication, and budget limits were not changed.
- Exact `5b36f352b4fda5f7fb61a446757c730d781dcd31` passed all 97 source tests and ten corpus cases. A later full run found a test comparing two clock snapshots across a millisecond boundary; `764384c` corrects that assertion. The next exact candidate still needs full release and live qualification.
- Hono's newer draft narrows matcher-lock claims to SmartRouter, but backend implementation and Quick preset coverage remain incomplete. No narrative-quality or installed-team review pass is claimed.
- Six fresh policy-screened held-outs are pinned: Preact, PyJWT, Chi, Thiserror, JCommander, and Mustache. They have not been live-qualified. Attrs remains read-only as a policy-negative case. No final candidate or two clean rounds have been established.

## Known limitations

- Hono still fails convergence and has exposed false attachment, generic-portfolio, and unsupported narrative risks. Safe failure remains necessary but is not successful product qualification.
- The reduced corpus now exercises real compilation, installation, readiness canaries, and validation-failure rollback, with only GitHub operations replayed. It does not replace live generation or maintainer-quality review.
- Validation commands execute in disposable exact-HEAD checkouts with scrubbed credentials, but Agentify does not provide container or network isolation.
- Pinned Click delegates contribution rules to Pallets' external policy. Its classification as an installation-required non-policy case conflicts with the task's policy constraints; no new Click writes or policy bypass have been performed.
- Live model outcomes are nondeterministic. The executable replay corpus, compiler invariants, and package qualification remain the authoritative repeatable release gates.

## Recommendation

Do not merge. Keep the existing branch and non-draft PR. One exact final SHA must install all eight non-policy historical teams and at least five of six non-policy held-outs in each of two unchanged-production rounds, pass manual team review on three materially different repositories, and pass supported-Node, package/scaffold, dependency-audit, delivery-integrity, CI, and CodeQL gates. Diagnostic-only counts as failure unless required tooling is unavailable. No merge is authorized.
