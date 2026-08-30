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
5. discover validation and dependency-provisioning commands without executing
   them and require a committed lockfile when the ecosystem needs one;
6. screen discovered commands for obvious production credentials and mutation,
   provision locked dependencies and execute required validation in a disposable
   local checkout of the exact committed HEAD. Node provisioning disables
   lifecycle scripts. Post-install validation repeats provisioning and overlays
   only the Agentify-managed output into another disposable checkout. Validation
   still has no OS sandbox or network isolation, and running `agentify` records
   that remaining posture;
7. collect immutable repository evidence from the exact preflight commit and
   seed only deterministically provable identity, language/format, topography,
   verified-validation, build, and documentation facts; dirty working-tree
   bytes are excluded and every semantic claim remains a gap. Positive coverage
   citations must resolve to regular tracked files at that HEAD; generated
   Agentify paths are never repository evidence, and absence is HEAD-relative.
   Same-HEAD continuation maps preserve semantic evidence but refresh placeholder
   identity and empty topography from this immutable snapshot before attachment;
8. initialize persistent identity and self-update policy;
9. run a read-only structured repository audit and persist application-authored
   scout/tracer receipts bound to the exact audited commit;
   the initial scout accepts no parent-authored focus or numeric portfolio
   target, so portfolio size follows repository evidence;
   duplicate broad scouts are refused, while a focused supplemental scout may
   expand the proposal set only for an exact compiler-uncovered behavioral
   cluster omitted by the initial scout;
10. if discovery did not verify a required command, refine validation from the
   audited validation surface and re-verify; when no repository command can be
   verified at all, install the Agentify-owned validation smoke
   (`.github/agentify/validation-smoke.mjs`: tracked-JSON validity, JavaScript
   syntax, committed-secret scan) and record
   the verified smoke command in the task policy;
11. normalize and validate the specialist portfolio, verify normalization is a
    fixed point, then materialize that exact compiled portfolio and its
    procedures from repository evidence;
12. install the issue and learning workflows plus their trusted runtimes;
13. write a repository-bound task policy with the attested manifest, command,
    and lockfile hashes;
14. run deterministic installation canaries;
15. configure required GitHub labels, non-secret variables, and the repository
    Actions permission needed to create unmerged draft pull requests; with
    interactive consent, upload the stored provider credentials (API keys and
    OAuth subscription sign-ins) to the `PI_AUTH_JSON` Actions secret — or copy
    a resolved environment API key to the `PI_API_KEY` secret when no stored
    credential exists — and set a dedicated automation token only after
    interactive consent when the maintainer wants those pull requests to
    trigger ordinary repository workflows and rotated OAuth credentials to be
    written back to `PI_AUTH_JSON`;
16. enable issue intake only when every required check passes.

Policy inspection is deterministic, bounded to tracked regular policy files,
and occurs before memory recovery, runtime repair, diagnostic map creation, or
transaction setup. Policy and resumable-diagnostic files are opened without
following their final symlink, then type-checked and read with a byte cap
through that same descriptor so metadata checks and content reads cannot
resolve different files. Repository text can reduce Agentify's authority but
cannot expand it. A permissive policy or an unrelated warning that merely
mentions AI does not trigger the blocker.

Finalization independently requires a current explorer receipt attestation.
Missing or stale receipts, failed tracers, and accepted concerns without a
successful tracer abort the transaction and remove Agentify-managed persistent
artifacts instead of leaving a partial team.
Typed tracer checkpoints are the only path that may replace an existing concern
body. Incremental map deltas may append a new concern or replay an identical
checkpoint, but reject a changed body with the same semantic identity so repair
cannot bypass scope and monotonicity validation or create duplicate specialists.
When multiple accepted concerns cannot have independent file-level core owners,
repair may record a narrower exact identity as subsumed with `grouped_into`
naming one exact existing broader identity. Deterministic normalization groups
only bodies that share a core implementation file, unions their already-attested
flows, touchpoints, invariants, pitfalls, questions, validation, and scope, and
derives exclusions from the remaining accepted portfolio. Conflicting same-name
flows or unrelated bodies remain unresolved; no model retranscribes evidence.

