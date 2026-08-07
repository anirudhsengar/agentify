# Install-once repository engineering team

Status: production product contract

## Product thesis

Agentify installs a persistent, repository-specific engineering team into an
existing GitHub repository. The local CLI performs installation and verification
once; authorized GitHub issues become the normal work interface.

The team is persistent because its identity, specialist portfolio, procedures,
task episodes, repository facts, policies, and learning records are versioned in
the repository. Persistence never expands model authority.

## Supported operation

Installation requires a repository with Git history, a canonical GitHub remote,
an authorized maintainer, deterministic validation commands, a supported model,
and an explicit protected-path policy. The installer may analyze a repository
that is not ready for autonomous task execution, but it reports blockers and
keeps issue intake disabled.

A ready installation provides:

- one persistent orchestrator;
- one read-only planner that refines implementation steps before a plan is
  recorded;
- a bounded portfolio of evidence-backed read-only specialists;
- one writable builder per active task;
- one role-separated automated read-only reviewer;
- one path-restricted knowledge maintainer;
- trusted validation, recovery, and GitHub publication code;
- automatic knowledge refresh after accepted merges.

Deployment and application merge are outside Agentify authority.

## One authoritative state model

Repository state lives under `.agentify`. The memory manifest identifies the
canonical repository and hashes every managed durable record. Audit runtime data
lives under `.agentify/runtime/audit`; transaction journals live under
`.agentify/state-transactions`.

Initialization fails closed when `.agentify` contains unrecognized state.
Managed files are repaired only when their ownership markers and expected bytes
can be verified. User-owned files are preserved.

## Installation contract

The local installer performs these steps in order:

1. resolve the physical repository root and verify Git history;
2. resolve the canonical GitHub repository and authenticated actor;
3. verify maintainer permission and default-branch policy;
4. discover validation commands without executing them and require a committed
   npm lockfile when validation has package dependencies;
5. display the commands and require explicit maintainer approval of unsandboxed
   repository validation before executing them;
6. initialize persistent identity and self-update policy;
7. run a read-only structured repository audit;
8. derive and persist specialists and procedures from repository evidence;
9. install the issue and learning workflows plus their trusted runtimes;
10. write a repository-bound task policy with the approved manifest, command,
    and lockfile hashes;
11. run deterministic installation canaries;
12. configure required GitHub labels, non-secret variables, and the repository
    Actions permission needed to create unmerged draft pull requests, plus an
    explicitly consented dedicated automation token when the maintainer wants
    those pull requests to trigger ordinary repository workflows;
13. enable issue intake only when every required check passes.

The trusted controller launches validation with fixed argv vectors and no direct
shell option, although npm scripts may invoke shells and indirect programs.
Common credential variables are removed from validation child environments.
Visible deployment, publication, cloud mutation, or infrastructure mutation is
rejected as a guardrail, not as an isolation guarantee. The installed issue
workflow pins the supported npm runtime and
restores lockfile-pinned npm dependencies with lifecycle scripts disabled before
approved validation. A dependency-bearing repository without `package-lock.json`
or `npm-shrinkwrap.json` remains analyzable-only because a fresh GitHub checkout
cannot reproduce the locally verified validation environment.

Task-policy schema 2 records the maintainer attestation and hashes. Schema-1 or
drifted policies remain readable but cannot enable issue intake until the local
interactive installer records renewed approval.

## Issue execution contract

An issue becomes executable only when it is open, explicitly queued, authored or
approved by an authorized actor, bound to the current default-branch commit, and
contains testable acceptance criteria.

The orchestrator builds a typed plan from repository evidence, specialists,
procedures, active policy, and relevant memory, refined by a read-only planner
that decomposes ambiguous or compound acceptance criteria into concrete steps
before the plan is recorded. The plan declares candidate paths, excluded paths,
implementation steps, validation commands, risk, budget, and selected
specialists.

Exactly one builder receives application-source write authority. Its tools are
confined to the approved repository paths and isolated branch: within a
bounded turn budget it may inspect, edit, and self-check before its terminal
typed submission. It does not receive GitHub write credentials. Trusted code
applies nothing until that submission, then captures the resulting diff and
runs the authoritative validation outside the model process.

The reviewer receives the plan, diff, validation evidence, and acceptance
criteria but no application-source write tools. Corrections are bounded by the
same authority and retry budget. Successful work is published as an unmerged
draft pull request. A human decides whether to merge.

## Learning contract

Learning begins only from the exact accepted default-branch commit, its first
parent, the canonical repository identity, and the expected branch head. The
accepted diff—not a task description or earlier branch head—is the code evidence.

The learning runtime may:

- add or refresh repository facts, procedures, task episodes, and specialist
  routing knowledge;
- invalidate records whose dependent paths changed;
- reconcile missed accepted-merge events;
- update the bounded specialist portfolio;
- publish a knowledge-only change when every changed path is allowlisted.

It may not change application source, dependencies, workflows, permissions,
runtime code, operational state, or protected policy. Every record carries
provenance, supporting commit, confidence, freshness, content hashes, and an
attributable learning event.

## Execution-policy contract

Every model-backed session declares:

- allowed tools;
- readable and writable roots;
- protected paths;
- command posture;
- network isolation: not provided;
- deadline and inactivity timeout;
- output and context limits;
- retry limit;
- cost budget.

Audit and specialist sessions receive read-only filesystem tools and trusted
structured map tools. Prompts supplement these controls but never replace them.

## Completion criteria

An installation is ready only when repository identity, provider and model,
memory ownership, specialist synchronization, workflows, bundled runtimes, task
policy, and lifecycle canaries all pass. A task is complete only when trusted
validation passes, role-separated automated review accepts the bounded diff, a draft pull
request is published, and the default branch remains untouched pending human
merge.
