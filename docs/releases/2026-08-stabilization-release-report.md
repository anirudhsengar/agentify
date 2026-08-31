# Specialist compiler stabilization release report

Not release-ready. Do not merge PR #13. The earlier release recommendation is withdrawn: bounded, atomic failure does not qualify specialist-team generation.

The approved gate separates high-quality specialist installation from operational execution readiness. A semantically complete `analysis-ready` team may count as an installation, while missing reproducible repository-owned validation keeps issue intake, publication, autonomous mutation and learning disabled. External harness locks never clear those execution blockers.

## Current development evidence — 2026-08-31 17:39 UTC

Exact `80ba6a1f91caf56ac9756e63c2f2f43a9f3f028f` passed local Node 22/24 release suites, CI, and CodeQL. Root package SHA-256: `1df4285be019e677015c93437d9646d9ee0dbe181f13edf32bb781b3f7f1f1ba`; the independently qualified Node 24 worktree artifact differs as recorded in JSON.

All four fresh runs failed to install: AQA (1,509,273 ms), Cobra (970,843 ms), Gin (1,800,300 ms; wall budget exceeded), and Axum (1,490,127 ms). Every run preserved tracked files, retained only the permitted diagnostic map, and emitted exactly one terminal result. Missing Rust tooling did not cause Axum's semantic failure and is not claimed as an exception. Unanswered calls retain explicit resource bounds; actual charges remain unknown.

Cobra's first two narrative reviews timed out. Their retained reservations blocked later requests, whose admission errors the SDK hid as incomplete reviews. AQA, Gin and Axum repeatedly exceeded the 16 KB typed-report cap during narrow repair. Ownership and failed-tracer obligations remain unresolved. These are product failures, not qualification successes.

Live cancellation returned in 5 ms. Separate first-decisive review experiments rejected a false Cobra claim in 23,296 ms and approved a controlled Petclinic body in 46,229 ms. The Cobra review's own distance explanation was incorrect: source recurrence gives 2, not its claimed 3. Findings remain proposals requiring source verification, not authoritative correction text. Neither component probe is an installed-team manual review. There are zero qualifying held-out rounds and zero passing installed-team reviews. Hono remains unqualified; `release_ready=false`, `final_candidate_sha=null`. Do not merge.

## Previous development evidence — 2026-08-31 16:40 UTC

Exact `86a547cc5e9b089e6d18b2a39083df60ecbf6dbb` passed local Node 22/24 release qualification, CI and CodeQL. Its root artifact is `3a0fb5a840d612a5499b239509962c3996826584a821731c963de6dc1d3002b1`; the Node 24 worktree artifact was independently qualified with the different hash recorded in the JSON report.

All four fresh product runs failed: Commander (1,473,561 ms), PyJWT (1,655,464 ms), Chi (1,287,642 ms), and Petclinic (1,800,463 ms, exceeding the wall budget). No teams installed. Every run preserved tracked files and emitted one terminal result. Live three-tracer cancellation returned in 49 ms with all unanswered requests reserved; their actual provider charges remain unknown.

Commander exposed stale delegation targets after verified concern grouping. Chi exhausted the separate 24-spawn cap with 81 shared calls still available. Petclinic's review also mistook compiler-added ownership prose for repository-source claims; independent false behavioral claims remain. These failures have reduced deterministic regressions before general corrections. None establishes installation success. Zero installed teams pass manual review, zero held-out rounds qualify, and Hono narrative correctness remains unqualified. `release_ready=false`; `final_candidate_sha=null`.

## Previous development evidence — 2026-08-31 15:41 UTC

Exact `f7edfe635f7fc254545e75937f467eb24e20b159` passed both local Node release suites, CI and CodeQL. The separately qualified root package hash is `ec8140df0e6f1d87a98dd84e5163b646ee99aa2d27ea9e68ee9946c7ca89c7fd`. Its four fresh product runs all failed: Hono (1,488,430 ms), Commander (1,700,709 ms), Mustache (1,450,919 ms), and SQLAlchemy (1,214,141 ms) were diagnostic-only. Every run preserved original tracked files and emitted one terminal result; unanswered model calls retained explicit resource reservations. Provider charges for unanswered calls remain unknown. These safe failures earn no installation credit.

