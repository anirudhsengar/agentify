# Changelog

All notable changes to Agentify are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses Semantic Versioning while remaining pre-1.0.

## [Unreleased]

### Changed

- GitHub Actions automation is now an explicit opt-in: interactive runs ask before installation or refresh, and scripted runs require `--github-runtime`. Default audits retain codebase intelligence and selected harness exports without adding workflows, secrets guidance, or Agentify implementation tests to the target repository.
- Revert snapshots now retain only Agentify-managed files that a run can replace; user-owned files remain untouched and are no longer copied into repository state.

### Fixed

- D1 deltas now remain open until they include both entry points and the
  fresh-agent reading list required by the topography closure gate.

- Pitfall line references such as `"line 42"` are now normalized to the
  schema-required numeric form before strict validation, preserving otherwise
  substantive large-audit evidence from compatible providers.

- D1 delta closure now recognizes the schema's object-shaped entry points;
  valid `{ path, role, language, run_command }` evidence is no longer treated
  as missing.

- Topography-gap responses now include a copyable schema-valid entry-point
  delta, giving compatible providers a direct repair path without weakening
  evidence validation.

- Topography guidance and validation feedback now state the complete entry
  point object shape, preventing string-only paths from being sanitized away.

- D1 map deltas now retain a gap state until they include a non-empty
  `skeleton.entry_points` record, enforcing the topography closure invariant
  at the structured-output boundary.

- The mandatory first topography checkpoint now requires a real entry point,
  preventing a superficially covered D1 from failing the strict closure gate.

- Session cancellation now clears queued SDK continuations before aborting the
  active stream, preventing post-closure provider reads from extending a
  successfully completed brownfield audit.

- Large brownfield audits now explicitly require a direct topography delta
  before delegating feature exploration, preventing a pre-created bootstrap
  map from being mistaken for the auditor's first checkpoint.

- Incremental bootstrap-map updates now retain the valid audit trail when a
  provider supplies a malformed exploration log, allowing the remaining
  evidence to be sanitized and persisted instead of failing during logging.

- Brownfield runtime recovery now also checks owned coverage state after a
  structured map write, so a model that ends with incomplete coverage receives
  bounded same-session delta recovery prompts instead of being treated as done.

- Coverage recovery prompts now include the exact minimal payload shapes for
  substantive pitfalls and security damage-control evidence, preventing
  otherwise well-evidenced large audits from stopping on schema recall errors.

- Brownfield sessions now wait for zero coverage warnings—not merely ten
  `covered` status labels—before aborting after map closure, allowing
  substance-gated dimensions to receive their bounded recovery prompts.

- Brownfield sessions now also stop after any streamed message once the owned
  canonical map satisfies strict closure, preventing a provider from spending
  additional turns repeatedly rereading an already-complete large audit.

- Brownfield audits now create a transaction-scoped, honest gap-marked map
  before model analysis when no canonical map exists. This lets large audits
  provide evidence through incremental `write_map_delta` calls while retaining
  the same strict coverage gate before any artifacts are rendered.

- Partial nested map deltas now automatically retry as a deep merge when the
  declared default shallow merge would erase required existing evidence.

- Incremental evidence sent to Agentify-created bootstrap drafts now preserves
  valid prior state and discards malformed optional fields, while existing-map
  deltas continue to reject malformed data strictly.

- Bootstrap map sanitization now retains its internal draft marker after a
  provider replaces the exploration log, so later malformed incremental
  evidence still receives the bootstrap-only transport repair.

- A fully valid provider map replacement now also retains the transaction's
  bootstrap marker, so later malformed incremental evidence remains repairable
  throughout the same large audit.

- Brownfield session timeouts now race pending provider prompts, so an SDK
  abort that never settles cannot keep the audit process or its state
  transaction open indefinitely.

- Brownfield audits now abort a session after five minutes without any SDK
  event, preventing a stalled provider from leaving repository state
  transactions open indefinitely while allowing normal streamed responses.

