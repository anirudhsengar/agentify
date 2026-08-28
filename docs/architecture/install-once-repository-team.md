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
3. inspect bounded tracked agent and contribution policy files and stop before
   any repository mutation when they explicitly prohibit AI/LLM-authored
   persistent work;
4. verify maintainer permission and default-branch policy;
5. discover validation commands without executing them and require a committed
   npm lockfile when validation has package dependencies;
6. screen discovered commands for obvious production credentials and mutation,
   then execute passing required validation without an OS sandbox or network
   isolation; running `agentify` in the target repository is the attestation
   that records maintainer-approved unsandboxed validation;
7. initialize persistent identity and self-update policy;
8. run a read-only structured repository audit and persist application-authored
   scout/tracer receipts bound to the exact audited commit;
9. if discovery did not verify a required command, refine validation from the
   audited validation surface and re-verify; when no repository command can be
   verified at all, install the Agentify-owned validation smoke
   (`.github/agentify/validation-smoke.mjs`: tracked-JSON validity, JavaScript
   syntax, committed-secret scan) and record
   the verified smoke command in the task policy;
10. normalize and validate the specialist portfolio, verify normalization is a
    fixed point, then materialize that exact compiled portfolio and its
    procedures from repository evidence;
11. install the issue and learning workflows plus their trusted runtimes;
12. write a repository-bound task policy with the attested manifest, command,
    and lockfile hashes;
13. run deterministic installation canaries;
14. configure required GitHub labels, non-secret variables, and the repository
    Actions permission needed to create unmerged draft pull requests; with
    interactive consent, upload the stored provider credentials (API keys and
    OAuth subscription sign-ins) to the `PI_AUTH_JSON` Actions secret — or copy
    a resolved environment API key to the `PI_API_KEY` secret when no stored
    credential exists — and set a dedicated automation token only after
    interactive consent when the maintainer wants those pull requests to
    trigger ordinary repository workflows and rotated OAuth credentials to be
    written back to `PI_AUTH_JSON`;
15. enable issue intake only when every required check passes.

Policy inspection is deterministic, bounded to tracked regular policy files,
and occurs before memory recovery, runtime repair, diagnostic map creation, or
transaction setup. Repository text can reduce Agentify's authority but cannot
expand it. A permissive policy or an unrelated warning that merely mentions AI
does not trigger the blocker.

Finalization independently requires a current explorer receipt attestation.
Missing or stale receipts, failed tracers, and accepted concerns without a
successful tracer abort the transaction and remove Agentify-managed persistent
artifacts instead of leaving a partial team.

The installation transaction is captured before final compilation can persist
a normalized map. The specialist synchronizer then independently requires that
the canonical map is complete and already recompiles to an idempotent fixed
point before it changes identities, memory, or procedures. Compiler write,
materialization, portfolio-count, structural-canary, and later readiness
failures therefore share the same rollback boundary.

The structured audit, recovery sessions, semantic repair sessions, and explorer
sub-sessions consume one aggregate budget. Defaults limit the entire audit to 30
minutes, three semantic repair passes, one coverage recovery, 96 model calls and
turns, bounded tokens and explorer dispatches, and USD 20 of provider-reported
cost. Per-scout and per-tracer deadlines are three minutes. Repair state is
measured by a canonical unresolved-obligation fingerprint and terminates after
repeated no-progress states. Strict optional `auditBudgets` config overrides
support unusually large repositories without permitting unbounded values.
Explorer sessions run one at a time so completed usage is reconciled before the
next dispatch. Mode-specific repository-read and provider-call quotas are hard
runtime limits and the call quota is reduced to the aggregate calls remaining.
Agentify retains a final report completed at the exact limit, but aborts an
explorer that requests continuation there. Aggregate exhaustion reports the
unresolved coverage, specialist-compiler, and receipt obligations with a
deterministic fingerprint.
Model tool arguments can narrow but cannot raise trusted per-mode quotas.
Explorer calls, turns, tokens, and provider cost are reconciled live after each
response. Reports over 16 KB fail the explorer receipt instead of letting a
truncated behavioral trace establish semantic closure.

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

Task-policy schema 2 records the installer attestation and hashes. Schema-1 or
drifted policies remain readable but cannot enable issue intake until `agentify`
is rerun against the current manifest, command set, and lockfile.

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