Commander exposed a false secret-path match on an ordinary test filename. Complete review evidence also exceeded the 256 KiB source cap in captured Commander and Hono portfolios. Separate deterministic regressions precede corrections; neither correction establishes live semantic closure. Remaining narrative errors, uncovered behavior, failed tracers and bounded-review failures still prevent qualification. There are zero passing installed-team manual reviews and zero qualifying unchanged-code rounds.

Live component review reached the previously oversized Hono body on `1f6bde8` in 14,143 ms (one call, 95,810 input / 643 output tokens, USD 0.0199336 reported). Commander review on `5cc2a9f` read the previously blocked/oversized evidence in 24,854 ms (one call, 99,343 input / 1,226 output tokens, USD 0.0213398 reported). Both correctly returned concrete source-backed contradictions; neither qualifies a team. A subsequent Commander claim-repair probe exposed a separate receipt-identity mismatch after normalization grouped already-traced bodies. Its deterministic regression preserves the original observations and rejects evidence supplied only by failed tracers. Full normalized review remains mandatory.

## Previous development evidence — 2026-08-31 14:53 UTC

Exact `18693b08d3b680eec8bc9d5cc49ba9dbb4063751` passed both local Node 22.19/24.19 release suites, all CI and CodeQL. Both locally qualified packages have SHA-256 `d4d1ba8fa8c1e504e9d066662eebb90c16888738de98c9d2554ba00145542ae6`. Live three-tracer cancellation returned in 15 ms with all unanswered calls fully reserved; a separate admission/retry probe completed 13 calls with fully reported usage. These are component proofs, not installation success.

Four subsequent completed product runs also failed: Hono and Chi on `9c5bcd0` took 936,171 and 1,088,213 ms; Mustache on the same SHA took 1,728,411 ms; SQLAlchemy on `6439d0f` took 1,353,730 ms. Each installed no team, preserved tracked files, and emitted exactly one error terminal. Full metrics and external evidence paths are in the machine-readable report.

The admission fix prevents a temporarily refused concurrent request from poisoning the budget after sibling responses release capacity. Mustache additionally exposed full-body retracing for single narrative findings, leaving unrelated false claims and exhausting repair capacity. The new claim-only correction has executable regression and counterexample coverage: only a typed, exact-body/current-HEAD rejected pitfall or invariant can change; all other claims, paths, flows and ownership remain untouched. Full normalized review is still mandatory. Its exact-commit release and live gates are pending; earlier checks do not carry forward.

There remain zero qualifying held-out rounds and zero passing installed-team manual reviews. Hono narrative correctness remains unqualified. `release_ready=false`; `final_candidate_sha=null`.

## Prior development evidence — 2026-08-31 13:55 UTC

There are still zero qualifying held-out rounds and zero passing installed-team manual reviews. The latest four completed fresh runs all failed product qualification, with unchanged tracked files and one error terminal each:

| Repository | Exact production SHA | Elapsed | Result |
| --- | --- | ---: | --- |
| PyJWT | `190b21485dc4cac16581019f7004981eee3dd530` | 1,443,563 ms | Unresolved cryptographic/security traces; no team |
| Chi | `190b21485dc4cac16581019f7004981eee3dd530` | 1,800,233 ms | Wall budget exceeded during ownership repair; no team |
| Hono | `29b22e50cae6dba7ecb54e7a78bfb20d16ab56ec` | 1,177,346 ms | Explorer output reservation exhausted; no team |
| SQLAlchemy | `29b22e50cae6dba7ecb54e7a78bfb20d16ab56ec` | 461,592 ms | Explorer output reservation exhausted; no team |

