# Changelog

All notable changes to Agentify are documented here.

## [Unreleased]

### Fixed

- Semantic repair now orders uncovered JavaScript and TypeScript clusters by
  direct dependency centrality before deterministic name ties, so missing core
  behavior is investigated before disconnected leaf utilities.
- Mirrored JavaScript and TypeScript clusters now attach deterministically when
  a current-HEAD relative import, export, or require edge links them to exactly
  one accepted concern. Multiple owners and explicit exclusions remain
  unresolved instead of falling through to weaker filename inference.
- Deterministic implementation/test attachment now strips locality suffixes
  from behavioral labels, requires independent semantic and behavioral-path
  signals, and leaves shallow generic matches unresolved. Exact implementation
  evidence still carries its mirrored test unless the exclusion names that
  path, preventing unrelated utilities and same-name subtrees from being
  assigned to the wrong specialist.
- Concern discovery now rejects generic catalogs and framework layers that
  merge unrelated failure domains through a shared API or subtree, and forbids
  shared integration files from substituting for behavior-specific core owners.
- Structured `grouped_into` rejection ownership now takes precedence over
  ambiguous prose aliases while still rejecting nonexistent concern identities.
- Initial concern scouting now refuses parent-authored focus and numeric
  portfolio caps, so portfolio size always follows repository evidence while
  focused supplemental scouts remain limited to exact compiler obligations.
- Shared-core normalization now requires each displaced concern to retain a
  uniquely owned implementation path, preventing mutually dependent ownership
  resolutions from erasing an accepted behavior while preserving resolution
  when a genuinely independent core path exists.
- Concern-evidence deltas now reject changed bodies for an existing semantic
  identity. Existing concerns must be replaced through the application-bound
  tracer checkpoint, preventing repair from appending duplicate specialists or
  bypassing scope and monotonicity checks.
- Audit session deadlines now reserve one second for checkpointing, rollback,
  and terminal accounting, preventing timeout cleanup from reporting aggregate
  elapsed usage just beyond the configured total wall-time limit.
- Semantic repair can now group inseparable accepted concerns without weakening
  closure. A structured `grouped_into` decision names one existing broader
  owner; trusted normalization unions the already-attested flows, touchpoints,
  invariants, risks, questions, and validation only when the bodies share a
  core implementation file. Unrelated grouping remains unresolved.
- Existing-concern tracer replacements now preserve every verified flow name
  and ordered step-path sequence, preventing a later retrace from collapsing
  established behavior while global file coverage happens to remain unchanged.
- Rejection validation now treats only explicit transfer language such as
  `subsumed by` as delegation, so negative hypotheticals about attaching
  governance files to an accepted concern remain independent rejections.
- Failed tracer receipts now retain their application-bound concern identity,
  so a later successful exact-identity retrace clears that failure without
  treating unrelated or still-unretraced timeouts as resolved.
- Explorer receipts now canonicalize domain-locked absolute targets to safe
  repository-relative paths, keeping trusted checkpoints schema-valid and free
  of checkout-specific host paths.

### Added

- An executable nine-repository stabilization corpus now compiles eight
  repository-specific evidence portfolios through fixed-point normalization
  and materializes their exact specialists, while the restrictive-policy case
  proves pre-mutation refusal. It asserts names, exclusions, core symbols and
  roles, flows, invariants, entry questions, rejected candidates, ownership,
  readiness, disposition, runtime, and output size. The
  accompanying machine-readable evaluation and release reports record pinned
  live targets, resource usage, terminal dispositions, and two unchanged-code
  held-out qualification rounds.

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
- GitHub Actions carry-over for OAuth subscription credentials: the installer
  offers (with explicit consent) to upload the stored credential set as the
  `PI_AUTH_JSON` Actions secret; the issue workflow materializes it once per
  run into a `0600` file read only by the trusted runtime, and writes rotated
  OAuth refresh tokens back to the secret at exit through `AGENT_PAT`
  (best-effort). `PI_API_KEY` remains supported for environment-only API-key
  setups. `AGENT_PAT` now also needs Secrets read/write for the write-back.

