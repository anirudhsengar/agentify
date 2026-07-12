# Modernization parity baseline

This document freezes Agentify's current supported behavior before production modules are moved during the modernization sequence tracked by #20. It is a characterization contract, not a redesign target. Later refactors must preserve the behavior described here unless a separate user-facing change is approved, documented, and tested.

## Public compatibility surface

Agentify 0.1.x has one supported public runtime surface: the installed `agentify` executable declared by `package.json#bin` and backed by the compiled `dist/cli.js` bundle.

The compatibility surface includes:

- top-level `--help`, `--version`, `--mode`, and `--targets` parsing;
- the `login`, `logout`, `models`, and `revert` utility subcommands;
- process exit status plus the distinction between stdout and stderr;
- brownfield bootstrap, greenfield formation, attach, partial recovery, abort, and conflict flows;
- generated repository paths and deterministic file contents;
- managed and unmanaged ownership decisions, including deterministic alongside paths;
- required-conflict atomicity and rollback behavior;
- symlink and repository-containment rejection;
- provider-scoped state directories and the current legacy fallback;
- manifest structure, ordering, hashes, and state-directory metadata;
- the packed and installed npm artifact, not raw TypeScript imports.

The package remains intentionally restrictive: raw `src/` is not shipped and the package exports no library runtime API.

## Internal experimental surfaces

Webhook, AIW, orchestrator, communications, and Agent Expert modules are internal experimental composition surfaces. Their source presence and repository tests do not make them public package APIs or CLI command families. They remain reachability roots when used by build, security, contract, or composition tests, as defined in `docs/refactors/runtime-reachability.md`.

## CLI behavior contract

The parity suite characterizes the compiled executable and preserves these rules:

| Scenario | Stable behavior |
| --- | --- |
| `agentify --help` | Exit 0; help is written to stdout; stderr is empty; documented options and subcommands remain ordered and present. |
| `agentify --version` | Exit 0; the package version plus one newline is written to stdout; stderr is empty. |
| Invalid top-level option | Non-zero exit; concise `agentify:` diagnostic on stderr; no stack trace; no normal stdout output. |
| Unexpected positional argument | Non-zero exit; stderr identifies the unknown subcommand and lists `login`, `logout`, `models`, and `revert`. |
| Utility dispatch | A recognized utility subcommand owns its remaining argv, return status, stdout, and stderr. |
| Non-interactive run without credentials | Target resolution must not prompt for target selection; the run reaches the existing configuration/auth boundary and fails concisely if configuration requires interaction. |
| Explicit `--targets` in a non-interactive shell | The target picker is bypassed; target validation remains strict and ordered. |

Exact byte comparison is appropriate for deterministic help and version output. Semantic assertions are used where a stable message contains a documented dynamic fragment.

## Generated-artifact contract

For a fixed validated brownfield map or greenfield formation:

- rendering is deterministic;
- generated path inventory and path ordering are stable;
- managed marker strings and formatting are stable;
- a first apply writes the managed bundle and a sorted manifest;
- a repeated identical apply leaves deterministic file bytes unchanged;
- an existing managed file may be updated at its canonical path;
- an existing user-owned file remains untouched;
- when policy selects alongside output, Agentify writes the deterministic `*.agentify.*` sibling and records it in the manifest;
- a required conflict under `requiredAction=abort` is discovered before any bundle write and produces zero repository changes;
- a symlink at a destination or in an ancestor path is treated as a conflict and must not permit writes outside the repository;
- manifest file entries remain sorted by path and their hashes correspond to written bytes.

The contract applies to both the brownfield generated bundle and the greenfield milestone-gated artifact tree. It also preserves attach, recovery, abort, and rollback invariants already covered by the complete suite.

## State-directory matrix

State selection is ordered and provider-scoped:

| Selected targets | Provider | Canonical relative directory |
| --- | --- | --- |
| Claude Code, including mixed selections | `claude` | `.claude/agentify` |
| Codex without Claude Code | `codex` | `.agents/agentify` |
| Pi without Claude Code or Codex | `pi` | `.pi/agentify` |
| Only non-premium targets | `universal` | `.agents/agentify` |

When the newly selected directory does not exist but legacy `.pi/agentify` state does, current canonical resolution reads that legacy directory and reports `legacy: true`. An existing provider-selected directory wins when both paths exist. Later changes must preserve the transaction, migration, and rollback rules in `docs/state-lifecycle.md`.

## Narrow volatile-field normalization

Parity comparison may normalize only fields that are intentionally nondeterministic:

- top-level manifest `generated_at` timestamps;
- top-level manifest `run_id` values;
- temporary absolute root paths created by the test process, when a diagnostic embeds them;
- timestamps or random run identifiers in a scenario only when that field is explicitly documented as runtime metadata.

Generated artifact content, path names, marker strings, manifest file ordering, hashes, ownership actions, exit codes, and stdout/stderr channel placement are not volatile and must not be normalized. Credentials, tokens, and real provider responses must never enter parity fixtures.

## Validation floor for modernization issues

Every modernization PR must run:

```bash
npm run typecheck
npm run test:all
npm run test:package
npm run test:parity
```

Run the following when present or relevant to the changed surface:

```bash
npm run test:maintenance
npm run test:generated-output
npm run test:security-redteam
```

When package inventory, build assets, `files`, `bin`, or `exports` may change, also inspect:

```bash
npm pack --json --ignore-scripts
```

No test, validator, schema, coverage gate, security policy, ownership rule, transaction rule, or package restriction may be weakened to satisfy this baseline.