- Brownfield map writes now accept a complete inline map serialized as a JSON
  object string by compatible model transports, including bounded
  double-serialization, while rejecting malformed or non-object strings
  through the owned tool's existing strict validation.

- Custom feature explorers no longer attempt to read internal prompt-template
  files from the target repository; their prompts are composed inline within
  the audit's read-only boundary.

- Audit logs now store compact, parseable summaries of tool and model events,
  retaining tool outcomes while avoiding truncated nested JSON payloads.

- Brownfield map writes now discard wholly empty, premature artifact-intent
  placeholders so in-progress coverage updates can continue; substantive
  artifact intents remain schema-validated for final rendering.

- Brownfield map writes now repair a provider serialization quirk that places
  known map sections beside the `map` wrapper, preserving strict validation
  while allowing the complete intended payload to be recorded.

- Brownfield explorer dispatch is now bounded to 16 total explorers, two
  concurrent explorers, and two minutes per explorer. The builder prompt now
  directs evidence-first dispatch instead of inviting unbounded parallel work.

- Audit logs now omit repetitive streaming partial-message events, preventing
  long model responses from expanding a single run log by hundreds of
  megabytes while retaining message-boundary and tool-execution evidence.

- Feature explorers now inherit the configured explorer model by default.
  Brownfield audits no longer waste attempts requesting unavailable Anthropic
  model aliases on providers such as MiniMax.

- Brownfield audits now make up to two in-session recovery passes when a model
  ends normally without issuing the required structured `write_map` call,
  rather than immediately failing the audit.

- State-transaction cleanup now removes an empty repository `.agentify/`
  container after the final transaction completes, while retaining it whenever
  it contains other state.

- Repositories with user-owned conventional files such as `AGENTS.md`,
  `specs/README.md`, `ai_docs/README.md`, or Agentify-like GitHub paths no
  longer falsely appear as incomplete Agentify setups. Legacy recovery now
  requires a managed marker or Agentify-specific state evidence.

- Scaffold installation now uses syntax-valid markers for JSON and JavaScript/TypeScript assets, preserves source modes, invokes shell helpers through Bash, omits empty extension placeholders, and uses the selected canonical state directory in generated expert and prompt references.

- Generated runtime validation no longer depends on a copied root `tests/` tree.

- Rendered output rejects stale bootstrap claims, unsupported perfect-coverage conclusions, legacy path leaks, and malformed JSON before applying a bundle.

- Existing user-owned `.gitignore` files are now preserved during scaffold application instead of being replaced by Agentify's runtime ignore rules.

### Changed

