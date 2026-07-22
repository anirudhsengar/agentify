<!-- agentify:managed -->
# Setup

One-time configuration a target repo needs before the agentify
pipeline (or its CI runtime) can run end to end. agentify automates
label reconciliation and validation; a human still supplies
credentials and configures the GitHub surfaces the workflows depend on.

## 1. Reconcile the agentify repo contract

The recommended setup command creates or reconciles the labels agentify owns, checks required Actions configuration, and runs the repository contract tests:

```sh
bash .github/scripts/setup-agentify.sh
```

The setup creates the following labels (every workflow triggers off these):

| Label | Purpose |
|---|---|
| `agent:queued` | Through drilling and planning; not yet picked up |
| `agent:implement` | The "go" signal for an agent to start implementing |
| `agent:in-progress` | An agent is currently working on this issue |
| `agent:blocked` | Hit a non-recoverable failure; investigate before retrying |
| `agent:review` | Hand off a PR for review |
| `agent:update-branch` | Merge the PR's base branch into the PR branch |
| `agent:approved` | Automated review found no blocking changes; human merge approval is still required |
| `agent:drill-me` | Async drilling intake via `agent-drill-me-issue.yml` |
| `agent:shadow` | Opt-in analysis-only FDE recommendation; disabled by default |
| `agentify:draft` | Human-approved Agentify draft PR; Agentify never merges it |
| `artifact:prd` | Planning artifact; not directly executable by an agent |

To create only the labels manually, run the `gh label create` invocations in
`.github/scripts/setup-agentify.sh` directly. Each is idempotent and re-runnable.