Tracer receipts retain the exact application-bound concern identity separately
from their free-form focus. A failed or timed-out tracer remains unresolved
until a later successful tracer for that same identity is attested; verbose
repair wording cannot create a separate receipt obligation.
Receipt targets are canonical repository-relative paths even when the parent
supplies an absolute path inside the domain lock; host checkout paths never
enter the persisted attestation.

The installation transaction is captured before recognized runtime repair or
final compilation can persist any managed path or normalized map. The
specialist synchronizer then independently requires that
the canonical map is complete and already recompiles to an idempotent fixed
point before it changes identities, memory, or procedures. Compiler write,
materialization, portfolio-count, structural-canary, and later readiness
failures therefore share the same rollback boundary. Each tracked file must
have exactly one accepted core owner; other specialists may retain it only as a
supporting touchpoint until deterministic ownership is resolved. Test-only core
ownership is refused when the same concern cites tracked implementation
behavior, without rejecting repositories whose product is itself a test suite.
An attached map with recorded concern evidence enters deterministic compilation
before provider reachability or audit-budget admission. Only an absent concern
section is a legacy top-up; a normalizable current-HEAD map can reach its fixed
point without another model call.
After that validation, an auxiliary-only example or fixture candidate is
normalized into a path-backed rejection only when portfolio-distinct semantic
evidence overlaps a concern with independent implementation core. Unrelated
example products remain eligible, and the repaired map is revalidated before
ordinary ownership normalization.
The compiler resolves one narrow shared-file case deterministically: exactly
one concern has no other core implementation path while every adjacent concern
does. That sole-dependent concern keeps core ownership and the other mentions
become supporting. An adjacent path counts as independent only when it is
uniquely core-owned; another concurrently shared path cannot justify a cyclic
pair of resolutions that removes every implementation path from the adjacent
concern. If zero or multiple owners depend exclusively on the shared path, the
compiler preserves the ambiguity as an unresolved obligation.
It also resolves a shared file when one core claimant cites a strict superset
of every competing non-empty concrete symbol set. This is exact symbol evidence,
not a filename or repository heuristic; disjoint, tied, empty, and incomparable
claims remain unresolved.
For a mirrored implementation/test cluster, normalization may promote both
paths to core for one concern only when that concern explicitly cites the
complete pair and every competing concern cites a strict subset. The rule uses
exact tracked evidence rather than repository names or filename semantics;
complete-claim ties and absent claims remain unresolved.

The transaction commits only when the final installation report is `ready`.
Failed required repository validation, unavailable readiness prerequisites,
and structural failures retain their precise blockers but restore the complete
pre-installation snapshot. Fresh attempts keep only permitted diagnostic audit
evidence and remove managed parent directories created by the failed attempt;
an existing installation is restored rather than deleted.
Repository validation residue is confined to disposable system-temporary
checkouts and removed after success, failure, timeout, or validator exception;
it never enters the installation target or its rollback surface.
Build discovery prefers a required behavioral test over build-only candidates.
If the root has no test, it may inspect at most 64 Git-tracked manifest
directories up to four levels deep; root ecosystem order wins equal-ranked
candidates. Nested command working directories, manifests, and locks remain
repository-relative. A fully pinned pip requirements file whose entries carry
SHA-256 hashes is a reproducible lock, and Python test trees without a pytest
contract use `python -m unittest discover`. If a tracked test's bounded local
import graph reaches a network client, broad discovery is not deterministic;
Agentify may instead use the first tracked offline module only when the nested
README explicitly documents the individual-unittest command form.