### Changed

- Existing-concern retraces now compare the candidate portfolio with the exact
  current map before typed checkpointing. A submission that reopens any tracked
  path already covered or substantively exempted is rejected with the regressed
  paths, so repair cannot trade one unresolved obligation for another while
  retaining a stable concern name.
- Path-backed rejected candidates that claim behavior is subsumed elsewhere
  now exempt tracked obligations only when their named
  disposition semantically binds to a real accepted concern. Independent
  substantive rejections remain valid; delegation to a nonexistent specialist
  fails closure with the exact candidate and claimed owner.
- Fixed-point specialist normalization now removes stale append-only
  `not_concerns` entries that explicitly retain an accepted concern, recognizes
  exact tracked paths embedded in descriptive rejection labels, and resolves a
  shared core file only when one claimant cites a strict superset of every
  competing concrete symbol set. Unrelated rejections and ambiguous symbol
  claims remain unresolved.
- Existing current-HEAD maps with recorded concern evidence now enter
  deterministic compilation before provider probing or budgeted audit repair,
  so a normalizable map is not mislabeled as legacy evidence or blocked by an
  already exhausted model budget.
- Validation discovery now prefers a tracked nested project with a required
  behavioral test when the root exposes only build or syntax checks. The scan
  is Git-bound and capped at 64 manifest directories four levels deep; root
  ecosystem precedence wins ties. Hash-pinned pip requirements are recognized
  as a lock. Python test trees without pytest use stdlib unittest discovery
  unless a tracked local import graph reaches a network client; then only a
  tracked offline module is eligible, and only when the README documents the
  individual-unittest command form.

- The bounded default audit envelope now permits 240 model calls/turns, eight million input/cache tokens, and 24 explorer spawns so a complete evidence-backed portfolio and final obligation-focused repair can fit while duration, output, cost, convergence, and artifact caps remain enforced.

- Concern tracers now submit their body through an application-owned typed tool
  that Agentify schema-validates and checkpoints directly before receipt
  attestation. Evidence freshness is bound
  to the exact HEAD commit timestamp, eliminating parent-model retranscription
  and wall-clock churn from specialist fixed-point compilation. Tracers use a
  six-read/eight-call envelope so a multi-concern portfolio fits the aggregate
  audit budget; subtree reach is derived deterministically from tracked
  touchpoints. A 12,000-token response ceiling leaves room for model reasoning,
  while the existing 16 KB report gate remains authoritative.

- Semantic repair can request one focused supplemental concern scout when its
  focus names an exact compiler-uncovered implementation/test cluster omitted by
  the original scout. Broad, unrelated, and repeated same-HEAD scouts remain
  blocked, so repair can add missing real behavior without reopening discovery.

- New audits begin with an immutable exact-HEAD evidence map derived from the
  already-verified installer preflight. Repository identity, languages and
  formats, tracked topography, verified behavioral validation, build metadata,
  and README metrics are recorded deterministically before model exploration;
  same-HEAD continuation maps now receive missing immutable defaults without
  discarding accumulated semantic evidence or spending another model call;
  semantic contracts, conventions, pitfalls, operations, security, and process
  remain gaps until separately proven. Internal tracked README symlinks resolve
  through Git objects, while dirty working-tree bytes and stale preflight SHAs
  cannot influence the map.

- The published npm package is now zero-dependency: every runtime library is
  bundled into `dist/` by esbuild, so `npm install --global` no longer emits
  deprecation or install-script warnings from transitive packages. All
  third-party packages moved to `devDependencies`; release verification audits
  the full dependency tree.

### Fixed

- Existing-concern tracer repairs now preserve application-bound behavioral
  scope as well as the exact concern name. A typed replacement body that drops
  every prior core path is rejected and must be proposed as a new concern.

- Inferred implementation/test attachments now treat explicit concern
  exclusions as authoritative negative evidence. An incidental positive mention
  can no longer absorb a separately excluded sibling behavior; direct tracked
  evidence remains eligible and ambiguous clusters stay unresolved.

