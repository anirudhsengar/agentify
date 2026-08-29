# Specialist compiler stabilization release report

Agentify is ready for the exact pull-request-head release gate. The evaluated production candidate is `b35b17e492bda6bbbd2d1cc90453da30e568b367`, built from base `f2df9eb8563bfcb26919d82c7bf28c9fb7c19e8b`. Its packed artifact is 8,052,219 bytes with SHA-256 `50bd96bd3c0762a1b60ae22fe63e521d95b46564a3943b88909179a4b95875c2`.

The implementation now treats specialist generation as a bounded, fail-closed compiler. Repository evidence and application-attested explorer receipts feed concern proposals; deterministic normalization resolves ownership; validation checks normalized closure and fixed-point idempotence; only the exact validated output can materialize; and the installation transaction rolls back every operational artifact on failure or termination. Restrictive tracked policy is evaluated before persistent mutation. Repository validation runs in disposable checkouts.

## Qualification result

- `npm run test:all` passed on the evaluated production SHA: 94 recursively discovered source test files, nine executable historical replay cases, documentation/package contracts, and focused invariants.
- All nine historical live repositories reached an allowed terminal disposition. Lobsters refused all writes because tracked policy prohibited AI-authored persistence. Commander.js, aqa-tests, Click, Cobra, Hono, Gin, Axum, and Spring Petclinic failed safely with precise unresolved obligations and only the explicitly permitted diagnostic map.
- Two consecutive held-out rounds ran without production-code changes across Vitest, ItsDangerous, Groupcache, Anyhow, JUnit4, Rack, and Emacs. Emacs refused all persistent writes in both rounds. The other six cases remained diagnostic-only; none installed a partial team or operational workflow.
- Every accepted live invocation stayed at or below 96 calls, 96 turns, two million input/cache tokens, 200,000 output tokens, USD 20, 16 explorers, and 1.8 million aggregate audit milliseconds. Every audit invocation emitted one budget event and one terminal result.
- Exact target comparisons found no application-code mutation or build/cache residue. Failed analyzable runs retained only `.agentify/runtime/audit/codebase_map.json`; restrictive-policy cases retained nothing.

The complete machine-readable evidence summary is [`2026-08-stabilization-evaluation.json`](./2026-08-stabilization-evaluation.json).

## Changed-file policy

The branch is restricted to intentional production source, prompts, documentation, deterministic fixtures, and tests. It contains no apply/export/materialization workflow, encoded payload, patch archive, generated source archive, retry workflow, one-shot qualification workflow, or staging machinery. The final changed-file list must be regenerated from the exact pull-request head before merge.

## Known limitations

- Default budgets deliberately prefer a precise no-installation result over an under-grounded team. Larger repositories may require explicitly raised bounded configuration.
- Validation commands execute in disposable exact-HEAD checkouts with scrubbed credentials, but Agentify does not provide container or network isolation.
- Live model outcomes are nondeterministic. The executable replay corpus, compiler invariants, and package qualification remain the authoritative repeatable release gates.

## Recommendation

Open a non-draft pull request and merge only if the exact PR head passes Node 22.19.0 and Node 24 tests, typecheck, package/scaffold qualification, full dependency audit, delivery-integrity inspection, and CodeQL. Do not merge on the basis of this pre-PR qualification alone.
