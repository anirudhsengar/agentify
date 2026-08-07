# Architecture

Agentify has three executable roots:

| Bundle | Source root | Responsibility |
| --- | --- | --- |
| `dist/cli.js` | `src/cli.ts` | local installation, provider configuration, audit, and canaries |
| `dist/task-runtime.mjs` | `src/core/task-lifecycle/cli.ts` | authorized GitHub issue execution |
| `dist/learning-runtime.mjs` | `src/core/learning/cli.ts` | accepted-merge knowledge maintenance |

The npm package exposes the `agentify` executable only. Installed workflows call
the two internal runtime bundles through trusted scaffold scripts.

## Installation flow

The local CLI verifies the repository root, Git history, canonical GitHub
identity, maintainer permission, default-branch policy, deterministic validation,
provider credentials, and model selection. It initializes `.agentify`, performs
a read-only structured audit, installs the scaffold, builds a repository-bound
task policy, runs installation canaries, and configures GitHub labels and
variables.

The installer preserves unmanaged files. Conflicting generated content is written
alongside the occupied path and reported for explicit resolution.

## Runtime layers

- `audit/` maps repository structure and enforces read-only model execution.
- `installer/` owns preflight, repository policy, scaffold installation, and
  canaries.
- `memory/` owns durable identity, provenance, manifests, immutable events,
  transactions, and crash recovery.
- `specialists/` derives evidence-backed read-only specialists and procedures.
- `task-lifecycle/` owns issue authorization, planning, isolated building,
  trusted validation, role-separated automated review, bounded recovery, and draft
  publication.
- `learning/` assesses exact accepted commits, invalidates stale knowledge,
  reconciles missed events, and performs confined knowledge updates.

Memory and specialists do not depend on learning. Task execution consumes both
through explicit contracts. The installed task and learning runtimes are bundled
independently so workflow execution does not depend on raw TypeScript source.

## Authority model

The orchestrator plans but cannot edit application source. A read-only planner
refines implementation steps before each plan is recorded, keyed off a
reproducible draft-plan digest so retries never duplicate the model call.
Specialists provide read-only evidence. One builder receives path-bounded
write tools on an isolated branch, working within a bounded turn budget before
its terminal typed submission. Validation runs in trusted process code, not
through the model. The reviewer is role-separated from the builder and
read-only. The knowledge maintainer may write only validated Agentify
knowledge paths.

GitHub mutation is outside model processes. Trusted scaffold scripts validate
typed runtime output and repository identity before performing bounded labels,
comments, branch updates, or draft pull-request publication.

## State

Repository state has one root: `.agentify`. The audit map lives at
`.agentify/runtime/audit/codebase_map.json` and is versioned so installed
workflows retain the validated specialist-routing source. Versioned identity,
policies, knowledge, and history are also tracked; audit history, other
operational runtime files, and transaction files are ignored. See
[State lifecycle](state-lifecycle.md).

## Contract enforcement

Maintenance tests enforce module direction, schema ownership, production
reachability, current terminology, documentation links, package exports, runtime
asset inventory, and release workflow safety. Exact-artifact tests install the
generated tarball into isolated fixtures and exercise the public CLI and installed
workflows.

## Scope discipline

Agentify supports one product path: install into an existing GitHub repository,
accept authorized issues, and stop application work at an unmerged draft pull
request. New public surfaces require an installed-runtime need, deterministic
qualification, and a clear authority boundary; otherwise they remain outside
the product.