- Specialist compilation now restores uniquely matched scout identities and
  recomputes application-inferred touchpoints from explicit evidence. Stale
  inferred implementation/test ownership can no longer survive later compiler
  passes, while ambiguous identities and explicit separation exclusions remain
  unresolved instead of being guessed.

- Coverage citations in Git repositories are now resolved against regular
  tracked files at exact HEAD instead of mutable working-tree existence.
  Agentify-generated paths cannot establish repository coverage, and untracked
  dirty files cannot invalidate an exact-HEAD absence citation.

- Locked dependency provisioning now runs before repository validation in the
  same disposable exact-HEAD checkout and repeats before post-install checks.
  Node installs disable lifecycle scripts, provisioning failure prevents test
  execution, and no dependency or validation residue reaches the target.
  Validation also scrubs inherited color-control variables instead of injecting
  `NO_COLOR`, preventing host presentation settings from changing repository
  behavior and creating false test failures.

- Bounded tracked-policy and diagnostic-map reads now open without following
  the final symlink, verify and read through one descriptor, and enforce the
  byte cap while reading. Installation rollback therefore cannot retain bytes
  from a path substituted between a metadata check and use. Installer child
  invocation also no longer accepts environment-selected executable paths;
  Windows wrappers resolve only through application-selected runtimes.

- Installer readiness commands no longer execute in the installation target.
  Preflight validation runs in a disposable checkout of the exact committed
  HEAD, and post-install validation overlays only Agentify-managed output into
  a fresh disposable checkout. Generated virtual environments, language-tool
  caches, build output, and validator crashes therefore cannot contaminate a
  successful or failed installation target; checkout setup and cleanup failures
  remain fail-closed diagnostics. Network and OS isolation remain unavailable
  and explicitly attested.

- Restrictive-policy matching now requires lexical AI/LLM subject boundaries.
  Ordinary contribution prose such as “do not follow the Code of Conduct in
  good faith” no longer treats the `ai` inside `faith` as an AI ban, while
  explicit AI-, LLM-, coding-agent-, and generative-AI prohibitions still stop
  before mutation.

- Specialist/procedure synchronization now refuses canonical evidence that is
  incomplete or not already at the compiler's idempotent fixed point, before
  changing persistent memory. Installation transaction capture also begins
  before recognized runtime repair or any normalized-map write, so repair,
  compiler, output-cap, materialization, and canary failures restore the same
  pre-installation state. Every tracked
  file must have exactly one accepted core owner; adjacent specialists may keep
  it only as supporting context until ownership is resolved. A concern cannot
  assign only tests as core while citing tracked implementation behavior as
  supporting; repositories whose executable product is test-only remain valid.
  An auxiliary-only example or fixture concern is deterministically recorded
  as a path-backed rejection when its repository-specific semantic evidence
  overlaps a concern with independent implementation ownership; distinct
  example products remain eligible.
  When exactly one concern depends on a shared implementation file for its only
  core path, deterministic normalization retains that concern as owner and
  downgrades adjacent mentions to supporting; genuinely ambiguous ownership
  still fails closed. Mirrored implementation/test clusters are promoted to
  core only for a unique concern that explicitly cites every tracked cluster
  path; partial consumers remain supporting and tied complete claims remain
  unresolved.

- Compiled finalization now commits repository-side installation state only for
  a fully ready report. Failed required validation and every other non-ready
  disposition preserve their actionable blockers but roll back identities,
  policies, workflows, instructions, and empty managed parent directories;
  pre-existing installations are restored exactly and fresh runs retain only
  permitted diagnostic evidence.

