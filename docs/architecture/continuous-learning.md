# Continuous learning

Agentify learns from accepted code by updating versioned external memory. It does
not train model weights and cannot modify application source.

## Trigger and identity

The installed `agentify-learn.yml` workflow runs after an accepted merge. Trusted
code verifies:

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

Reconciliation scans accepted default-branch commits and idempotently processes
events missing from Agentify history. Each learning run records its accepted
commit, evidence, candidate decisions, mutations, and final manifest digest.

## Publication boundary

The knowledge maintainer can publish changes only when every changed path is in
the self-update allowlist and every record and manifest validates. Path checks
include normalized repository confinement, symlink confinement, size limits, and
real-byte hashes.

Allowed content is limited to versioned identity, knowledge, history, specialist
records, the memory manifest, and canonical ignore rules. Application source,
dependencies, workflows, permissions, runtime code, operational state, and
protected policies are immutable to learning.

Knowledge-only changes are reviewable repository changes. They cannot expand
tools, permissions, write roots, network access, or merge authority.
