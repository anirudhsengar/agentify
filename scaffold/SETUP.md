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

This checks the shell behavior, skill/lock consistency, workflow security
guards, label contract, and drill-workflow triggers.
