# Repository specialists

Repository specialists are persistent, deterministic, evidence-backed, and
read-only. They improve planning and review without creating additional writers.

## Discovery

Specialists are derived from the canonical structured audit map at
`.agentify/runtime/audit/codebase_map.json`. Candidate domains are scored from
explicit expert evidence or, when that evidence is absent, one cohesive
structural fallback backed by module boundaries, contracts, risk signals,
tracked files, and validation commands. Speculative feature-agent names and
suggested domain hints do not create specialists. Discovery is bounded so the
portfolio remains small and reviewable.

Procedures are emitted only from tracked custom commands and the authoritative
domain or repository validation surface. Free-form skill candidates and
per-area template hints remain audit observations, not executable portfolio
inputs.

The canonical map is committed with the installation while audit history stays
ignored. This preserves one routing source across the local installer, issue
workflows, and accepted-merge learning without making transient model sessions
authoritative state.

Every specialist definition includes:

- a stable specialist ID and domain;
- owned and evidence paths;
- relevant symbols and contracts;
- procedures and validation commands;
- routing terms and risk signals;
- freshness dependencies;
- supporting commit and evidence digest.

Evidence references bind repository-relative paths to real-byte hashes at a
specific commit. Missing, unsafe, or unverifiable evidence is rejected.

## Persistence

Trusted code materializes specialists under `.agentify/agents/specialists` and
procedures under `.agentify/knowledge/procedures`. The memory manifest hashes each
record. Synchronization is deterministic and reports created, updated, unchanged,
and retired IDs.

The canonical roles—builder, reviewer, and knowledge maintainer—are separate from
repository specialists. Specialists never receive application-source write
authority.

## Routing

Task planning routes issues using requested paths, acceptance criteria, risk
terms, contracts, procedures, and specialist ownership. Selected specialists
contribute compact evidence and instructions to the orchestrator. The builder and
reviewer receive only the specialist context relevant to their bounded task.

## Refresh

Accepted-merge learning checks each specialist's freshness dependencies. Changed
paths invalidate affected knowledge and trigger deterministic portfolio
reconciliation. Updates remain confined to Agentify knowledge paths and retain
supporting-commit provenance.
