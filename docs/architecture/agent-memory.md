# Agent memory

Agentify memory is versioned repository data, not model-weight training. It
provides durable identity, repository knowledge, procedures, task episodes,
policies, specialist definitions, and attributable learning events.

## Layout

```text
.agentify/
  manifest.json
  agents/
  knowledge/
  history/
  policies/
  runtime/
  state-transactions/
```

Versioned records and the manifest are durable. The validated canonical audit
map is the only versioned runtime file because installed workflows require it
for deterministic specialist routing. Audit history, other runtime files, and
transaction journals are operational and ignored by Git.

## Record contract

Every memory record has:

- a stable ID and kind;
- owning and proposing agent identities;
- a supporting Git commit;
- evidence references with real-byte hashes;
- confidence and freshness;
- dependent paths and invalidation conditions;
- creation and update timestamps;
- semantic and content digests;
- optional human attribution;
- a typed payload.

Candidate records are proposed through strict schemas and accepted by trusted
application code. Free-form model output is never persisted directly.

## Ownership and initialization

The root manifest uses the `agentify_team_memory` format and binds memory to the
canonical repository ID. Initialization succeeds only when `.agentify` is absent,
empty, or contains a recognized in-progress initialization journal. Any
unrecognized content blocks initialization without modifying bytes.

All managed files are confined lexically and by symlink checks. The manifest
stores hashes of real bytes. Immutable events cannot be replaced with different
content.

## Transactions and recovery

Multi-file mutations use deterministic journals under
`.agentify/state-transactions`. A transaction records its expected inputs,
operations, hashes, and progress. Writes use exclusive temporary files, fsync,
and atomic installation where supported.

Recovery validates the journal and current bytes before completing or repairing
a transaction. Ambiguous ownership, unexpected bytes, invalid paths, oversized
records, or unsafe symlinks fail closed.

## Queries and compaction

Runtime context is selected by role, path relevance, freshness, confidence,
specialist ownership, and budget. Stale records remain attributable but are
excluded from default active guidance. Compaction is deterministic and preserves
provenance, contradictions, accepted candidate IDs, and content hashes.

## Self-update boundary

The knowledge maintainer may update only the explicit allowlist:

- `.agentify/agents`;
- `.agentify/knowledge`;
- `.agentify/history`;
- the memory manifest;
- canonical ignore rules.

It cannot update `.agentify/policies`, `.agentify/runtime`, transaction journals,
application source, dependencies, workflows, permissions, or executable runtime
code. Trusted code validates every changed path and resulting manifest before a
knowledge-only publication.