- Repository audit now enforces one configurable aggregate resource budget
  across coverage, recovery, semantic repair, and explorer sub-sessions. Finite
  defaults bound elapsed time, calls, turns, tokens, provider-reported cost,
  explorer dispatches, and scout/tracer duration; repeated canonical
  unresolved-obligation fingerprints stop no-progress repair. Application map
  writes also reject output above the one-megabyte cap before filesystem
  mutation. Tool-use continuations reserve one just-observed input context
  before another request, and terminal turn metrics count provider responses
  rather than user or tool-result transport messages. Same-HEAD diagnostic
  continuations now retain an application-authored cumulative usage checkpoint,
  so restarting the CLI cannot reset elapsed-time, call, turn, token, cost, or
  explorer-spawn limits. Every new parent and explorer session now requires its
  selected model's full context window to fit the remaining input reserve, and
  later requests are rejected before dispatch when their serialized-payload
  upper bound cannot fit, preventing a continuation from overshooting the hard
  token cap before provider usage is reported.

- Semantic repair now acts on the compiler's named unresolved obligations with
  only bounded explorer dispatch and concern-delta tools. Repository reads stay
  inside explorers instead of consuming parent calls by rereading the broad map.

- Concern tracers now receive an application-bound exact concern identity, and
  typed submissions that rename it are rejected before checkpointing. This
  prevents aliases from satisfying the wrong scout proposal or becoming duplicate
  specialists during repair.

- Concern discovery now groups candidates that share the same sole tracked
  implementation file and have no independent implementation owner. Ordinary
  shared supporting touchpoints remain valid overlap, while tracers prefer a
  concern-specific implementation core over shared orchestration.

- Deterministic normalization now promotes one uniquely cited tracked
  implementation path when a concern would otherwise have test-only core
  ownership; ambiguous or multiply cited candidates still fail closed.

- Shared orchestration ownership now moves to one sole dependent supporting
  claimant when every existing core owner retains an independent implementation
  core. Examples, fixtures, tests, and tied claimants cannot prove this rule.

- Exclusion-aware attachment now distinguishes a substantive behavioral match
  from one generic token already present in the concern's positive evidence,
  preventing unrelated mirrored clusters from being vetoed by broad wording.

- Public declaration surfaces now inherit one core specialist owner from an
  observed type trace only when the named type path and every traced runtime
  owner are unambiguous; competing owners remain unresolved.

- Explorer sessions now run serially with hard mode-specific repository-read
  and provider-call limits. Aggregate exhaustion reports the exact unresolved
  semantic obligations and fingerprint; complete reports at the limit survive.
  Model arguments cannot raise trusted mode defaults, usage is charged live per
  response, and oversized reports fail rather than becoming truncated receipts.

- Scout proposals are now application-attested semantic obligations until
  traced or substantively rejected. Explorer receipts and completed concerns
  checkpoint incrementally and same-HEAD retries preserve source-run provenance.
  Nested append checkpoints preserve earlier evidence and deduplicate an exact
  cumulative resend. Aggregate call/turn accounting ignores non-provider tool
  result messages, so a hard terminal limit cannot be reported as exceeded.
  Explanations that explicitly accept a candidate cannot masquerade as
  `not_concerns` evidence. Parent-session duration is enforced by an
  application-owned abort timer, and SIGINT/SIGTERM synchronously roll pending
  installation state back before the CLI exits.
  A subsequent invocation can resume the exact diagnostic-only map when its
  receipt ledger is bound to current HEAD; unattested or extra state remains
  user-owned and blocked. Failed bounded continuations retain their newest
  diagnostic checkpoint, and a tracer receipt cannot satisfy closure until its
  matching concern body is persisted. Provider-turn budgets reconcile against
  provider requests rather than transport-level message counts. Incremental
  concern-evidence deltas default to recursive append, preventing a later
  bounded checkpoint from discarding previously traced bodies. Map writes also
  remove and report Agentify-managed paths from repository topography and
  process-identity evidence before closure is assessed. A successful attested
  concern scout on current HEAD now blocks duplicate scout model execution;
  its proposal names are separated from structured report fields and rejected
  if they exceed the persisted receipt bound. Diagnostic re-entry narrowly
  repairs legacy proposal-only receipt violations before validating the whole
  map; unrelated schema violations remain unrecognized state.

