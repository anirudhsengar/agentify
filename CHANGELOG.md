# Changelog

All notable changes to Agentify are documented here.

## [Unreleased]

### Added

- Specialist discovery is now concern-based. The audit runs a `concern_scout`
  explorer once to propose the repository's specialties, then a
  `concern_tracer` per candidate to trace it end to end, and records the
  result as `concern_evidence`: concerns with traced flows, per-file
  touchpoint roles, invariants, pitfalls, entry questions, validation
  commands, and the rejected `not_concerns`. A concern is a body of
  knowledge, not a directory — concerns are expected to span subtrees and to
  share files. Specialists, planning consultations, specialist memory, and
  accepted-merge learning all take the concern shape, replacing the retired
  `expert_evidence` domain list; specialists derived from a pre-concern map
  are migrated with a warning. The type-contract coverage dimension now
  accepts type definitions from any language. When an audit records no
  concerns, the install warning explains how to force concern re-discovery
  instead of claiming a plain re-run re-audits.
- `agentify login` now mirrors the Pi coding agent's authentication surface
  exactly: the method selector is built from the installed Pi model registry,
  listing every subscription sign-in (Anthropic Claude Pro/Max, OpenAI ChatGPT
  Plus/Pro, GitHub Copilot, Kimi, OpenRouter, Radius, xAI) by Pi's own label
  first, then "Sign in with an API key". OAuth flows run through Pi's own
  login implementations — browser launch, device codes, and manual-code paste
  with out-of-band abort — and credentials persist to `~/.agentify/auth.json`.
  A parity test pins the static provider allowlist to the Pi registry.

### Changed

- The published npm package is now zero-dependency: every runtime library is
  bundled into `dist/` by esbuild, so `npm install --global` no longer emits
  deprecation or install-script warnings from transitive packages. All
  third-party packages moved to `devDependencies`; release verification audits
  the full dependency tree.

## [1.1.0] - 2026-08-20

### Added

- Specialist-evidence completion gate: the repository audit no longer completes
  when all ten coverage dimensions close — the session stays open (with bounded
  recovery passes and explicit tool guidance) until `expert_evidence.expert_domains`
  is explicitly recorded. An honest empty list remains valid for repositories
  with no cohesive recurring domain, but it must be a recorded decision. This
  closes the silent failure where the audit stopped at coverage closure before
  the model ever considered specialists, producing "0 specialists installed"
  with no explanation. Rerunning `agentify` against a repository whose map
  predates the gate now runs a bounded top-up audit instead of blindly
  re-attaching, and the install report prints specialist-discovery warnings
  when discovery yields an empty or reduced portfolio.
- Transport repairs for provider/model tool-call quirks observed in real
  audits: evidence sections misplaced under `meta` are hoisted to the top level
  (filling empty canonical fields instead of silently validating invisibly),
  double-wrapped `map`/`delta` payloads are unwrapped, dimension deltas batched
  as arrays are deep-merged, markdown-fenced JSON is unwrapped, over-escaped
  string-literal payloads are decoded one layer, raw control characters inside
  JSON string values are escaped, dangling commas before closing delimiters are
  removed, and rejected payloads now carry a compact shape description so the
  model (and the audit log) can see exactly what was received.
- Evidence-backed audit coverage gate: every dimension marked `covered` must
  include citations to real repository paths (`evidence: [{ path, excerpt,
  kind }]`). The installer and `write_map`/`write_map_delta` tools verify that
  positive citations point at existing files and absence citations point at
  missing paths, so the model cannot fabricate coverage by claiming nonexistent
  evidence.
- Builder prompt coverage and evidence contract with explicit guidance that a
  pre-agentic repository can honestly close `D9_process` by recording the
  absence of the agentic layer directories.
- Multi-ecosystem repository support during installation: Node.js, Python,
  Rust, Go, Java (Maven and Gradle), Ruby, and Makefile-based projects can
  now be inspected, validated, and configured without requiring `package.json`.
- A read-only planner role that refines implementation steps between two
  deterministic planning passes, decomposing ambiguous or compound acceptance
  criteria before a plan is recorded.
- The builder may inspect, edit, and self-check across a bounded turn budget
  before its terminal typed submission, instead of one single-shot whole-file
  call.
- Shell-script build-system discovery for repositories that use root-level
  scripts (`build.sh`, `compile.sh`, `test.sh`, `lint.sh`, `get.sh`, `setup.sh`,
  etc.) instead of a package manifest. Install scripts are identified but not
  run as validation; build/test/lint/typecheck scripts are discovered, screened
  for network/deployment/credential/destructive content, and recorded as
  installer-attested validation commands.
- Installer attestation of unsandboxed repository validation: running
  `agentify` records the screened command set, manifest, and lockfile hashes
  without a separate interactive approve/skip prompt. Missing required
  validation can be refined from the audited validation surface; repositories
  with no verifiable validation command at all receive an Agentify-owned
  validation smoke (`.github/agentify/validation-smoke.mjs`: tracked-JSON
  validity, JavaScript syntax, committed-secret scan) that is installed, verified, and recorded in the task policy instead of
  a hollow `git diff --check` floor.
- When a local provider API key is already resolved, the installer copies it
  to the `PI_API_KEY` GitHub Actions secret through `gh secret set` stdin.
  `AGENT_PAT` still requires interactive consent.

### Fixed

- Specialist discovery no longer lets model-reported evidence paths bypass the
  tracked-file gate: expert `entry_points`, `test_paths`, key files, key types,
  pattern references, and pitfall references are filtered to git-tracked files
  at the supporting commit, so a directory or vendored path can no longer abort
  portfolio persistence with "not a tracked regular blob".
