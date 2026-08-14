# Continuous learning

Agentify learns from accepted code by updating versioned external memory. It does
not train model weights and cannot modify application source.

## Trigger and identity

The installed `agentify-learn.yml` workflow runs after an accepted merge and on
its daily reconciliation schedule. Trusted code verifies:

- the canonical repository ID;
- the default branch;
- the exact accepted commit;
- the commit's first parent;
- the expected default-branch head;
- the triggering actor and event evidence.

An issue description, review branch, or earlier pull-request head is not accepted
code evidence.

## Assessment

The learning runtime computes the accepted diff, changed paths, relevant
specialists, validation evidence, and affected memory. It can produce typed
candidates for repository facts, procedures, task episodes, relationships,
routing signals, and specialist updates.

Failed approaches and reviewer corrections may be recorded as bounded task
episodes. Later planning retrieves only relevant, fresh episodes so a verified
correction can influence a similar task without becoming global policy.

## Invalidation and reconciliation

Memory records declare dependent paths and invalidation conditions. Accepted
changes deterministically mark affected records stale before new candidates are
accepted. Deleted paths, changed evidence bytes, contradicted facts, and retired
specialist domains are handled explicitly.

Reconciliation scans a bounded recent first-parent window after Agentify was
installed and idempotently processes events missing from Agentify history. The
installation boundary prevents the first scheduled run from backfilling the
repository's pre-Agentify history. Installed Agentify paths are removed from the
learning input before evidence, invalidation, candidate generation, and file
limits are evaluated. Agentify-only installation and upgrade commits are
deterministic no-ops; a mixed commit learns only its application-owned paths.

Scheduled reconciliation processes at most four missing application commits per
proposal, oldest first within the recent window. Each learning run records its
accepted commit, evidence, candidate decisions, mutations, and final manifest
digest. Per-file change facts remain available in the accepted Git diff; durable
records retain a bounded representative evidence set so the same evidence is not
copied into thousands of review lines.

## Publication boundary

The knowledge maintainer can publish changes only when every changed path is in
the self-update allowlist and every record and manifest validates. Path checks
include normalized repository confinement, symlink confinement, size limits, and
real-byte hashes. A proposal is also rejected when it exceeds 64 changed paths,
512 KiB of Git patch payload, or 5,000 added-plus-deleted lines.

Allowed content is limited to versioned identity, knowledge, history, specialist
records, the memory manifest, and canonical ignore rules. Application source,
dependencies, workflows, permissions, runtime code, operational state, and
protected policies are immutable to learning.

Knowledge-only changes are reviewable repository changes. They cannot expand
tools, permissions, write roots, network access, or merge authority.

The maintenance branch contains one repository-bound proposal commit with its
version and exact default-branch parent recorded in commit trailers. A fresh
workflow checkout may resume an open proposal only after verifying the GitHub PR
head, same-repository ownership, commit shape, first-parent ancestry, trailers,
allowlisted path and file modes, publication limits, manifest bytes, and memory
store integrity. Reconciliation always runs after adoption: recorded commits are
skipped, any remaining bounded backlog is processed, and an unchanged proposal
tree is reused without a new commit, push, or PR edit. When the default branch
advances, its validated knowledge is carried forward before new accepted commits
are processed. Publication leases against the branch SHA captured during
preflight, so a concurrent branch change fails instead of being overwritten.
