# Changelog

All notable changes to Agentify are documented here.

## [Unreleased]

### Added

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
  for network/deployment/credential/destructive content, and proposed as
  maintainer-approved validation commands.

### Fixed

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