See the stamped `.github/agent-state-machine.json` for the label/state contract
that drives these workflows. Background design notes live in the agentify
source repo: [ADR-0005](https://github.com/agentify/agentify/blob/main/docs/adr/0005-agent-star-label-taxonomy.md)
and [ADR-0012](https://github.com/agentify/agentify/blob/main/docs/adr/0012-evolution-loop.md).

## 2. Configure the agent runtime's secrets and variables

The `.github/workflows/agent-*.yml` workflows watch the `agent:*` labels
above and run [Pi](https://github.com/earendil-works/pi) to do the actual
work (see [ADR-0007](https://github.com/agentify/agentify/blob/main/docs/adr/0007-pi-as-the-ci-coding-harness.md)).
Set these once, in **Settings → Secrets and variables → Actions**:

**Secrets:**

```
PI_API_KEY    Provider API key, passed to Pi via --api-key (works for any provider).
AGENT_PAT     Required. A fine-grained PAT with contents:write, workflows:write,
              pull-requests:write, and issues:write on this repo.
              Runtime-authored labels use it so downstream workflows fire;
              GITHUB_TOKEN-authored events do not.
```

**Variables:**

```
PI_MODEL        Required. Model ID or pattern, e.g. claude-sonnet-4-6.
PI_VERSION      Required. Exact @earendil-works/pi-coding-agent version, e.g. 1.2.3.
PI_PROVIDER     Optional, defaults to anthropic. See the Pi repo's docs/providers.md
                for the full list (openai, google, openrouter, ...).
PI_THINKING     Optional, defaults to high. off | minimal | low | medium | high | xhigh.
AGENT_BOT_LOGIN Required. The GitHub login AGENT_PAT belongs to. The drill workflow
                uses it to recognize its own replies and prevent a loop.
```

## 3. Drive the async loop

### Optional GitHub shadow mode

Shadow mode is installed but inert. To enable it, edit
`.github/agentify-shadow.json`, set `mode` to `shadow`, and provide an existing
engagement ID, eval suite ID, and task ID. Keep `comment_on_issue` false unless
compact public recommendations are acceptable for the repository.

Adding `agent:shadow` then runs the supported analysis-only workflow. It has
read-only contents permission, does not configure checkout credentials, and
uploads `agentify-shadow-<run>-<attempt>` containing a redacted JSON evidence
packet and Markdown summary. It writes a copy under the resolved Agentify state
directory during the job. GitHub-hosted runners are ephemeral, so the uploaded
artifact is the durable CI record unless the state directory is backed by a
separate approved persistence mechanism. See the packaged
`docs/github-shadow-mode.md` operator guide for setup, packet fields, security,
limits, troubleshooting, migration, and an example flow.

### Human-approved draft mode

After retaining valid shadow evidence, explicitly promote the engagement to
`draft`, move its lifecycle to `shadow` or `draft_pilot`, and confirm there are
no unresolved critical risks. Then set `mode` to `draft` and configure explicit
argv-vector checks for build, tests, typecheck, lint, and security in
`.github/agentify-shadow.json`. Applying `agent:implement` is the separate
per-run human approval for that issue and exact base commit. The workflow uses
an ephemeral checkout and unique run branch and may create only a draft PR
labeled `agentify:draft`; it never force-pushes, enables auto-merge, pushes to
the default branch, or merges. See `docs/github-draft-mode.md` for permissions,
cost pricing/reservation maintenance, the active runtime deadline, idempotent
PR recovery, and confirmed cleanup of recorded orphan branches. Populate the
exact provider/model rows in `pricing_policy.models` before enabling draft mode;
unknown models fail closed and configured budget is never reported as spend.
failure recovery, cleanup, revocation, evidence, and human-review capture.

Creating an issue is safe triage by default. Automation starts when a trusted
actor adds a runnable label or comments with one of these commands:

```
/agent implement
/agent review
/agent update-branch
/agent retry
/agent stop
```

Every command routes through `.github/workflows/agent-command.yml`, checks the
actor role, mutates labels idempotently, and comments with the next action.

## 4. Validate the template

Run:

```sh
bash tests/run.sh
```

This checks generated script syntax, workflow structure, label contract, and
runtime safety guards. Agentify's full implementation test suite runs in the
Agentify source repository, not in your project.

## 5. Live-smoke the GitHub runtime

After the scaffold is pushed and Actions secrets/variables are configured, run:

```sh
bash .github/scripts/smoke-github-runtime.sh --evidence-file docs/release/smoke-implement-preflight.json
```

This creates a temporary issue, applies `agent:implement` without
`agent:queued`, and waits for the trusted implement preflight to refuse the run.
That validates GitHub events, labels, workflow execution, and trusted issue
comments without starting a Pi model run. Pass `--repo owner/name` outside a
checkout, or `--keep-issue` if you want to inspect the smoke issue afterward.
The optional `--evidence-file` argument writes JSON with the issue, PR, or
workflow URL that proves the smoke passed. The evidence also records the commit
SHA from `AGENTIFY_SMOKE_COMMIT_SHA`, or from `git rev-parse HEAD` when run
inside a checkout.

To smoke the post-launch drill workflow without starting a model run, run:

```sh
bash .github/scripts/smoke-drill-github-runtime.sh --evidence-file docs/release/smoke-drill-preflight.json
```

This creates a temporary `agent:drill-me` issue with a trusted smoke marker and
waits for `agent-drill-me-issue.yml` to comment, remove the trigger label, and
stop before checkout or Pi starts.

To smoke the public retry command without starting a model run, run:

```sh
bash .github/scripts/smoke-retry-github-runtime.sh --evidence-file docs/release/smoke-retry.json
```

This creates a temporary blocked issue, posts `/agent retry`, waits for the
trusted command router to remove blocked/in-progress state and queue
`agent:implement`, then closes the issue. Because the issue is not
`agent:queued`, the follow-on implement workflow should stop at preflight.

For a model-backed staged-repo smoke, run:

```sh
bash .github/scripts/smoke-model-github-runtime.sh --confirm-model-run --evidence-file docs/release/smoke-model-implement.json
```

This creates a queued smoke issue, applies `agent:implement`, and waits for the
implementation workflow to open a draft PR. It starts Pi through GitHub Actions
and can spend provider tokens, so run the no-LLM smoke first and use this only
in a staging repository or during release qualification.

To smoke the review workflow against that PR, run:

```sh
bash .github/scripts/smoke-review-github-runtime.sh --confirm-model-run --pr <number> --evidence-file docs/release/smoke-review.json
```

This applies `agent:review` to an agent-owned PR and waits for the review
workflow to approve it, requeue implementation, or mark it blocked.

To smoke the self-refresh workflow, run:

```sh
bash .github/scripts/smoke-refresh-github-runtime.sh --confirm-model-run --evidence-file docs/release/smoke-refresh.json
```

This dispatches `agent-refresh-surface.yml` on the default branch and waits for
the workflow run to complete successfully. It starts Pi and can spend provider
tokens.
