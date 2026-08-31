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

- Exact `4bfc709cbb09365323390d686febc453a33fc15b` passed `verify:release` locally, including all 97 test files and ten executable corpus cases. Its CI passed on Node 22.19.0 and Node 24, including package/scaffold, full audit, and CodeQL. Subsequent production changes require fresh qualification.
- Hono and Gin each failed two same-HEAD invocations on that SHA. They retained eight and ten draft concerns, not installed teams. Aggregate harness wall times were 2,000,498 ms and 1,519,370 ms. Each invocation emitted exactly one terminal result; original file hashes were unchanged. Only the permitted diagnostic map remained.
- Gin exhausted 24 explorers with shared core-ownership conflicts and untraced new proposals. Hono reached the 30-minute aggregate audit deadline with public surfaces, behavioral clusters, and failed tracers unresolved. Its total harness wall time exceeded 30 minutes; no runtime pass is claimed.
- First-invocation reported usage reconciles to parent plus explorer responses. No later explorer session events were observed, but SDK disposal disconnects listeners; absence of events alone does not prove provider settlement. Interrupted requests were not counted at admission. New deterministic regressions cover admitted-but-interrupted calls, terminal lineage accounting, deadline-arrival usage, and cancellation without fabricated response usage. Complete live accounting verification remains required.
- Hono's newer draft correctly describes lazy matcher compilation, but misattributes an imported implementation's flow path and generalizes a backend-specific restriction to all routers. Quick remains uncovered. Source-local and implementation-specific tracer instructions now address those general failure modes, but correction is not claimed until fresh generated output passes inspection. Draft review does not count toward the three installed-team reviews.
- Development installations on earlier commits do not qualify later production code. No final candidate or two clean qualification rounds have been established.

## Known limitations

- Hono still fails convergence and has exposed false attachment, generic-portfolio, and unsupported narrative risks. Safe failure remains necessary but is not successful product qualification.
- The reduced corpus now exercises real compilation, installation, readiness canaries, and validation-failure rollback, with only GitHub operations replayed. It does not replace live generation or maintainer-quality review.
- Validation commands execute in disposable exact-HEAD checkouts with scrubbed credentials, but Agentify does not provide container or network isolation.
- Pinned Click delegates contribution rules to Pallets' external policy. Its classification as an installation-required non-policy case conflicts with the task's policy constraints; no new Click writes or policy bypass have been performed.
- Live model outcomes are nondeterministic. The executable replay corpus, compiler invariants, and package qualification remain the authoritative repeatable release gates.

## Recommendation

Do not merge. Keep the existing branch and non-draft PR. One exact final SHA must install all eight non-policy historical teams and at least five of six non-policy held-outs in each of two unchanged-production rounds, pass manual team review on three materially different repositories, and pass supported-Node, package/scaffold, dependency-audit, delivery-integrity, CI, and CodeQL gates. Diagnostic-only counts as failure unless required tooling is unavailable. No merge is authorized.
