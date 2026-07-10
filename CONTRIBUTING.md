# Contributing to agentify

Thanks for your interest in agentify. agentify is a Node CLI that turns
a repository into an "agentic codebase": auditing existing code, building
greenfield projects, and exporting harness-native surfaces (Claude Code,
Codex, Pi, etc.). Contributions land in the same repo, ship via npm, and
are exercised against real target repos on every PR.

> For agentic / coding-agent contributions, also read `AGENTS.md` —
> it is the authoritative working notes for tooling agents operating in
> this repo.

## Code of conduct

Be respectful. Assume good faith. Disagree on substance, not on
person. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
in spirit.

## Project layout

```
agentify/
├── bin/                      # CLI entrypoint (bin.agentify)
├── src/
│   ├── cli.ts                # process argv parser
│   └── core/
│       ├── agentify-app.ts   # single runtime entry; throws on unknown subcommands
│       ├── audit/            # audit + defense hook (only schema.ts defines schemas)
│       ├── orchestrator/     # orchestrator state and prompts
│       ├── aiw/              # AIW worker (plan, build, review, fix)
│       ├── webhook/          # webhook server (signature, queue, worker)
│       ├── models/           # named model slots
│       └── artifact-exporters/  # writes AGENTS.md, specs/, ai_docs/, harness exports
├── scaffold/                 # the GitHub runtime scaffold shipped into target repos
├── tests/                    # tsx unit suite + bash contract tests
├── docs/                     # lifecycle, orientation
└── package.json              # bin, files, engines.node>=22.19.0, prepublishOnly
```

## Local setup

```bash
git clone https://github.com/anirudhsengar/agentify.git
cd agentify
npm ci
```

Node `>=22.19.0` is required (pinned in `package.json` `engines` and
in `.github/workflows/ci.yml`). The repo is ESM-only
(`"type": "module"`).

## Running tests

```bash
npm run typecheck           # tsc --noEmit, must pass
npm run test:unit           # tsx unit suite
npm test                    # typecheck + unit + bash tests/run.sh
npm run test:scaffold-e2e   # only when scaffold/ changes
npm run test:security-redteam  # only when defense/ or webhook/ changes
```

`npm test` is what CI runs; keep it green before opening a PR.

## Pull request flow

1. Fork and create a branch off `main` (`feat/...`, `fix/...`,
   `docs/...`, `refactor/...`, `ci/...`).
2. Make your change. Keep commits small and the diff reviewable.
3. Update `CHANGELOG.md` `[Unreleased]` (Added / Changed / Fixed /
   Removed). This is what release-drafter consumes.
4. If your change is user-facing, update `README.md` and any relevant
   file under `docs/`.
5. If you changed behavior, add a test under `tests/` that fails
   before your change and passes after.
6. Run `npm test` locally and paste the result line in the PR body.
7. Open the PR using `.github/PULL_REQUEST_TEMPLATE.md`. The CI
   workflow will run typecheck + the full test suite.

## Architectural rules

These are non-obvious and worth reading before opening a PR:

- **One runtime entry.** `agentify` (no args) is the only audit /
  greenfield entrypoint. New user-facing commands must be CLI
  subcommands under `src/cli*.ts`. Do not add slash-command
  registration, Pi auto-discovery, or extension adapters.
- **TypeBox schemas live in exactly one place:**
  `src/core/audit/schema.ts`. Other modules import from it.
- **Defense policy** lives under `src/core/audit/defense/`. Keep it
  centralized — do not scatter defense checks across call sites.
- **Slot resolution is strict.** The named model slots fall back to
  `primary` only when unset; explicit user choices are never
  silently overridden.
- **No new runtime dependencies** without explicit maintainer
  approval. The approved runtime set is `typebox` plus peers
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.
- **Strict TypeScript.** No `any`; use `unknown` and type guards.
  `import type` for type-only imports. No default exports unless a
  framework requires it. Avoid classes unless they hold state across
  many methods.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: tier the shipped skill pack, prune duplicates
fix: ship harness exports to .pi/skills/ instead of .agents/skills/
docs: named model slots
refactor: thread modelRole through orchestrator sub-agents
ci: pin Node 22.19.0 in CI workflow
```

Release-drafter reads the commit history to assemble release notes; the
type and scope prefixes drive the auto-grouping.

## Filing issues

- **Bugs:** use the "Bug report" issue template.
- **Features:** use the "Feature request" issue template.
- **Security:** do **not** open a public issue. Follow `SECURITY.md`.

## Release process

1. Bump `package.json` `version` (semver). The current major is `0.x`;
   breaking changes bump minor + reset patch.
2. Move the `[Unreleased]` block in `CHANGELOG.md` into a dated
   `## [<version>] - YYYY-MM-DD` section.
3. Run `npm run release:check` locally.
4. Tag the release. The `release-publish` workflow publishes to npm
   and creates a GitHub release using release-drafter's draft.

## License

By contributing, you agree that your contributions will be licensed
under the project's MIT license. See `LICENSE`.