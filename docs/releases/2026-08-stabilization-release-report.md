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

- Exact head `4f0dc70fcf649a7ba5800e76ad9ed82d812da067` (production `fdedf98077c86c520ac386f0736186936834a1e3` plus reports) passed local Node 22 release qualification and all CI: Node 22/24, typecheck, dependency audit, CodeQL, packed package, and scaffold. Qualified canonical artifact: `a8b3aef9a4f0f84f7344cfe5df05a3d9f1dd0ab6a2db1bbb78e5d8c9c1078be3`. [Exact CI run](https://github.com/anirudhsengar/agentify/actions/runs/33362405801).
- On that head, a Chi continuation with explicitly configured Go 1.23.12 reused the prior attested map and installed 18 specialists and 19 procedures in 99,222 ms. Both `go test ./...` and `go vet ./...` passed; all 69 flows survived materialization. Exactly one new installation-success terminal was recorded. No model audit ran, so this does not qualify a fresh held-out round or complete provider accounting.
- Chi's installed team **failed manual quality review**: its radix specialist states parameter-before-regexp priority, contrary to the source enum/traversal, and its throttle specialist mislabels a concurrency semaphore as token-bucket rate limiting and inverts exhausted-channel state. Petclinic and Chi have now both failed review; there are still zero passing repository reviews. Their generated installations were moved to recoverable external evidence folders, leaving both targets Git-clean. This evaluator cleanup is not production rollback proof.
- Earlier exact production `20b3a9eb7d72b938a4a30b9e5e873c6bbeacef46` also passed Node 22.19.0 `verify:release`: all 97 source test files, ten executable compiler/install corpus cases, scaffold, five packed-package qualifications, and dependency audit with zero vulnerabilities. Artifact SHA-256: `f877387cc9380a53b89d55c40e99a28129db4912f81568aeabd58c04c74d6358`. No earlier live results carry forward.
- The latest completed live matrix used exact `83dd8578d2e7cca297ca124c318ef5ed9a4e236d`, package hash `c6be50d345f290a1e115bbb9ed2ce0b3e4f965cbc22da064952722a477bb3252`, Node 22.19.0, and unchanged configured models/authentication. That SHA passed CI on Node 22/24, package/scaffold, audit, and CodeQL, but failed product qualification.

| Latest fresh live cases | Installed | Result |
| --- | ---: | --- |
| Commander, AQA, Cobra, Hono, Gin, Axum, Petclinic | 0/7 attempted | Failed; Click is policy-negative, approved replacement SQLAlchemy not yet run |
| Preact, PyJWT, Chi, Thiserror, JCommander, Mustache — round 1 | 0/6 | Failed |
| Held-out round 2 | Not run | No consecutive clean rounds |

- All thirteen fresh model runs preserved original application-file hashes and each had one terminal event. Four terminal events falsely reported success before finalization rolled back: Chi, Mustache, PyJWT, and Petclinic. The subsequent installer-owned terminal correction has deterministic coverage but still needs live qualification.
- Six runs hit the external 30-minute timeout; all thirteen had unanswered model requests, so reported cost and token totals are incomplete. Maps ranged up to 301,477 bytes. No complete runtime/accounting gate pass is claimed.
- Petclinic initially used the wrong installed JDK. Java 17 was already available: this was a harness error, not unavailable tooling. A same-SHA continuation using JDK 17 and its prior validated map installed seven specialists and eight procedures, with `./gradlew check` and `./gradlew test` verified. It is not a clean qualification round.
- Manual inspection **failed that installed team**. The vet specialist invents an Atom-feed contract, says caching is unused despite both repository methods having `@Cacheable("vets")`, and describes lazy loading despite `FetchType.EAGER`. It also confuses the backing Set initializer with the public sorted-list accessor. The root-landing specialist is overfragmented. Two complete profiles were reviewed; the other five were not fully reviewed. There are zero passing installed-team reviews, not three.
- Hono's draft still falsely attributes a post-build add prohibition to PreparedRegExpRouter and says SmartRouter tries every candidate despite an early successful break. These claims are recorded as failures, not corrected or accepted.
- Live tracer cancellation on 83dd stopped 11 ms after an actual provider response update and preserved a failed receipt with no repository writes. Final usage for the interrupted request was unavailable; cancellation passed its bounded probe, complete accounting did not.
- Subsequent general corrections retain dependency evidence across 512-file batches, reuse unchanged attested tracer claims, defer terminal status until installation finishes, reject portfolio-erasing model writes, and recognize dependency-free Go modules without checksums. No repository-name conditions, closure relaxation, or model/authentication changes were introduced.

## Approved evaluation scope

Click remains a policy/refusal regression and does not count toward installation success. Its command/locality reduction also remains executable read-only. The approved replacement is SQLAlchemy at `274adcbd2d3f82ea12f143256aaa7ea434f3a8ce`: a demanding Python/Cython relational toolkit covering unit-of-work ordering, pooling, and SQL compilation, selected before any installation outcome. All pinned contribution/conduct/PR policies and their linked developer policies were reviewed. AI assistance is permitted; no upstream submissions will be made. The evaluation fork is `anirudhsengar/sqlalchemy`. Live qualification is not yet run.

External immutable validation locks are approved **only in the evaluation harness**. They must stay outside targets, be content-hashed and bound to the repository SHA/toolchain, and never count as repository evidence or override readiness. Both original state and external provenance must be reported. Harness implementation is pending; the existing committed-lock readiness requirement is not silently waived. Dependency-free Go is a separate established ecosystem contract: [Go permits absent go.sum when there are no dependencies](https://go.dev/ref/mod).

The machine-readable report records `release_ready=false`, `final_candidate_sha=null`, exact per-run provenance, failed gates, and the current complete changed-file inventory.
## Known limitations

- Hono still fails convergence and has exposed false attachment, generic-portfolio, and unsupported narrative risks. Safe failure remains necessary but is not successful product qualification.
- The reduced corpus now exercises real compilation, installation, readiness canaries, and validation-failure rollback, with only GitHub operations replayed. It does not replace live generation or maintainer-quality review.
- Validation commands execute in disposable exact-HEAD checkouts with scrubbed credentials, but Agentify does not provide container or network isolation.
- Pinned Click delegates contribution rules to Pallets' external policy. The reduced refusal fixture replays captured policy text; it does not prove automatic live URL-policy resolution. No new Click writes or policy bypass have been performed.
- Live model outcomes are nondeterministic. The executable replay corpus, compiler invariants, and package qualification remain the authoritative repeatable release gates.

## Recommendation

Do not merge. Keep the existing branch and non-draft PR. One exact final SHA must install all eight non-policy historical teams and at least five of six non-policy held-outs in each of two unchanged-production rounds, pass manual team review on three materially different repositories, and pass supported-Node, package/scaffold, dependency-audit, delivery-integrity, CI, and CodeQL gates. Diagnostic-only counts as failure unless required tooling is unavailable. No merge is authorized.