- Agentify now writes its generated agents, prompts, workflows, extensions, skills, experts, and conditional-docs surface under the selected harness's state directory. Safe relative `.pi/*` compatibility symlinks preserve existing runtime references without duplicating that surface.
- Before an interactive run, Agentify refreshes the tracked remote branch and offers a fast-forward pull when the local branch is behind.
- Long multi-select prompts show a live summary of all current selections, and interrupted state transactions now present a resume-or-fresh choice before safe recovery runs.
- Empty Agentify state directories are ignored as if absent, avoiding irrelevant compatibility warnings and recovery prompts.
- On an initialized repository, interactive runs now let the user choose between resuming the existing setup and starting a fresh managed run; scripted invocations continue to resume deterministically.
- All interactive choice prompts now use one stable, viewport-aware selector; keyboard navigation redraws in place instead of leaving duplicate frames in the terminal.
- Long choice lists show at most 30 entries at once and explicitly indicate when additional options are available below.
- Completed selectors now collapse to a concise answered line. Audit and greenfield sessions report their current activity and cumulative provider-reported spend instead of opaque turn-only updates.
- Brownfield audit map guidance now directs read-only model sessions to submit inline maps with `write_map(mode="auto")`; automatic private draft transport handles oversized maps without suggesting an unavailable general-purpose write tool.
- The paired Pi runtime packages are upgraded atomically to 0.80.7, retaining Node 22.19.0 support, Pi-controlled TypeBox 1.1.38 copies, Agentify-owned authentication and execution policy, model-visible tool contracts, and the existing Smithy integrity override while accepting upstream provider, dynamic-tool, session-affinity, and Bedrock fixes.
- The direct TypeBox dependency is upgraded to 1.3.6 while Pi-controlled nested TypeBox copies remain at 1.1.38; schema serialization, validation/error behavior, tool-schema identity, package boundaries, and the Node support policy are unchanged.
- esbuild is upgraded to 0.28.1 and tsx to 4.23.1 as one build-tooling group; the lockfile deduplicates tsx's nested esbuild/platform tree while preserving the Node 22 ESM bundle, source maps, runtime assets, installed CLI behavior, and 181-file package inventory.
- TypeScript is upgraded to 6.0.3 with Node-22 declarations 22.20.1; obsolete `baseUrl`, wildcard `paths`, and `ignoreDeprecations` configuration are removed while the Node 22.19.0 runtime floor and ESM/bundler behavior remain unchanged.
- Audit-schema domain ownership and downward-only dependencies are documented and machine-enforced while preserving the declaration-free façade, schema identity, algorithm separation, and package confinement.
- Audit-map complete/partial composition and write-map parameter schemas now have canonical owners under `src/core/audit/schema/`; the stable `schema.ts` façade is declaration-free and preserves object identity.
- Supported runtime code now owns state exclusively through explicit provider-scoped contexts, write-map factories, renderer contexts, and state-directory-aware manifest and greenfield APIs.
- Phase B retained-source migration, transaction recovery, deterministic conflict handling, provider switching, and Pi canonical `.pi/agentify` behavior remain unchanged.

### Removed

- Removed deprecated singleton `writeMapTool` / `writeMapDeltaTool` exports, mutable write-map and renderer state setters, omitted-context renderer behavior, and obsolete manifest, greenfield, and legacy path wrappers.
- Removed ordinary canonical-loader fallback probes; retained legacy trees are migration sources only and are never selected by normal readers.

## [0.2.1] - 2026-07-14

### Fixed

- `v0.2.0` was tagged, but npm publication did not complete and no GitHub release was published. The workflow passed `release-artifact/agentify-0.2.0.tgz` as an ambiguous package specification, so npm interpreted it as GitHub shorthand instead of a local tarball path.
- The publication workflow now resolves exactly one downloaded local `.tgz` file and publishes that explicit path, failing closed when zero or multiple tarballs are present.

### Changed

- `0.2.1` contains the complete release contents intended for `0.2.0`, together with the corrected artifact-publication workflow.
- The unscoped `agentify` npm name is owned by another publisher, so the official package is now `@anirudhsengar/agentify`; the installed executable remains `agentify`.
- Release artifact handling now derives the exact tarball filename from the single validated result returned by `npm pack --json` instead of assuming an unscoped filename.

## [0.2.0] - 2026-07-13

### Added

- A compatibility-first design and characterization fixture for retiring cross-provider `.pi/agentify` fallbacks and deprecated state/write-map APIs without deleting or silently selecting user state.
- A dependency compatibility matrix with official migration evidence, isolated lockfile impact, explicit #32/#33 gates, and six separately owned upgrade groups.
- Evidence-based lifecycle decisions for webhook, AIW, orchestrator, communications, and Agent Expert, with communications relocation split into a dedicated follow-up issue.
- An audited runtime-reachability inventory and maintenance guard for standalone scripts.
- Modernization behavior and runtime-reachability contracts with a reusable CLI, generated-bundle, state-directory, and installed-package parity gate.
- Typed top-level CLI parsing with process-level regression coverage.
- Recursive test discovery, security regression suites, and installed-package smoke tests.
- Explicit per-session execution policies for tools, filesystem roots, shell access, and network posture.
- Transactional provider-scoped state with journals, backups, rollback, migration, and interrupted-run recovery.
- Webhook replay protection, pre-authentication throttling, sanitized task status, and opt-in administrative reload.
- Tag/version release verification, artifact-driven publication, Node 22/24 CI, production dependency auditing, and package installation gates.
- A documented supported-versus-experimental product boundary.
- A compiled ESM distribution with packaged prompt/workflow assets and raw-source exclusion.