Exact `190b214` passed local release qualification and all Node 22/24 CI, CodeQL, package, scaffold and audit gates. Its canonical artifact hash is `1d5b76917aeb8d2aa9530bbfbc4b09cef3289d4ceaaae0ffbdeb08d717b17386`. These checks do not carry forward to changed production. Exact `6439d0f03e35d29c1f4faab41dc31818f064d030` subsequently completed local qualification of 99 source test files, 12 corpus cases, five packed qualifications, scaffold and zero-vulnerability audit; artifact `93726bff0ee4765000782b7e3349fd66bc99656fac044b0dc0526e403ccdebe3`. Its fresh SQLAlchemy development run is in progress, not passed.

General corrections now cap every supported explorer response, allow three independent readers within aggregate reservations, and permit compact ownership-only proposals without retranscribing unchanged bodies. Ownership proposals preserve all claims/flows, require current-HEAD attestation and independent adjacent implementation, invalidate normalized review, and do not close unrelated gaps. Map deltas also reject forged application-owned receipts, reviews and budget checkpoints. The ownership change has focused regression/corpus proof; its exact-commit full release gate is pending.

Live cancellation on `190b214` settled in 8 ms; a three-tracer probe on `61d98d62d08e88800b61933f0cf27de87175f0ea` settled in 6 ms. All admitted unanswered calls retained conservative model-bound reservations; none were unreserved. Actual interrupted provider usage/charges remain unknown, not zero. These component proofs do not qualify a final candidate or an installation. Hono's installed narrative-quality gate remains unresolved.

## Earlier development evidence

Exact production `812eff8e327c39f1000cc9bcc004e87a58bf4d69` passed the full local Node 22 release suite: 98 source test files, 12 executable corpus cases, five packed qualifications, scaffold and zero-vulnerability audit. Canonical package SHA-256: `d2c0f9f54a73c1cf416e14071a6f05d6ead1de6dcb27da4eec4b036fae38ba8f`. All Node 22/24 CI, CodeQL, package and scaffold checks also passed. Fresh Hono and PyJWT nevertheless failed installation in 820,583 ms and 691,204 ms respectively, before narrative review: their reported output plus retained unanswered-request bounds and the next uncappable 128,000-token request exceeded the 200,000-token total. Each rolled back with unchanged tracked files and one error terminal. No success credit.

The admission failure now has a deterministic replay. The aggregate output default is explicitly 400,000 tokens, including reservations; a configured 200,000 ceiling still refuses the same request. No unanswered reservation is dropped, and call, time, cost and specialist-quality limits are unchanged. This budget correction still needs exact-head and fresh live qualification. Chi's additional run is invalid: the harness exited unexpectedly, so its verified task-owned child was stopped and its audit preserved. Missing stdout/stderr are disclosed, not fabricated.

Normalized specialist bodies now receive a bounded, source-backed narrative review inside the repair loop. Current-HEAD/body-digest attestation is independently required at finalization. Live component probes on `56daf7f` rejected the known Hono router-reuse and PyJWT coercion contradictions; a manually corrected external PyJWT body passed in 67.274 seconds. These are component checks, not generated installations or manual-quality passes. The original bad installed team was not edited. Hono narrative correctness and installation convergence remain unqualified.

Live tracer cancellation on exact `812eff8` returned in 22 ms without target changes. Its unanswered provider call retained explicit input/output/cost upper bounds; the exact provider charge remains unknown. Full-run accounting, three passing installed-team reviews, and two unchanged-production held-out rounds still require evidence. `release_ready=false`; `final_candidate_sha=null`.

## Earlier development evidence

Exact `3e12ac294e7edf3269dd2b400270f78bd87284b8` passed the local Node 22 release suite and all Node 22/24 CI, package/scaffold, audit and CodeQL checks. Package: `fbc24fddf030e67f13a350a7c01dc3014d976462168f330f42c9f21a449fef8e`. The first Node 22 CI job failed during temporary Git-directory cleanup; ten focused repetitions and the unchanged-SHA failed-job rerun passed. No code or test was changed to hide that failure.