The structured audit, recovery sessions, semantic repair sessions, and explorer
sub-sessions consume one aggregate budget. Defaults limit the entire audit to 30
minutes, three semantic repair passes, one coverage recovery, 240 model calls and
turns, eight million input/cache tokens, 200,000 output tokens, 24 explorer
dispatches, and USD 20 of provider-reported
cost. Per-scout and per-tracer deadlines are three minutes. Repair state is
measured by a canonical unresolved-obligation fingerprint and terminates after
repeated no-progress states. Strict optional `auditBudgets` config overrides
support unusually large repositories without permitting unbounded values.
Provider and explorer deadlines retain one second of the total wall-time budget
for abort propagation, checkpointing, rollback, and the single terminal audit
event; model work cannot consume the cleanup interval itself.
Semantic-repair parents receive the current unresolved obligations directly and
may only dispatch bounded explorers or apply a concern delta; repository reads
remain confined to those explorers, preventing broad map and tree rereads.
Uncovered JavaScript and TypeScript clusters are ordered by the number of
distinct tracked modules connected through current-HEAD relative dependency
edges, with cluster identity as the stable tie-break. Repair handles central
missing behavior before disconnected leaf utilities unless stronger evidence
shows another obligation blocks it.
Concern-tracer dispatch binds an exact application-owned concern identity. The
typed submission must preserve it verbatim, so a model cannot rename one scout
proposal into an alias that later forces a duplicate specialist. Retracing an
existing concern must also retain at least one prior core path in its submitted
touchpoints or verified flow, plus every prior verified flow name and ordered
step-path sequence. Descriptions may be refined, but established behavioral
structure cannot disappear merely because another concern still covers the
same files. A distinct body requires a new scout proposal.
Portfolio screening distinguishes ordinary shared supporting touchpoints from
an impossible monolithic ownership split. Candidates with the same sole tracked
implementation file and no independent implementation owner are grouped into
the broader behavioral concern before tracing; separate symbols cannot create
multiple file-level core owners. Tracers prefer concern-specific implementation
files as core and retain shared orchestration as supporting evidence.
Catalogs and framework layers that combine unrelated failure domains through a
shared integration API or subtree are rejected before tracing. A traced concern
must core-own its behavior-specific implementation; shared integration files
remain supporting when those implementations exist.
Normalization may promote a supporting implementation file to core without a
model call only when exactly one accepted concern cites it and that concern's
existing core evidence is test-only. Multiple eligible implementation paths or
competing concern citations remain unresolved.
For a multiply core-owned orchestration file, normalization may instead select
one supporting claimant only when it is the sole claimant without another
independent implementation core and every current owner retains one. Examples,
fixtures, and tests do not establish that independent implementation ownership;
tied dependent claimants remain unresolved.
Negative evidence remains authoritative. Direct tracked concern evidence may
still establish an implementation/test attachment under the ordinary exclusion
rule, but inference alone cannot attach a cluster whose behavioral tokens match
an explicit exclusion. Incidental positive mentions cannot erase that boundary;
the cluster remains unresolved until separately traced or substantively rejected.
For JavaScript and TypeScript modules, a current-HEAD relative import, export,
or require edge may attach a mirrored cluster when it reaches exactly one
accepted concern in either direction. The compiler reads bounded immutable Git
blobs rather than the working tree. Multiple reachable concerns and explicit
exclusions remain unresolved and cannot fall through to weaker inference.
Inferred mirrored clusters require substantive evidence: an exact distinctive
behavioral term with tracked path affinity, a file-stem term plus a non-generic
behavioral locality, two semantic matches, or an exact multi-segment behavioral
directory already owned by the concern. Locality suffixes used to distinguish
same-name files are never treated as behavioral words. A single generic word
plus a shared source root cannot establish ownership, and ties remain
unresolved. Locality affinity must match the concern's declared name and scope;
entry questions and supporting roles may route adjacent work but do not
establish positive tracked-file ownership. Repository-relative subtree
exclusions such as `router/*` apply below source roots. An explicitly cited
implementation carries its mirrored test unless the exclusion names that path;
merely citing a test does not override behavioral negative evidence.
Observed public type traces deterministically bind a uniquely resolved tracked
declaration to one specialist only when all traced runtime files have the same
normalized core owner. The declaration becomes a core touchpoint; multiple type
paths or runtime owners remain unresolved.
The application checkpoints cumulative usage in the diagnostic map, bound to
the audited commit. Same-HEAD CLI continuations resume the remaining budget
rather than resetting counters; a new commit begins a new evidence lineage.
Before a parent or explorer session starts, the selected model's complete
context window must fit in the remaining input-token reserve. Provider hooks
also reject later exact serialized requests before network dispatch when their
conservative byte upper bound exceeds that reserve. Post-response accounting
remains authoritative for actual usage, while both admission boundaries prevent
an exhausted continuation from crossing the configured aggregate cap.
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
truncated behavioral trace establish semantic closure. A concern tracer has a
six-read/eight-call envelope, which reserves aggregate capacity for every
candidate in a real portfolio. Its 12,000-token response ceiling accommodates
configured reasoning; the 16 KB parsed report limit remains authoritative.
The application parses scout proposal identities into the receipt ledger. Every
proposal remains an obligation until a related tracer succeeds or normalized
concern evidence records a substantive rejection. Receipt state is checkpointed
after each explorer and retains its source run ID; same-HEAD retries resume that
attested evidence. Each tracer must call an application-owned typed submission
tool with one bounded concern body. The application validates it against the
concern schema, binds its freshness to the exact HEAD commit timestamp, and
checkpoints it before receipt attestation;
the builder records scout screening but does not retranscribe tracer evidence.
Only provider-generated assistant messages consume the
aggregate call and turn counters; local tool-result delivery does not.
Before a tool-use continuation, the same boundary reserves enough aggregate
input capacity for another request at the just-observed input/cache size.
The compiler and receipt gate both refuse `not_concerns` explanations that
explicitly accept the named candidate. Normalization removes such an append-only
entry only when it semantically matches an accepted concern. Exact tracked paths
embedded in a descriptive rejection label exempt only those paths, with path
boundaries preventing substring matches. A rejection that explicitly says
behavior is subsumed elsewhere must also bind its named disposition to a real
accepted concern; merely discussing an accepted concern does not delegate
ownership, and a nonexistent delegated owner remains an unresolved
obligation. When `grouped_into` is present, that exact structured identity is
authoritative; semantic parsing of explanatory prose is only a legacy fallback.
Parent sessions are terminated by an
application-owned timer at the configured session deadline. SIGINT and SIGTERM
run the same synchronous pending-installation rollback before process exit, so
only the permitted diagnostic map can survive an interrupted fresh install.
On re-entry, installation preparation captures the transaction first, then
temporarily lifts only the exact non-symlink diagnostic-map topology whose
application receipt ledger matches current HEAD. Memory initialization occurs
against an empty root and the exact map bytes are restored inside the same
transaction. Any extra path, stale commit, or missing attestation remains
unrecognized user state and fails closed.
If a bounded continuation fails, rollback retains the newest map from that
transaction rather than restoring its older diagnostic snapshot. A successful
tracer receipt without a matching persisted concern body remains an explicit
retrace obligation. Before an existing-concern tracer submission is
checkpointed, the application compares its candidate map with the current
tracked assessment and rejects any replacement that makes a previously covered
or substantively exempted path newly unresolved. Aggregate provider turns are counted from assistant
provider responses, not user or tool-result transport messages. Concern deltas
default to recursive append with structural deduplication; an explicit merge
strategy remains available for an intentional repair.
Before either a full map or delta is assessed, the write boundary removes
Agentify-managed paths from skeleton topography, entry/read-first lists,
agentic-layer bleed paths, and repository process identities. The tool reports
every removed path, preventing in-transaction installation state from becoming
repository evidence.
Before creating a scout model session, the explorer tool checks the canonical
application receipt ledger. A successful scout bound to current HEAD makes
subsequent scout dispatches a deterministic error; stale and failed receipts
remain retriable.
Legacy diagnostic-only maps affected by the former scout-line parser are
repairable only by normalizing `proposed_concerns`. Re-entry still requires the
entire repaired map to satisfy the current schema and carry a nonempty receipt
ledger bound to exact current HEAD; no other invalid field is repaired.

The trusted controller launches validation with fixed argv vectors and no direct
shell option, although npm scripts may invoke shells and indirect programs.
Common credential variables are removed from validation child environments.
Visible deployment, publication, cloud mutation, or infrastructure mutation is
rejected as a guardrail. Installer validation receives filesystem isolation
through a disposable exact-HEAD checkout, but this is not an OS or network
isolation guarantee. The installed issue
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