- Explorer success is now persisted as an application-authored receipt ledger
  bound to the audited repository commit. Model map writes cannot create or
  replace the ledger, existing receiptless or stale maps are re-audited, and
  finalization rolls back instead of installing a team whose semantic evidence
  cannot be traced to successful scouts and per-concern tracers.

- Installation now honors explicit tracked repository policies that prohibit
  AI/LLM-authored persistent work. A bounded preflight scan runs before memory
  recovery, runtime repair, audit diagnostics, or transaction setup; it reports
  the exact policy path and an actionable maintainer remediation while leaving
  the repository byte-for-byte unchanged. Permissive policy and unrelated AI
  mentions are covered as negative controls.

- ChatGPT-subscription (openai-codex) sessions no longer fail every request.
  Agentify's per-request output cap injected `max_output_tokens` into the raw
  provider payload, but the ChatGPT Codex backend rejects that parameter
  outright (`Codex error: Unsupported parameter: max_output_tokens`; pi-ai's
  own codex API never sends it). Every probe and audit request died with a
  provider error that surfaced only as "could not reach openai-codex — the
  stored credentials may be missing, invalid, or expired". The cap now leaves
  codex payloads untouched. The reachability probe also reports the actual
  provider error message instead of only the generic credential hint, and
  both payload-rewrite behaviors are pinned by unit tests.
- A stored OAuth subscription credential now counts as usable authentication
  for a plain `agentify` run. The first-run gate (`hasStoredAuth`) only
  recognized API-key entries — OAuth credentials persist as
  `{ type: "oauth", access, refresh, expires }` with no `key` field — so
  after a successful `agentify login` (ChatGPT or Claude subscription) the
  next run fell back into full provider setup and asked for an API key the
  user had already replaced with a subscription sign-in. An expired access
  token still counts: the runtime refreshes it.
- OAuth login and token refresh work from the installed package again. Pi
  loads each OAuth flow implementation through a bundler-opaque dynamic
  import, which survived esbuild bundling and crashed at runtime (`Cannot
  find module dist/openai-codex.js`) on the first `login`, `refresh`, or
  `toAuth` call. All three bundle entry points now register Pi's statically
  bundled OAuth flows — and, because pi-coding-agent ships with a shrinkwrap
  that forces a second nested pi-ai copy npm will not dedupe, the build now
  resolves every bare pi-ai import to the single top-level copy so the
  registration reaches the ModelRuntime path that actually loads flows. A
  regression test reproduces the single-file bundle failure through the real
  ModelRuntime graph (with and without registration, and with and without
  the single-copy plugin) and pins the entry-point and build wiring.
- `write_map_delta` accepts `dimension: "specialist_evidence"` (and
  `"concern_evidence"`) as an alias for an omitted dimension. Audit prompts
  name the concern-evidence gate "specialist evidence", and builders copied
  that label into `dimension`; the enum rejected the write and the traced
  concern payload never landed, so the audit died at the deadline with
  `concern_evidence.concerns was not recorded`. The alias closes no coverage
  dimension, and the write guidance and recovery prompt now state explicitly
  that concern-evidence deltas omit `dimension`.

- Concern-evidence writes no longer fail blind. When a `write_map_delta`
  carrying `concern_evidence` failed schema validation and the sanitizer
  recovery also failed, the tool threw "Internal error: sanitized audit
  evidence does not satisfy CodebaseMapSchema" with no field detail; the
  builder retried blind until it gave up and recorded an empty placeholder
  concern list, and specialist discovery produced zero specialists on a
  repository full of traced concerns. The sanitize recovery now surfaces the
  primary field-level validation errors, reports every array item it drops
  with the exact field and reason, and fails the write outright — with
  per-item drop reasons — when every submitted concern was dropped. An
  omitted `concerns` array is never synthesized into a recorded empty
  decision: the write fails with the missing field named, the completion
  gate stays open, and an audit whose concern evidence never lands ends in a
  loud "did not reach structured closure" error instead of a silent empty
  portfolio.
- The bounded top-up audit prompt described the retired `expert_evidence`
  field shape; it now names the actual `ConcernSchema` fields.

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
