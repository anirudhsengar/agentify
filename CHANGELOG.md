# Changelog

All notable changes to Agentify are documented here.

## [Unreleased]

### Added

- Multi-ecosystem repository support during installation: Node.js, Python,
  Rust, Go, Java (Maven and Gradle), Ruby, and Makefile-based projects can
  now be inspected, validated, and configured without requiring `package.json`.
- A read-only planner role that refines implementation steps between two
  deterministic planning passes, decomposing ambiguous or compound acceptance
  criteria before a plan is recorded.
- The builder may inspect, edit, and self-check across a bounded turn budget
  before its terminal typed submission, instead of one single-shot whole-file
  call.

### Fixed

- Ignore .tmp-live/ local multi-ecosystem probe clones so pack:release clean-tree checks stay green.
- On Windows, execute `.bat`/`.cmd` validation wrappers (Gradle/Maven) via
  `cmd.exe /d /s /c` with repository cwd confinement so installer and
  task-lifecycle validation no longer fail with `spawnSync EINVAL`.
- Index validation reports in `docs/README.md` and the npm package `files`
  list so documentation-invariant tests and shipped artifacts stay aligned.
- Add `tests/installer/edge-case-campaign.test.ts` covering 23 synthetic
  installer/resolver edge cases (lockfile policy, unsafe scripts, manifest
  precedence, multi-ecosystem blockers).

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
