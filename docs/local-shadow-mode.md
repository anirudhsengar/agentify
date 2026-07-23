# Agentify local shadow mode

Local shadow mode is a supported, deterministic, analysis-only alternative to
the GitHub-hosted shadow workflow. It is deliberately separate from hosted
execution and carries a lower trust level.

## Trust model

Every local packet states that it is **operator-attested local execution**. It
is suitable only for controlled internal pilot review and is:

- not equivalent to GitHub-hosted runtime attestation;
- not a package release gate;
- not customer proof;
- not implementation success;
- unable to prove that an issue was fixed;
- ineligible for automatic draft admission or promotion.

Local evidence uses `live_local_shadow` and the distinct classifications
`valid_live_local_shadow_evidence`, `incomplete_live_local_shadow_evidence`, and
`invalid_live_local_shadow_evidence`. It never supplies or fabricates a GitHub
workflow-run ID, run attempt, runner identity, hosted environment reference, or
Actions artifact ID. The hosted `live_shadow` path still requires the GitHub
Actions trust boundary.

A pilot-gate-valid local run requires authenticated `gh` access. The attestation
records these separately:

- `github_operator_login`: authenticated GitHub login or `null`;
- `local_operator_identity`: the local operating-system account;
- `github_authentication_status`: `authenticated`, `anonymous_read`, or
  `unavailable`.

Anonymous public reads are never represented as an authenticated operator.
Repository metadata and issue data are fetched through narrowly constrained,
read-only `gh` commands. Local GitHub authentication is used only for reads.

## Private workspace and source integrity

`--pilot-root` must be an existing absolute private directory outside the
source repository. The runner writes beneath:

```text
<pilot-root>/workspaces/<repository-slug>/
├── managed-state/       # cumulative local metrics
├── shadow/<run-id>/     # portable evidence and summary
├── locks/               # host-local cooperative locks
└── clone/               # detached, remote-free private checkout
```

The first run clones from the operator's source checkout without hard links,
removes the clone remote, and detaches at the exact source commit. A reused
clone must already be clean, detached, remote-free, and at that exact commit;
unexplained state is rejected rather than silently repaired. Pilot/source
path overlap and symlink escapes are rejected.

The source checkout is read-only. Integrity snapshots cover HEAD, branch or
detached state, local and remote refs, remote configuration, index/working-tree
state, tracked object and mode inventory, untracked inventory, and ignored-file
symlink topology. An integrity violation returns non-zero and any preserved
terminal evidence is classified invalid.

Portable evidence contains stable repository, commit, workspace, and evidence
references. It does not serialize the source checkout, pilot root, home
directory, or private workspace absolute path.

## Approval and command contract

```text
agentify engage shadow run-local \
  --id verification \
  --issue 9001 \
  --repo fixture-owner/fixture-repo \
  --pilot-root /absolute/private/pilot-root \
  --yes
```

`--id`, `--issue`, `--repo`, and `--pilot-root` are required. Issue numbers
must be positive integers and repositories must be exact `owner/name` values.
Interactive runs prompt unless `--yes` is supplied. Non-interactive runs,
including those using `--non-interactive`, require explicit `--yes`;
`--non-interactive` is not approval.

Status inspection is read-only and does not require approval:

```text
agentify engage shadow status-local \
  --id verification \
  --repo fixture-owner/fixture-repo \
  --pilot-root /absolute/private/pilot-root
```

Locks are scoped to repository + engagement + issue. They record host, PID,
process-start identity, creation time, and a nonce. `status-local` only inspects
locks. Recovery is conservative: a lock from another host, a corrupt lock, or a
lock whose process identity cannot be disproved must not be removed. This is
host-local cooperative locking, not distributed locking.

Explicit recovery procedure: run `status-local`, compare the recorded host,
PID, start timestamp, and process-start identity with the local process table,
and stop if any value is unknown or still matches. Only after the same-host
process identity is proven absent may the operator remove that one exact
`<pilot-root>/workspaces/<repository-slug>/locks/<repo>__<engagement>__<issue>.lock`
file. Never remove every lock by glob and never use lock age alone.

## Runtime, cost, and redaction

One monotonic deadline governs the run. Git and GitHub subprocesses receive the
remaining bounded timeout, and no new major stage starts after expiry. A timeout
is distinct from cancellation, is never valid evidence, and writes a factual
terminal record when the private workspace is available.

The deterministic engine makes no provider call. `model_call_count` is `0`,
measured cost is exactly `$0`, and the cost source says `no provider invocation`.
The configured maximum cost remains a separate policy field. Provider
configuration and credentials are not required or loaded.

Evidence, summaries, metric references, and diagnostics share one redactor for
GitHub tokens, generic keys, private keys, authorization headers,
credential-bearing GitHub URLs, ANSI escapes, sensitive local paths, and
oversized text.

## Metrics and promotion boundaries

Every metric event carries an explicit closed `execution_origin`; origin is not
inferred from a run-ID prefix. Aggregates expose separate factual counts for
GitHub live shadow, local live shadow, draft, synthetic, imported/no-execution,
and legacy/unknown data.

`live_local_shadow` remains release-gate ineligible, customer-proof ineligible,
implementation-success false, and automatic-promotion ineligible. Existing
GitHub draft gates accept only their explicit hosted evidence policy; local
shadow evidence can support human pilot review but is not interchangeable with
hosted evidence.

## Failure classification

- **valid**: authenticated GitHub operator, authoritative matching repository
  and issue, complete attestation, all graders pass, and all safety checks pass;
- **incomplete**: factual execution completed but required evidence or graders
  are incomplete, including anonymous/unavailable GitHub authentication;
- **invalid**: identity mismatch, malformed attestation, forbidden action,
  timeout, source/workspace integrity violation, or other safety failure.

This milestone does not add local implementation, branch creation, pushing,
pull requests, automatic merging, model-backed execution, or general local
autonomy.