- Discovery now reports how many recorded domain candidates were considered
  versus retained when some are filtered out, and the install report surfaces
  that warning instead of silently installing a reduced portfolio.
- The installer recognizes its own previously written
  `.github/agentify-task-policy.json` by its self-describing format marker, so
  a fail-closed placeholder left by an interrupted install no longer counts as
  a user-owned workflow conflict on rerun.
- Python build-system discovery no longer appends `.` to the mypy command when
  the project configures mypy's file scope (`[tool.mypy] files`, `mypy.ini`, or
  `setup.cfg`), which had overridden the project scope and type-checked
  intentionally untyped trees such as `tests/`.
- Align D8 security repair hints, builder prompt, and `write_map_delta` examples
  with the schema: `bash_blocked_patterns` and `damage_control_rules` are arrays
  of strings, not `{ pattern, source }` objects. D2 repair copy now uses
  `module_graph.edges` `{ from, to, kind }`.
- Audit prompt and `write_map_delta` tool now require both the dimension data
  and the matching coverage entry in every delta, and the tool result explicitly
  lists the per-dimension reason and the exact fields still needed. This fixes
  the non-deterministic 3/10 failure where the model wrote coverage annotations
  without the corresponding `skeleton`, `module_graph`, `type_contract_surface`,
  `security_surface`, etc., and then stopped because it thought the runtime had
  stripped the arrays.
- Repair provider-induced map shape errors before the schema gate, fixing
  Anthropic-compatible MiniMax-M3 output: dotted keys (`meta.lifecycle.issue_types`),
  camelCase lifecycle fields, stringified nested values, top-level `module_graph`
  orphan keys, and flattened `shared_state` arrays are now normalized so the model
  gets bounded recovery turns instead of an immediate 9/10 failure.
- D9_process closure no longer depends on a closed `issue_types` enum; the
  schema now accepts the template/issue names the model finds in the repository,
  and the repair layer infers them from D9 evidence when absent.
- Module graph edges accept repository-specific `kind` labels (e.g.
  `process_boundary`, `ant_import`) instead of a restrictive `import|state|rpc`
  enum, so real makefile/ant-driven boundaries validate cleanly.
- Keep scheduled accepted-merge reconciliation enabled while preventing its
  first run from replaying pre-install repository history or treating installed
  Agentify workflows, runtimes, policy, and memory as application changes.
- Resume a validated open knowledge-maintenance proposal before each fresh
  workflow run, so pending learning receipts remain visible, repeated runs are
  idempotent, and branch updates use the preflight-pinned force-with-lease SHA.
- Bound each automatic knowledge proposal to 64 changed paths, 512 KiB of patch
  payload, and 5,000 changed lines, and drain the recent reconciliation backlog
  in smaller reviewable batches instead of publishing a single amplified diff.
- Register the planner record type in the installed GitHub task-state store so
  planner consultation results can be persisted as typed machine records;
  previously every task failed closed at `writeRecord("planner", ...)` with
  `unsupported machine record type 'planner'`.
- Ignore .tmp-live/ local multi-ecosystem probe clones so pack:release clean-tree checks stay green.
- On Windows, execute `.bat`/`.cmd` validation wrappers (Gradle/Maven) via
  `cmd.exe /d /s /c` with repository cwd confinement so installer and
  task-lifecycle validation no longer fail with `spawnSync EINVAL`.
- Index validation reports in `docs/README.md` and the npm package `files`
  list so documentation-invariant tests and shipped artifacts stay aligned.
- Add `tests/installer/edge-case-campaign.test.ts` covering 23 synthetic
  installer/resolver edge cases (lockfile policy, unsafe scripts, manifest
  precedence, multi-ecosystem blockers).
- Raise the installer `package` validation command timeout from 15 to 90
  minutes: exact-artifact qualification packs, installs, and smoke-runs the
  real tarball repeatedly and legitimately exceeds 15 minutes on Windows
  hosts, so installation previously always failed at the `package` step.
- Raise package smoke-test spawn timeouts (defaults to 600s, slower
  installer fixture runs to 900s) so the installed-artifact suite passes on
  slow or heavily loaded Windows machines.
- The installer `validation_failed` blocker now names the failing validation
  command ids and their captured failure details instead of a bare generic
  remediation, so diagnosis no longer requires instrumenting the installer.

### Security

- Bump `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to
  `0.84.0`, clearing a moderate/high `npm audit` finding in a bundled `undici`
  and `brace-expansion`.
- Record `esbuild`, `protobufjs`, and `@google/genai` as reviewed in
  `allowScripts` so future scripted-dependency changes are flagged for review.

## [1.0.0] - 2026-08-06

### Added

- One-time installation of a persistent engineering team for existing GitHub
  repositories.
- Authorized-issue planning, isolated implementation, deterministic validation,
  role-separated automated read-only review, and draft pull-request publication.
- Evidence-backed repository specialists, durable provenance-bound memory, and
  accepted-merge knowledge maintenance.
- Exact installed-artifact qualification, reproducible npm packaging, and
  tag-only trusted publishing.

### Security

- Require explicit maintainer consent before unsandboxed repository validation
  and bind approval to the package manifest, validation commands, and lockfile.
- Remove sensitive credentials from validation processes, detect repository
  mutation, and state explicitly that OS-level sandboxing and network isolation
  are not provided.
- Keep model sessions credential-free for GitHub writes, permit exactly one
  application-source writer, and retain human merge authority.
- Pin installed workflows and repository actions to immutable commits and use
  official registry releases for production dependencies.
