# Contributing

Agentify is a security-sensitive Node.js CLI and installed GitHub runtime. Keep
changes small, typed, deterministic, and reviewable.

## Setup

```bash
git clone https://github.com/anirudhsengar/agentify.git
cd agentify
npm ci
npm test
```

Use Node.js 22.19.0 or newer. The project is ESM-only and uses strict
TypeScript.

## Source layout

```text
src/cli.ts                    installed CLI entry point
src/core/audit/               read-only repository mapping and defenses
src/core/installer/           preflight, policy, installation, and canaries
src/core/memory/              durable identity, provenance, and recovery
src/core/specialists/         specialist discovery, routing, and persistence
src/core/task-lifecycle/      authorized issue execution
src/core/learning/            accepted-merge knowledge maintenance
scaffold/                     files installed into target repositories
scripts/                      build and release tooling
tests/                        source, contract, security, and package tests
```

The authoritative architecture is
[docs/architecture/install-once-repository-team.md](docs/architecture/install-once-repository-team.md).

## Implementation rules

- Do not use `any`; narrow `unknown` with explicit type guards.
- Use `import type` for type-only imports.
- Prefer functions and explicit data structures.
- Use kebab-case files, camelCase functions, PascalCase types, and
  SCREAMING_SNAKE_CASE module constants.
- Keep TypeBox declarations inside their owning schema modules.
- Treat schema order, descriptions, required fields, enums, error order, and
  exported identity as contract data.
- Do not add a production dependency without a documented installed-runtime
  need and maintainer review.
- Do not expose internal runtime entry points through the public CLI or package
  exports.

## Security rules

- Every model session must receive an explicit execution policy.
- Audit, specialist, planner, reviewer, and knowledge-maintainer roles are
  read-only for application source.
- Only one builder may write application source for a task.
- Never pass credentials in argv, logs, repository files, model prompts, or
  durable memory.
- Validate repository-relative paths lexically and against symlink traversal
  before writing.
- Preserve user-owned files and fail closed on ambiguous ownership.
- Keep deployment and application merge outside Agentify authority.

## Validation

Run focused tests while working, then run:

```bash
npm run typecheck
npm run test:all
npm run verify:release
```

`verify:release` is the authoritative gate. It includes source tests, scaffold
tests, exact packed-artifact installation, and the production dependency audit.

Update documentation whenever a public command, package surface, trust boundary,
state format, workflow, or release invariant changes. Add notable user-facing
changes under `[Unreleased]` in `CHANGELOG.md`.

## Pull requests

Explain the problem, the chosen boundary, and the verification performed. Keep
unrelated refactors separate. Do not include generated `.agentify` state,
credentials, package tarballs, or temporary evidence.
