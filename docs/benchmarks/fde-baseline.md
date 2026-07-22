# FDE Milestone 0 baseline

This document records the verified repository baseline before FDE
operating-system development. It is an observation of the repository on the
stated commit and environment, not evidence that an FDE engagement lifecycle
has been implemented.

## Baseline identity

| Field | Value |
| --- | --- |
| Date | 2026-07-22 |
| Starting commit before repair | `062cdfb727c176f6788510515cf2639e6d80b5e8` |
| Repair commit | `0c1b3e5de2a4eaca7bc75394f5f7ad7d5e891664` |
| Final baseline commit | `0c1b3e5de2a4eaca7bc75394f5f7ad7d5e891664` |
| Node | `v26.2.0` (satisfies package requirement `>=22.19.0`) |
| npm | `11.17.0` |
| Operating system | Arch Linux rolling, Linux `7.1.4-arch1-1`, x86_64 |

Dependencies were already installed and `npm ls --depth=0` reported the
declared production and development dependency set without errors.

## Validation results

Durations are Bash wall-clock measurements from a clean working tree at the
final baseline commit. Commands overlap by design: parity includes a package
test, and release validation repeats type checking, the full suite, and the
package test.

| Command | Result | Duration |
| --- | --- | ---: |
| `npm run typecheck` | Passed | 4.277 s |
| `npm run test:all` | Passed; build, generation pipeline, 109 discovered TypeScript test files, and repository contract tests | 73.215 s |
| `npm run test:package` | Passed; packed and installed compiled CLI smoke test | 9.872 s |
| `npm run test:parity` | Passed; CLI, generated bundle, state-directory matrix, and installed package | 19.595 s |
| `npm run test:maintenance` | Passed; documentation, schema, reachability, module, legacy-state, and release-safety invariants | 0.896 s |
| `npm run test:security-redteam` | Passed; audit defense hardening and scaffold workflow simulation | 0.248 s |
| `npm run test:scaffold-e2e` | Passed; complete scaffold shell suite | 4.596 s |
| `npm run release:check` | Passed; typecheck, full tests, and package smoke test | 92.222 s |

Before the repair, `npm run test:scaffold-e2e` failed in
`scaffold/tests/test-stale-experts.sh`. The detector correctly invoked
`resolve-state-dir.sh`, which rejected the temporary repository with:

```text
agentify: no Agentify manifest found; run agentify before invoking scaffold state tooling
```

The fixture predated manifest-authoritative state resolution: it created no
manifest and wrote experts under `.pi/prompts/experts/`, while the detector
first resolves authoritative state and then reads
`<state_dir>/prompts/experts/`. The correction was test-only: define
`state_dir=.pi/agentify`, create a matching v2 manifest inside the temporary
repository, and create the expert fixtures beneath
`.pi/agentify/prompts/experts/`. Missing-, multiple-, and mismatched-manifest
production failures remain unchanged.

## Supported product inventory

The installed `agentify` executable is the only supported public runtime
surface. At this baseline it includes:

- documented CLI options plus `login`, `logout`, `models`, and `revert`
  utilities;
- brownfield repository audit and comprehension through read-only evidence
  collection, structured maps, coverage gates, and deterministic artifacts;
- greenfield formation with typed checkpoints and deterministic project
  artifacts;
- provider-scoped state, attach and recovery behavior, explicit migration, and
  crash-recoverable state transactions;
- managed-file markers, manifests, conflict preflight, staged apply, rollback,
  and selected-harness exports;
- optional GitHub runtime scaffolding for issue, comment, review, and draft-PR
  workflows; and
- a compiled ESM npm artifact exposing only the `agentify` executable and
  `package.json` export.

## Experimental-system inventory

The following are repository-internal and explicitly unsupported as public
runtime surfaces:

- AIW under `src/core/aiw/`;
- orchestrator runtime and owned communications transport under
  `src/core/orchestrator/`;
- webhook server and worker under `src/core/webhook/`; and
- Agent Expert runtime and related outcome/qualification modules.

The neutral workflow-spec contract and declarative workflow assets used by
supported deterministic rendering do not graduate the orchestrator runtime.
Test coverage of an experimental system likewise does not make it supported.

## Existing test surfaces

- Strict TypeScript checking and compiled ESM builds.
- Recursive unit, characterization, generation-pipeline, state transaction,
  migration, audit, greenfield, webhook, AIW, orchestrator, and security tests.
- Golden schema, validation-error, renderer, and generated-output contracts.
- CLI, generated-bundle, and provider-state parity matrices.
- Documentation, schema ownership, reachability, module-boundary,
  legacy-state-consumer, and release-safety maintenance checks.
- Scaffold end-to-end shell tests, workflow simulations, routing evidence,
  handoff, refresh, stale-expert, and smoke scenarios.
- Real npm pack, contents inspection, installation, and executable smoke tests.
- Tag-only, verified-artifact release checks.

## Architectural strengths

- Probabilistic repository understanding is separated from deterministic
  validation, rendering, ownership, and apply logic.
- Brownfield model sessions have read-only built-ins and explicit execution
  policies; structured tools own authoritative writes.
- State-directory authority is manifest-based and provider-scoped, with
  ambiguity and mismatches failing closed.
- State replacement and repository artifact application are staged,
  journaled, rollback-capable, and crash-recoverable.
- Managed markers and manifests protect user-owned files and make ownership
  verifiable.
- Machine-enforced module and package boundaries keep experimental runtimes out
  of the supported CLI graph and published API.
- Installed-artifact, parity, security, scaffold, and release checks exercise
  the behavior users receive rather than source alone.

## Current FDE gaps and known risks

- No end-to-end FDE engagement model currently joins qualification, audit,
  prioritization, decision, delivery, evaluation, pilot, measurement, and
  productization.
- Approved-issue provenance, explicit decision records, engagement-level
  evidence, success metrics, and pilot governance are not yet one supported
  typed lifecycle.
- The optional GitHub scaffold provides useful mechanics, but is not by itself
  a qualified issue-to-draft-PR FDE product contract.
- Experimental AIW, orchestrator, webhook, and Agent Expert implementations
  may suggest future capabilities, but lack the graduation commitments required
  for supported operation.
- The baseline is one local Arch Linux/Node 26 observation. CI covers declared
  engines and release concerns, but environment, provider, GitHub permission,
  and unfamiliar-repository variance remain practical risks.
- Repeated broad suites are strong regression evidence but do not substitute
  for outcome measurements from real, human-governed FDE pilots.
- The repaired regression demonstrates that scaffold fixtures can drift when
  state authority changes; resolver and end-to-end coverage must stay aligned.

**No FDE engagement implementation exists yet.** Milestone 0 establishes the
green, documented starting point from which that work may begin.