PyJWT installed five analysis-ready specialists on that SHA in 936,192 ms, preserving tracked files, with one terminal result and no Agentify execution workflows. **Manual quality failed**: the installed claims specialist falsely rejects numeric-string time claims despite `int()` coercion and incorrectly generalizes issuer short-circuit behavior to subject/JTI validation. It does not count toward the held-out quota. Hono hit the 30-minute wall limit (1,800,163 ms including exit capture), retained only its permitted diagnostic map, and emitted one aborted terminal. Tracked files were unchanged. Its draft contains unsupported concurrency, registration-cost and router-reuse claims. Neither is a passing quality qualification.

Exact resource-accounting commit `6733b1a6618047be305d04eed66a9fd25a72a178` passed all 97 source test files, 12 corpus cases, five packed qualification programs, scaffold and zero-vulnerability audit locally on Node 22. Package: `7ea2deaa172acfa6cecb512f1c223f8435a8b5a22c463fc765b69a99b1d8f49d`. Live tracer cancellation stopped in 44 ms without target writes; the unanswered call retained bounds of 1,000,000 input tokens, 12,000 output tokens and USD 0.3144. These are model-metadata upper bounds, **not measured charges or a provider invoice**. CI on this newer SHA is not yet run. A small primary-model narrative-review experiment caught the false claims and preserved a valid counterexample, but whole-record reviews timed out at 90 seconds; no unproven review gate was added to production.

There are still zero passed installed-team manual reviews and zero new qualifying held-out rounds. `release_ready=false`; `final_candidate_sha=null`. Do not merge.

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

The archived inventory is retained separately. The current machine-readable inventory enumerates all 118 changed branch paths through `b6644cd`; this milestone changes only already-listed paths. No temporary workflow, payload, archive or staging machinery is present. Delivery-integrity inspection must pass again on the exact final candidate.

## Current development evidence

