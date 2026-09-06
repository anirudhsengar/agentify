# Live specialist installation in GitHub Actions

The `Live specialist installation` workflow runs the actual installed npm CLI,
not a provider ping, seeded map, mocked model, or replayed GitHub API. It pins
all model roles to `minimax/MiniMax-M3`, high thinking, and unchanged production
audit budgets. Configure the repository Actions secret `PI_API_KEY` with a
MiniMax API key. It is mapped to `MINIMAX_API_KEY` only for the installation.

Before merge, the repository owner can explicitly add the
`agentify-live-install` label to a same-repository PR. Remove and re-add the label
to evaluate another head; ordinary pushes do not spend credits. After this
workflow reaches the default branch, `workflow_dispatch` also accepts a
maintainer-owned fork and a full target commit. Hono at the historical pinned
commit is the default. Fork PRs and non-owner actors cannot run the secret job.

The workflow runs `verify:release`, creates a canonical tarball, verifies its
hash, installs it offline without scripts, and clones a fresh target before
exposing credentials. It records exact candidate/target/package identities,
model configuration, live usage, terminal status, original tracked-file hashes,
readiness and installed specialists. Logs and generated team text are redacted
before artifact upload; auth stores and the full runner home are never uploaded.

GitHub calls use only the read-only Actions token. Missing maintainer or branch
policy permissions remain real readiness blockers; responses and permissions
are never forged. A complete `analysis-ready` installation must have no execution
entry points. Operational GitHub setup is not qualified by this job. No branches,
issues, pull requests, upstream files, labels, secrets, or settings are written
by the installer to the target GitHub repository.

A green run requires a nonempty installed team, a successful CLI process, exactly
one successful terminal event, accounted live M3 calls, unchanged original
tracked files, and a consistent readiness policy. A diagnostic-only map fails.
The artifact always reports `release_ready=false`: one live installation does
not replace the existing historical/held-out matrix, installed-team manual
reviews, final-candidate cancellation checks, or exact-head release gates.

Concurrency is one paid run; the default audit budget is 30 minutes and USD 20
(including reservations, not a promise about provider invoices). The outer
process deadline is 33 minutes with bounded termination escalation. The job
allows 60 minutes including release checks. Evidence is retained for 14 days.
