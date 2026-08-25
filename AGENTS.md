# AGENTS.md

Repository instructions for coding agents. Read `README.md` and
`docs/architecture/install-once-repository-team.md` before changing code.

## Product contract

Agentify installs a persistent, repository-specific engineering team into an
existing GitHub repository. Authorized GitHub issues are the normal work
interface after installation.

The canonical team has one orchestrator, a read-only planner that refines
implementation steps before each plan is recorded, evidence-backed read-only
specialists, exactly one writable builder per task, one role-separated
automated read-only reviewer, and a path-restricted knowledge maintainer.
Application changes stop at an unmerged draft pull request. A human retains
merge authority.

Durable learning is versioned external memory. Every learned record requires
provenance, a supporting commit, confidence, freshness, and deterministic
invalidation. Automatic learning is confined to the validated knowledge
allowlist and cannot modify application source, dependencies, workflows,
permissions, protected policy, or executable runtime code.

## Build and test

- `npm run build` bundles the CLI, task runtime, and learning runtime into
  `dist/`, then copies runtime assets.
- `npm run typecheck` runs strict TypeScript checking without emission.
- `npm run test:all` builds, discovers every source test recursively, and runs
  repository contract tests.
- `npm run test:memory` verifies identity, provenance, recovery, and memory.
- `npm run test:specialists` verifies specialist discovery and persistence.
- `npm run test:learning` verifies accepted-merge learning and self-update.
- `npm run test:lifecycle` verifies authorized issue execution.
- `npm run test:package` packs, installs, and executes the real npm artifact.
- `npm run verify:release` is the authoritative release gate.
- Node.js 22.19.0 or newer is required. The repository is ESM-only.

## TypeScript conventions

- Strict TypeScript; no `any`. Use `unknown` plus type guards.
- Use `import type` for type-only imports.
- Prefer functions and explicit data structures. Use classes only for genuinely
  stateful behavior.
- Files and folders use kebab-case; functions use camelCase; types use
  PascalCase; module constants use SCREAMING_SNAKE_CASE; tools use snake_case.
- Top-level TypeBox schemas use `Type.Object({...})`. Descriptions are
  model-visible contract instructions. Bound arrays and mark optional fields
  explicitly.

## Ownership boundaries

- Public CLI behavior is owned by `src/core/public-cli-contract.ts`.
- Audit TypeBox declarations live under `src/core/audit/schema/`.
  `src/core/audit/schema.ts` is the stable façade; algorithm modules stay
  TypeBox-free. Schema imports are downward-only and enforced by tests.
- Audit execution policy and defense live under `src/core/audit/defense/`.
- Persistent identity and provenance live under `src/core/memory/`.
- Specialist evidence, discovery, routing, persistence, and synchronization live
  under `src/core/specialists/`.
- Accepted-merge assessment, invalidation, reconciliation, and knowledge
  publication live under `src/core/learning/`.
- Authorized issue planning, role authority, builder tools, validation, review,
  recovery, and draft publication live under `src/core/task-lifecycle/`.
- Installed workflow assets live under `scaffold/`; their executable sources are
  bundled from `src/core/task-lifecycle/cli.ts` and `src/core/learning/cli.ts`.
- Build logic lives in `scripts/build.mjs`. Package-root discovery uses
  `src/core/package-root.ts`.
- The npm package exposes only the `agentify` executable and `package.json`.

New shared exceptions, public commands, package exports, or installed runtime
assets require architecture, package, and security review plus boundary-test
updates.

## Security and autonomy invariants

- Model sessions run through `@earendil-works/pi-coding-agent` with an explicit
  execution policy defining tools, roots, protected paths, command posture,
  explicit lack of network isolation, deadlines, output caps, retries, and
  budget.
- Audit evidence collection is read-only and receives only approved filesystem
  tools plus trusted structured tools such as `write_map`, `write_map_delta`,
  and `spawn_explorer`.
- Model proposals enter application-owned tools and strict schemas. Free-form
  model text is never authoritative state.
- Exactly one builder may receive application-source write authority per task.
- Model processes never receive GitHub write credentials.
- Trusted workflow code validates typed output before branch, comment, label, or
  draft pull-request changes.
- Application work requires an authorized issue, expected base commit, isolated
  branch, deterministic validation, role-separated automated review, and human merge.
- Accepted-merge learning binds to the exact default-branch commit and its first
  parent in the canonical repository.
- Knowledge writes require schema validation, provenance, path and symlink
  confinement, deterministic journals, real-byte hashes, and size limits.
- Generated files are applied only after coverage and substance gates pass.
  Managed markers and manifests determine ownership.

## Dependency and package policy

- The published npm package declares zero runtime `dependencies`: the `dist/`
 bundles are fully self-contained, so user installs fetch no transitive
 packages and run no third-party install scripts.
- Every third-party package is a `devDependency` bundled at build time. Adding
 one requires maintainer approval and proof that esbuild can bundle it (no
 native modules or runtime `node_modules` filesystem assets reachable from the
 three bundle entry points); `npm run test:package` must install and exercise
 the exact artifact cleanly.
- Security auditing covers the full dependency tree (`npm audit` without
 `--omit=dev`) because the shipped bundles contain code built from that tree.
- The npm artifact excludes raw `src/`, blocks deep imports, and contains every
 workflow, prompt, asset, and executable needed at runtime.
- Do not add runtime TypeScript loaders.

## Documentation and releases

- Update `CHANGELOG.md` under `[Unreleased]` for notable changes.
- Keep README, CLI help, architecture, package inventory, and exact-artifact
  tests consistent.
- Update architecture, security, state, build, or release documentation when its
  boundary changes.
- Publication is tag-only and artifact-driven. Manual workflow dispatch verifies
  but does not publish.

## Scope discipline

Do not add automatic application merge, deployment, unsolicited source changes,
concurrent model writers, opaque memory, executable self-modification,
unsupported library exports, or hidden public control-plane commands.
