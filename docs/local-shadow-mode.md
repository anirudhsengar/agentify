# Agentify local shadow mode

Local shadow mode is the supported local equivalent of the GitHub-hosted
shadow workflow introduced in Milestone 6A. It exists because GitHub
Actions may not be available in every pilot environment (for example,
the Pilot Wave 1 environment used to develop this milestone). Local
shadow mode is **deliberately separate** from GitHub-hosted shadow mode
and carries a different trust model.

## Trust model

Local shadow evidence is **operator-attested local execution**. It is:

- **appropriate for** controlled internal pilot evidence
- **not equivalent to** GitHub-hosted runtime attestation
- **not** an automatic package release gate
- **not** customer proof
- **not** implementation success
- unable to prove that an issue was fixed

Local shadow evidence uses a distinct evidence origin
(`live_local_shadow`) and distinct classifications
(`valid_live_local_shadow_evidence`,
`incomplete_live_local_shadow_evidence`,
`invalid_live_local_shadow_evidence`). It never reuses the GitHub
`live_shadow` provenance path: that path still requires a
GitHub Actions runtime and a workflow run id.

## Comparison to GitHub-hosted shadow

| Property | GitHub shadow | Local shadow |
| --- | --- | --- |
| Evidence origin | `live_shadow` | `live_local_shadow` |
| Runtime identity | GitHub Actions environment | Operator + local run id |
| Requires `GITHUB_ACTIONS=true` | yes | no |
| Requires a GitHub token | no (read-only `gh` API is allowed but not required) | no |
| Reads issue data from | `GITHUB_EVENT_PATH` | `gh issue view` |
| Cost status | measured 0 (no model calls) | measured 0 (no model calls) |
| Comment on issue | optional via config | never |
| Runs in sandbox | GitHub-hosted runner | operator's machine |

## Private pilot workspace

Local shadow evidence is written to a private workspace beneath the
pilot root:

```
<pilot-root>/
└── workspaces/
    └── <repository-slug>/
        ├── managed-state/    # local metrics stream (re-used across runs)
        ├── shadow/
        │   └── <local-run-id>/
        │       ├── evidence-packet.json
        │       └── summary.md
        ├── locks/
        │   └── <repo>__<engagement>__<issue>.lock
        └── clone/            # detached clone pinned to source commit
```

The source checkout at the operator's normal working copy is never
modified. The local runner:

1. resolves the exact source commit with `git rev-parse HEAD`,
2. cross-checks the origin against the requested repository,
3. creates (or reuses) a private detached clone without a remote,
4. writes evidence only inside the private workspace,
5. verifies that HEAD, branch, refs, and the file inventory outside
   the managed state root are unchanged at the end of the run.

## Concurrency

A single-file lock beneath `<pilot-root>/workspaces/<repo-slug>/locks/`
serializes concurrent runs against the same repository / engagement /
issue tuple. A second concurrent run fails with an actionable error
that names the holding pid and start timestamp. Stale locks are
inspected (and only removed when their owning pid is no longer alive)
by `agentify engage shadow status-local --yes`.

## Redaction

Local evidence packets apply the same redaction rules as the GitHub
runner. GitHub PATs, OAuth tokens, generic API keys, and PEM-encoded
private keys are replaced with `[REDACTED]`. Issue bodies are also
truncated to 8,000 characters. API keys and tokens are never loaded
into the process and never persisted.

## Metrics

Local shadow runs record `run_started` and `run_completed` metric
events with the same shape as GitHub-hosted runs. The measured cost
is always 0 because no model call occurs; this is documented
explicitly in the event payload and is never mixed with "estimated"
or "unavailable" categories. Aggregation reports distinguish
`live_shadow` from `live_local_shadow` runs and never merge them
under a single source label.

## Operator guide

```text
# Repository A (anirudhsengar/agentify)
cd ~/Projects/agentify
agentify engage shadow run-local \
  --id pilot-wave-1-agentify \
  --issue 127 \
  --repo anirudhsengar/agentify \
  --suite canary-shadow \
  --task canary-a1 \
  --pilot-root ~/Projects/agentify-pilot-data/pilot-wave-1 \
  --yes

# Repository B (anirudhsengar/click)
cd ~/Projects/click
~/Projects/agentify/bin/agentify.js engage shadow run-local \
  --id pilot-wave-1-click-fork \
  --issue 1 \
  --repo anirudhsengar/click \
  --suite canary-shadow \
  --task canary-b1 \
  --pilot-root ~/Projects/agentify-pilot-data/pilot-wave-1 \
  --yes
```

Inspect recorded runs and stale locks:

```text
agentify engage shadow status-local \
  --id pilot-wave-1-agentify \
  --pilot-root ~/Projects/agentify-pilot-data/pilot-wave-1 \
  --yes
```

## Limitations

This milestone implements deterministic local shadow analysis only.
It does not implement model-backed local shadow. Future model-backed
local shadow (when added) must:

- record measured cost separately from "no model call",
- require a documented model configuration,
- preserve the existing GitHub `live_shadow` provenance path,
- never auto-promote local shadow evidence to release-gate eligible.

## Failure classification

A local shadow run is classified as:

- `valid_live_local_shadow_evidence` when the local attestation is
  complete, the runner used local authentication only for reads, all
  graders passed, and no grader reported an unsafe action;
- `incomplete_live_local_shadow_evidence` when one or more graders
  failed but no unsafe action was attempted;
- `invalid_live_local_shadow_evidence` when the local attestation is
  missing, the runner used authentication for anything other than
  reads, an unsafe action was attempted, or git safety was violated.

When git safety is violated the evidence packet is preserved beneath
the private workspace so the operator can inspect it, but the run
returns a non-zero exit code.