# Repository specialists

Repository specialists are persistent, deterministic, evidence-backed, and
read-only. They improve planning and review without creating additional writers.

## Discovery

A specialist owns one **concern**: a specialty a maintainer would recognize as
their own body of knowledge. Authentication, checkout, schema migration, test
selection — whatever the repository actually has. A concern is not a directory.
It runs through the codebase, and concerns routinely share files: authentication
and checkout both touch the request middleware, for entirely different reasons.
Two concerns overlapping is evidence that both are real, never a signal to merge
them.

The audit finds concerns in a dedicated stage. `concern_scout` sweeps the whole
repository once and proposes candidates with seed paths, recording the
candidates it rejected and why. One `concern_tracer` then follows each candidate
end to end, returning its flows, its touchpoints with a per-file role, its
invariants, its pitfalls, and the questions a task must answer before touching
it. Both explorers receive the repository's untracked roots up front, so an
audit never spends its budget on code that is fetched, generated, or vendored at
build time and could not be bound to evidence anyway.

The audit cannot complete before it records that result in
`concern_evidence.concerns`. An honest empty list stays valid for a repository
too small to have distinct specialties, and must be justified in
`open_questions` and `not_concerns`.

Explorer completion is not inferred from the map. Trusted runtime code records
an application-authored receipt for the repository-wide scout and every
successful or failed concern tracer, then binds the ledger to the exact audited
Git commit. Model-authored full-map and delta writes cannot create or replace
this attestation. A missing ledger, a failed tracer, an untraced accepted
concern, or a ledger from another commit keeps semantic closure unresolved.
Receiptless legacy maps are re-audited rather than attached as trusted output.

Specialist discovery does not re-decide any of this. The model reads the
repository and names its concerns; trusted code verifies that what it named
resolves to real bytes tracked at the supporting commit. Touchpoints that are
not tracked files are dropped, a flow reduced below two steps stops being a
trace and is discarded, and a concern with nothing left is rejected with a
warning naming the concern and the reason. Maps written against the superseded
`expert_evidence.expert_domains` shape still install, migrated with capped
confidence and a warning that a re-audit would produce a better specialist.

Every specialist definition includes:

- a stable specialist ID and concern name;
- what it covers and what it deliberately excludes;
- traced flows through the concern, entry point to effect;
- touchpoints with a symbol, a role, and a centrality;
- invariants, pitfalls, and entry questions;
- procedures and validation commands;
- related specialists, derived from shared touchpoints;
- freshness dependencies, supporting commit, and evidence digest.

There are no owned paths. `context_paths` is a derived read scope for bounding
one consultation session, not a territory claim, and several specialists
matching the same file is the expected outcome.

Evidence references bind repository-relative paths to real-byte hashes at a
specific commit. Missing, unsafe, or unverifiable evidence is rejected.

Procedures are emitted only from tracked custom commands and the authoritative
concern or repository validation surface. Free-form skill candidates and
per-area template hints remain audit observations, not executable portfolio
inputs.

The canonical map and its commit-bound explorer receipt ledger are committed
with the installation while audit history stays ignored. This preserves one
routing source across the local installer, issue workflows, and accepted-merge
learning without making transient model sessions authoritative state.

## Persistence

Trusted code materializes specialists under `.agentify/agents/specialists` and
procedures under `.agentify/knowledge/procedures`. The memory manifest hashes each
record. Synchronization is deterministic and reports created, updated, unchanged,
and retired IDs.

The canonical roles—builder, reviewer, and knowledge maintainer—are separate from
repository specialists. Specialists never receive application-source write
authority.

## Routing

Routing follows meaning. A task is matched to a specialist because it is about
that specialist's concern; the files it happens to touch corroborate the match
rather than deciding it. Naming the concern is the strongest signal, a core
touchpoint the next, and a merely known path weaker still. Risk raises the
weight of whatever concerns the repository recorded — it never contributes a
fixed vocabulary of its own, so a repository whose real stakes are platform
exclusion rules is served as well as one whose stakes are payments.

Each selected specialist runs with a system prompt generated from its own
record: its concern, its scope boundary, its core code, its traced flows, its
invariants, and its entry questions. It is the authentication specialist, not a
general advisor holding a file list. The builder and reviewer receive only the
specialist context relevant to their bounded task.

## Refresh

Accepted-merge learning checks each specialist's freshness dependencies. Changed
paths invalidate affected knowledge and trigger deterministic portfolio
reconciliation. Updates remain confined to Agentify knowledge paths and retain
supporting-commit provenance.
