# Supported and experimental surfaces

Agentify 0.1.x intentionally has one supported public runtime surface: the
installed `agentify` command.

Everything else in this repository is classified explicitly below so users and
contributors do not infer a stable library API from source layout, test coverage,
or internal composition roots.

The evidence-based lifecycle decision for every experimental subsystem is recorded
in `docs/architecture/experimental-runtime-decisions.md`. That record retains
webhook, AIW, orchestrator, and Agent Expert in place and approves a separate,
behavior-preserving relocation of communications beneath the orchestrator boundary
through Issue #48. Until that implementation merges, the source table below remains
the current physical layout.

## Supported public surface

The supported public surface consists of:

- the `agentify` executable declared by the package `bin` field;
- the top-level `--help`, `--version`, `--mode`, and `--targets` options;
- the `login`, `logout`, `models`, and `revert` utility subcommands shown in
  `agentify --help`;
- brownfield bootstrap, attach, recovery, deterministic artifact generation, and
  greenfield formation initiated through that executable;
- documented configuration files and generated artifacts referenced by the root
  README.

Compatibility for these surfaces is still pre-1.0, but changes must be documented,
tested through the installed package, and evaluated as user-facing behavior.

## Internal experimental surfaces

The following source areas are internal experimental implementation details:

| Area | Source | Current purpose |
| --- | --- | --- |
| Webhook server and worker | `src/core/webhook/` | Signed HTTP intake and queued task dispatch |
| AIW runtime | `src/core/aiw/` | Plan/build/review/fix workflow execution |
| Orchestrator | `src/core/orchestrator/` | Multi-agent delegation and domain locks |
| Communications runtime | `src/core/coms/` | Internal agent communication registry and server |
| Agent Expert runtime | `src/core/agent-expert.ts` and related modules | Expert evidence and outcomes |

The pure `src/core/orchestrator/workflow-spec.ts` contract and declarative
`src/core/orchestrator/workflows/` JSON assets are classified as neutral shared
infrastructure. They support deterministic artifact rendering but do not expose
the orchestrator runtime, host, worker, tools, or state machine.

These modules:

- are not CLI subcommands;
- are not package exports;
- have no semantic-version compatibility commitment;
- may change, move, or be removed without a deprecation period;
- must not be imported through package-internal paths such as
  `agentify/src/core/webhook/index.ts`;
- may be exercised by repository tests without being production-supported APIs.

Security hardening of an experimental subsystem reduces repository risk; it does
not by itself graduate that subsystem into a supported product surface.

## Why the code remains in the repository

The experimental runtimes are retained because they support internal development,
validate future architecture, and are used by contract and security tests. Moving
or deleting them during the security remediation would combine product-boundary
work with broad file-path churn and make review less reliable.

The restrictive npm `exports` map, documentation, CLI parser, and
product-boundary tests enforce this boundary. The maintenance boundary scanner
also resolves static imports, type-only imports, re-exports, and dynamic imports
from the supported CLI entry point; it rejects experimental reachability and
reverse dependencies from explicitly neutral modules. Standard package imports into raw
source paths are rejected. The compiled-artifact packaging phase will additionally
remove raw TypeScript source from the published tarball.

## Graduation requirements

An experimental area may become supported only through a dedicated design and
release decision that includes all of the following:

1. an explicit package export or documented CLI command;
2. a stable typed API or command contract;
3. an operator guide with startup, shutdown, persistence, and recovery behavior;
4. a threat model and capability policy;
5. end-to-end integration and installed-package tests;
6. observability, failure, cancellation, and resource-limit behavior;
7. a compatibility and deprecation policy;
8. release notes identifying the new supported surface.

Source comments or README examples cannot graduate a subsystem implicitly.

## Contribution rules

Composition roots are enumerated in the machine-enforced experimental
classification. The webhook and AIW index roots also retain their existing
`@experimental` source markers. These designations are documentation, not an
authority grant.

Changes to internal experimental modules must:

- retain the `@experimental` designation on composition roots;
- avoid adding public CLI routes or package exports incidentally;
- include security tests when trust boundaries change;
- update this document when scope or graduation status changes;
- keep the lifecycle decision record accurate when new evidence changes a decision.

A proposal to expose one of these modules publicly should be reviewed separately
from ordinary implementation work.