### Changed

- Legacy state now migrates with a retained-source, journaled copy → verify → atomic-install transaction; the original legacy tree is retained and never silently deleted, explicit provider switches require `--targets` plus `--migrate-state`, recovery is phase-driven, and canonical readers/scaffold scripts no longer probe cross-provider fallbacks.
- Deprecated callable state, manifest, renderer, greenfield, and write-map compatibility APIs remain available in 0.2.0; this release does not perform Phase C removal.
- Relocated the internal communications registry, protocol types, and Unix-socket peer server beneath `src/core/orchestrator/comms/` without changing protocol, state, CLI, build, package, or support behavior.
- Legacy `.pi/agentify` compatibility use is classified deterministically and reported once per command with the exact source and provider-selected destination, providing deprecation guidance before any eligible migration.
- Enforced supported, neutral, and experimental source boundaries across imports, CLI registration, build assets, package contents, and documentation.
- Audit TypeBox declarations remain centralized in `schema.ts`, while coverage assessment, map defaults, and legacy-field interpretation now have focused internal owners behind stable re-exports.
- Structured write-map storage, input loading, validation, coverage formatting, delta merging, observability, tool construction, and legacy compatibility now have dedicated internal owners behind the stable façade.
- Deterministic brownfield artifact rendering is decomposed into pure output-family modules behind the stable renderer façade.
- Brownfield write-map tools and deterministic renderers now capture provider-scoped state through explicit per-run factories and contexts; deprecated mutable adapters remain for compatibility.
- Brownfield and greenfield run orchestration now live in explicit mode-specific modules behind the stable `runAgentify` coordinator.
- Repository-facing snapshot, staging, apply, reporting, and session-agent generation primitives now have dedicated internal owners while retaining compatibility re-exports.
- Shared artifact, agent-file, generated-surface, and package-version primitives now have dependency-neutral canonical owners with compatibility re-exports.
- Removed four evidence-backed, raw-source-only orphan scripts and corrected stale provider-state migration guidance.
- Brownfield audits and explorer sessions are read-only by capability, not by prompt convention.
- Webhook and AIW sessions now receive explicit repository-jail policies.
- Pi runtime packages were upgraded to `0.80.6`; provider environment-auth resolution is owned by Agentify.
- npm publication now uses the exact tarball verified by CI.
- The public npm package exposes only the `agentify` executable and blocks deep imports.
- The CLI binary executes `dist/cli.js` directly; `jiti` and runtime TypeScript execution were removed.
- TypeScript now rejects unused locals and parameters across production code and tests.

### Fixed

- Provider-scoped write-map factories now keep oversized-map draft transport under the selected state directory instead of writing through the legacy Pi path.
- `--mode` and `--targets` no longer collide with subcommand dispatch.
- Shell-based credential reads and repository mutation escapes are blocked.
- Webhook workers can no longer run without an enforceable sandbox policy.
- Failed Claude, Codex, and Pi runs no longer destroy valid prior state.
- Invalid webhook signatures no longer consume authenticated trigger quotas.
- Manual release dispatch can no longer publish packages or create GitHub releases.
- Test files can no longer be silently omitted by a manually maintained command chain.

### Security

- Provider-switch manifests are opened once with no-follow semantics, validated with `fstat`, and read from the same descriptor, removing the check-to-read race without weakening symlink refusal.
- Root confinement checks both lexical and symlink-resolved paths.
- Unrestricted shell tools were removed from brownfield audit sessions.
- Reload management is disabled by default and requires loopback plus constant-time token authentication.
- High-severity advisories in transitive `undici`, `protobufjs`, and `ws` dependencies were removed through the Pi runtime upgrade.

## [0.1.0]

Initial public CLI release.
