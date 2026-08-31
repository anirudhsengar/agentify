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

The archived 80-file inventory is retained separately. The current machine-readable inventory enumerates the stabilization branch through production commit `fdedf98077c86c520ac386f0736186936834a1e3`. Delivery-integrity inspection must pass again on the exact final candidate.

## Current development evidence

- Exact production `20b3a9eb7d72b938a4a30b9e5e873c6bbeacef46` passed Node 22.19.0 `verify:release`: all 97 source test files, ten executable compiler/install corpus cases, scaffold, five packed-package qualifications, and dependency audit with zero vulnerabilities. Artifact SHA-256: `f877387cc9380a53b89d55c40e99a28129db4912f81568aeabd58c04c74d6358`. Later Go correction `fdedf98077c86c520ac386f0736186936834a1e3` requires a fresh exact-SHA release/CI run; no live results carry forward.
- The latest completed live matrix used exact `83dd8578d2e7cca297ca124c318ef5ed9a4e236d`, package hash `c6be50d345f290a1e115bbb9ed2ce0b3e4f965cbc22da064952722a477bb3252`, Node 22.19.0, and unchanged configured models/authentication. That SHA passed CI on Node 22/24, package/scaffold, audit, and CodeQL, but failed product qualification.

| Latest fresh live cases | Installed | Result |
| --- | ---: | --- |
| Commander, AQA, Cobra, Hono, Gin, Axum, Petclinic | 0/7 attempted | Failed; Click remains policy-prohibited pending replacement decision |
| Preact, PyJWT, Chi, Thiserror, JCommander, Mustache — round 1 | 0/6 | Failed |
| Held-out round 2 | Not run | No consecutive clean rounds |

- All thirteen fresh model runs preserved original application-file hashes and each had one terminal event. Four terminal events falsely reported success before finalization rolled back: Chi, Mustache, PyJWT, and Petclinic. The subsequent installer-owned terminal correction has deterministic coverage but still needs live qualification.
- Six runs hit the external 30-minute timeout; all thirteen had unanswered model requests, so reported cost and token totals are incomplete. Maps ranged up to 301,477 bytes. No complete runtime/accounting gate pass is claimed.
- Petclinic initially used the wrong installed JDK. Java 17 was already available: this was a harness error, not unavailable tooling. A same-SHA continuation using JDK 17 and its prior validated map installed seven specialists and eight procedures, with `./gradlew check` and `./gradlew test` verified. It is not a clean qualification round.
- Manual inspection **failed that installed team**. The vet specialist invents an Atom-feed contract, says caching is unused despite both repository methods having `@Cacheable("vets")`, and describes lazy loading despite `FetchType.EAGER`. It also confuses the backing Set initializer with the public sorted-list accessor. The root-landing specialist is overfragmented. Two complete profiles were reviewed; the other five were not fully reviewed. There are zero passing installed-team reviews, not three.
- Hono's draft still falsely attributes a post-build add prohibition to PreparedRegExpRouter and says SmartRouter tries every candidate despite an early successful break. These claims are recorded as failures, not corrected or accepted.
- Live tracer cancellation on 83dd stopped 11 ms after an actual provider response update and preserved a failed receipt with no repository writes. Final usage for the interrupted request was unavailable; cancellation passed its bounded probe, complete accounting did not.
- Subsequent general corrections retain dependency evidence across 512-file batches, reuse unchanged attested tracer claims, defer terminal status until installation finishes, reject portfolio-erasing model writes, and recognize dependency-free Go modules without checksums. No repository-name conditions, closure relaxation, or model/authentication changes were introduced.

## Decisions blocking final qualification

Click's contribution prohibition conflicts with the requirement to install all eight named historical repositories. It needs reclassification as policy-negative and a replacement non-policy case; its policy will not be bypassed.

Mustache and Thiserror intentionally ignore dependency lockfiles, and PyJWT has no committed lock. Agentify currently requires committed dependency locks for reproducible operational validation. Permission to use externally captured validation locks is a product decision, not an implemented exception. Dependency-free Go is a separate established ecosystem contract: [Go permits absent go.sum when there are no dependencies](https://go.dev/ref/mod).

The machine-readable report records `release_ready=false`, `final_candidate_sha=null`, exact per-run provenance, failed gates, and the current complete changed-file inventory.
## Known limitations

- Hono still fails convergence and has exposed false attachment, generic-portfolio, and unsupported narrative risks. Safe failure remains necessary but is not successful product qualification.
- The reduced corpus now exercises real compilation, installation, readiness canaries, and validation-failure rollback, with only GitHub operations replayed. It does not replace live generation or maintainer-quality review.
- Validation commands execute in disposable exact-HEAD checkouts with scrubbed credentials, but Agentify does not provide container or network isolation.
- Pinned Click delegates contribution rules to Pallets' external policy. Its classification as an installation-required non-policy case conflicts with the task's policy constraints; no new Click writes or policy bypass have been performed.
- Live model outcomes are nondeterministic. The executable replay corpus, compiler invariants, and package qualification remain the authoritative repeatable release gates.

## Recommendation

Do not merge. Keep the existing branch and non-draft PR. One exact final SHA must install all eight non-policy historical teams and at least five of six non-policy held-outs in each of two unchanged-production rounds, pass manual team review on three materially different repositories, and pass supported-Node, package/scaffold, dependency-audit, delivery-integrity, CI, and CodeQL gates. Diagnostic-only counts as failure unless required tooling is unavailable. No merge is authorized.