- After the approved scope change, exact `a2a25ab6e1e6483ffcb36370041a5e4205d5862e` passed the full local Node 22 release suite and all CI/CodeQL, including 12 corpus checks and five packed qualifications. Canonical package hash: `531e80da555296ac4bc654d13f9c5d641be36a9c4a04a0325eaf681ce9d78313`. This proves tooling, not the product gate.
- Its configured high-thinking Hono tracer probe completed in 84,512 ms, four calls/four turns, 24,552 input and 4,963 output tokens, with $0.01114008 reported usage and a clean target. It corrected the earlier SmartRouter selection claim but still invented `match.slice(1)` instead of the actual full match array. Manual quality remains failed. Two bounded independent source-review experiments timed out; neither is counted as a working quality gate. These probes are not installations.
- Exact head `4f0dc70fcf649a7ba5800e76ad9ed82d812da067` (production `fdedf98077c86c520ac386f0736186936834a1e3` plus reports) passed local Node 22 release qualification and all CI: Node 22/24, typecheck, dependency audit, CodeQL, packed package, and scaffold. Qualified canonical artifact: `a8b3aef9a4f0f84f7344cfe5df05a3d9f1dd0ab6a2db1bbb78e5d8c9c1078be3`. [Exact CI run](https://github.com/anirudhsengar/agentify/actions/runs/33362405801).
- On that head, a Chi continuation with explicitly configured Go 1.23.12 reused the prior attested map and installed 18 specialists and 19 procedures in 99,222 ms. Both `go test ./...` and `go vet ./...` passed; all 69 flows survived materialization. Exactly one new installation-success terminal was recorded. No model audit ran, so this does not qualify a fresh held-out round or complete provider accounting.
- Chi's installed team **failed manual quality review**: its radix specialist states parameter-before-regexp priority, contrary to the source enum/traversal, and its throttle specialist mislabels a concurrency semaphore as token-bucket rate limiting and inverts exhausted-channel state. Petclinic and Chi have now both failed review; there are still zero passing repository reviews. Their generated installations were moved to recoverable external evidence folders, leaving both targets Git-clean. This evaluator cleanup is not production rollback proof.
- Earlier exact production `20b3a9eb7d72b938a4a30b9e5e873c6bbeacef46` also passed Node 22.19.0 `verify:release`: all 97 source test files, ten executable compiler/install corpus cases, scaffold, five packed-package qualifications, and dependency audit with zero vulnerabilities. Artifact SHA-256: `f877387cc9380a53b89d55c40e99a28129db4912f81568aeabd58c04c74d6358`. No earlier live results carry forward.
- The latest completed live matrix used exact `83dd8578d2e7cca297ca124c318ef5ed9a4e236d`, package hash `c6be50d345f290a1e115bbb9ed2ce0b3e4f965cbc22da064952722a477bb3252`, Node 22.19.0, and unchanged configured models/authentication. That SHA passed CI on Node 22/24, package/scaffold, audit, and CodeQL, but failed product qualification.

| Earlier `83dd8578` fresh live matrix | Installed | Result |
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

Click remains a policy/refusal regression and does not count toward installation success. Its command/locality reduction also remains executable read-only. The approved replacement is SQLAlchemy at `274adcbd2d3f82ea12f143256aaa7ea434f3a8ce`: a demanding Python/Cython relational toolkit covering unit-of-work ordering, pooling, and SQL compilation, selected before any installation outcome. All pinned contribution/conduct/PR policies and their linked developer policies were reviewed. AI assistance is permitted; no upstream submissions will be made. The evaluation fork is `anirudhsengar/sqlalchemy`. Its first fresh live run failed as recorded above; no success credit is claimed.

External immutable validation locks are approved **only in the evaluation harness**. They must stay outside targets, be content-hashed and bound to the repository SHA/toolchain, and never count as repository evidence or override readiness. Both original state and external provenance must be reported. The Python harness experiment below is implemented; other ecosystem captures remain pending. The existing committed-lock readiness requirement is not silently waived. Dependency-free Go is a separate established ecosystem contract: [Go permits absent go.sum when there are no dependencies](https://go.dev/ref/mod).

The first external-lock experiment is complete: PyJWT at `7144e4534c34810f4525dc4578a32addd8212cff`, Python 3.14.7 and uv 0.12.5, passed 365 tests in each of two fresh environments installed from the same SHA-256-locked wheel set. Four no-cryptography tests were skipped because cryptography was installed. Lock hash: `33d7b473621ee45da9d284ef5c1415468859ab3b2c42d2e68607ad927ae15ccf`. Original tracked hashes and Git status were unchanged. This is external dependency-validation proof only; it does not waive Agentify's committed-lock readiness blocker or count as an installation.

The machine-readable report records `release_ready=false`, `final_candidate_sha=null`, exact per-run provenance, failed gates, and the current complete changed-file inventory.
## Known limitations

- Hono still fails convergence and has exposed false attachment, generic-portfolio, and unsupported narrative risks. Safe failure remains necessary but is not successful product qualification.
- The reduced corpus exercises real compilation, installation, readiness canaries, analysis/operational transitions, and semantic-failure rollback, with only GitHub operations replayed. It does not replace live generation or maintainer-quality review.
- Validation commands execute in disposable exact-HEAD checkouts with scrubbed credentials, but Agentify does not provide container or network isolation.
- Pinned Click delegates contribution rules to Pallets' external policy. The reduced refusal fixture replays captured policy text; it does not prove automatic live URL-policy resolution. No new Click writes or policy bypass have been performed.
- Live model outcomes are nondeterministic. The executable replay corpus, compiler invariants, and package qualification remain the authoritative repeatable release gates.

## Recommendation

Do not merge. Keep the existing branch and non-draft PR. One exact final SHA must install all eight non-policy historical teams and at least five of six non-policy held-outs in each of two unchanged-production rounds, pass manual team review on three materially different repositories, and pass supported-Node, package/scaffold, dependency-audit, delivery-integrity, CI, and CodeQL gates. Diagnostic-only counts as failure unless required tooling is unavailable. No merge is authorized.
