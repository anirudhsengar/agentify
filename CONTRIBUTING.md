# Contributing to Agentify

Agentify is a Node CLI that audits existing repositories, forms greenfield
projects, and emits harness-native agent surfaces. Contributions ship through
one repository and one npm package.

Coding agents operating in this repository must also read `AGENTS.md`. Product
usage and the supported command surface are documented in `README.md`.

## Code of conduct

Be respectful, assume good faith, and disagree on substance rather than the
person. The project follows the Contributor Covenant in spirit.

## Repository layout

```text
agentify/
├── bin/                         # thin executable importing dist/cli.js
├── dist/                        # generated compiled CLI and runtime assets
├── scripts/build.mjs            # single build implementation
├── src/
│   ├── cli.ts                   # public CLI entry
│   └── core/
│       ├── audit/               # evidence collection, schemas, defense
│       ├── security/            # execution-policy capability model
│       ├── state-transaction.ts # provider-state transaction and recovery
│       ├── orchestrator/        # internal experimental runtime
│       ├── aiw/                 # internal experimental runtime
│       └── webhook/             # internal experimental runtime
├── scaffold/                    # GitHub runtime installed into target repos
├── tests/                       # recursively discovered tests and contracts
├── docs/                        # architecture and lifecycle documentation
└── package.json                 # public/package/build boundary
```

`dist/` is generated and is not committed. The installed package is narrower
than the source checkout and does not include raw `src/`.

## Local setup

```bash
git clone https://github.com/anirudhsengar/agentify.git
cd agentify
npm ci
```

Node `>=22.19.0` is required. The repository and published command are ESM-only.

## Build and verification

```bash
npm run build                  # compile CLI and copy runtime assets
npm run typecheck              # strict TypeScript validation
npm run test:unit              # recursively discovered TypeScript tests
npm run test:all               # build + all TypeScript and contract tests
npm run test:package           # inspect/install/execute the packed artifact
npm run test:maintenance       # documentation and package-policy invariants
npm test                       # typecheck + complete executable test suite
npm run release:check          # release-equivalent source and package gates
```

Use `npm run test:scaffold-e2e` when changing `scaffold/`, and
`npm run test:security-redteam` when changing audit defense, execution policy,
or webhook security.

CI runs typecheck, the full suite on Node 22.19 and Node 24, a production
high-severity dependency audit, packed-package smoke tests, and CodeQL.

## Pull request flow

1. Branch from current `main` using a descriptive `feat/`, `fix/`, `docs/`,
   `refactor/`, or `ci/` name.
2. Keep commits focused and the diff reviewable.
3. Add a regression test for behavior changes.
4. Update `CHANGELOG.md` under `[Unreleased]` for notable changes.
5. Update the relevant architecture, security, state, build, or release docs
   when a boundary or lifecycle changes.
6. Run the appropriate verification commands and record them in the PR body.
7. Open the PR using `.github/PULL_REQUEST_TEMPLATE.md`.

## Architectural rules

- **One supported runtime surface.** The installed `agentify` command is the
  supported public runtime. New public behavior must enter through documented
  CLI commands or generated GitHub surfaces.
- **Internal means internal.** Orchestrator, AIW, webhook, communications, and
  Agent Expert modules remain experimental and are not package APIs. Follow
  `docs/experimental-surfaces.md` before attempting to productize one.
- **Schemas are centralized.** Audit TypeBox schemas live in
  `src/core/audit/schema.ts`.
  Coverage assessment, map defaults, and legacy-field interpretation live in
  adjacent algorithm modules and remain re-exported by `schema.ts` for
  compatibility.
- **Security is capability-based.** Every model-backed session must receive an
  explicit execution policy. Prompts do not grant or restrict authority.
- **Brownfield audits are read-only.** Do not restore unrestricted `bash`,
  `write`, or `edit` to audit and explorer sessions.
- **State replacement is transactional.** Preserve crash recovery, complete
  rollback, provider-scoped state, and durable commit semantics.
- **Rendering and ownership are deterministic.** Structured model proposals
  must pass schemas and quality gates before render/apply. Managed markers and
  manifests determine ownership.
- **Build logic has one owner.** Packaging behavior belongs in
  `scripts/build.mjs`, not duplicated workflow shell fragments.
- **No raw-source runtime.** `bin/agentify.js` imports `dist/cli.js`. Never add a
  runtime TypeScript loader or publish `src/` to hide a missing build asset.

## Dependency policy

New production dependencies require explicit maintainer review and an
installed-runtime justification.

Current production dependencies are:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `typebox`

They are regular dependencies because the installed command uses them. Build
and test tooling—including `esbuild`, `tsx`, TypeScript, and `@types/node`—must
remain in `devDependencies`.

When adding a runtime asset, update the explicit copy manifest in
`scripts/build.mjs` and the packed-package assertions in
`tests/package/installed-cli-smoke.mjs`.

## TypeScript and code style

- Keep strict TypeScript and avoid `any`; use `unknown` with type guards.
- Use `import type` for type-only imports.
- Prefer named exports and functions with explicit data structures.
- Use `kebab-case` files, `camelCase` functions, `PascalCase` types, and
  `SCREAMING_SNAKE_CASE` module constants.
- Keep TypeBox field descriptions deliberate because they steer model behavior.

## Commit messages

Use Conventional Commits, for example:

```text
feat: add provider-scoped transaction recovery
fix: reject shell-based audit mutation
build: publish compiled distribution
docs: document package boundary
ci: verify tag and package version
```

## Issues and security reports

Use the repository issue templates for bugs and feature requests. Do not report
security vulnerabilities in a public issue; follow `SECURITY.md`.

## Release process

1. Update `CHANGELOG.md` and bump `package.json` according to pre-1.0 semantic
   versioning.
2. Run `npm run release:check`.
3. Create a `v<package-version>` tag.
4. The tag-only release workflow verifies the tag/version match, builds and
   smoke-tests one tarball, publishes that exact artifact, and creates the
   GitHub release. Manual workflow dispatch is verification-only.

## License

Contributions are licensed under the repository's MIT license.