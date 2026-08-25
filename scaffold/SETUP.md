# Agentify installation

<!-- agentify:managed -->

Agentify is installed once for this repository. Authorized GitHub issues are
the normal work interface; do not rerun the CLI for ordinary tasks.

## Queue work

Create an issue with explicit acceptance criteria and add the
`agentify:queue` label. Candidate paths are authority, so the issue must include
an explicit `## Scope` section. Use this minimum structure:

```markdown
## Goal
Describe the requested outcome.

## Acceptance criteria
- State one testable result per item.

## Scope
- `src/example.ts`

## Out of scope
- `.github/`
- `package.json`
```

Trusted maintainers may use these exact comments:

- `/agent approve`
- `/agent stop`
- `/agent retry`
- `/agent replan`
- `/agent explain`

The trusted runtime checks authorization and the configured repository policy,
plans with a read-only planner and read-only specialists, grants exactly one
builder bounded source write authority, runs approved repository validation,
obtains a role-separated automated read-only review, and opens an unmerged
draft pull request. A human retains merge authority.

## Credentials

`PI_AUTH_JSON` carries the provider credentials created by `agentify login` —
API keys and OAuth subscription sign-ins (for example Anthropic Claude
Pro/Max or OpenAI ChatGPT Plus/Pro) — to the workflows. After interactive
consent the installer uploads the local credential store through
`gh secret set` stdin. To configure it manually, run
`gh secret set PI_AUTH_JSON < ~/.agentify/auth.json`. Never place the payload
in a command argument or repository file.

`PI_API_KEY` remains supported for environment-only API-key setups without a
stored credential.

When an OAuth access token expires, the trusted runtime refreshes it under
lock; because refresh tokens rotate, the runtime writes the updated credential
back to `PI_AUTH_JSON` at the end of the run through `AGENT_PAT`. Without that
write-back the next run authenticates with a dead token.

`AGENT_PAT` is an optional dedicated GitHub automation token used only to push
the task branch, publish its draft pull request, and write back rotated OAuth
credentials to `PI_AUTH_JSON`. It is recommended because GitHub suppresses
workflow events created with the built-in workflow token, and because OAuth
subscription credentials cannot survive rotation without it.
Issue authorization, labels, comments, and task state continue to use the
repository-scoped workflow token. The dedicated token must have access to this
repository; otherwise draft publication fails closed. It remains confined to
trusted workflow code and is never exposed to model processes. A fine-grained
token needs access to this repository with **Contents: read and write**,
**Pull requests: read and write**, and **Secrets: read and write**.

The installer owns these repository variables:

- `PI_PROVIDER`
- `PI_MODEL`
- `PI_THINKING`
- `AGENTIFY_VERSION`

## Installed trust boundary

- `.github/workflows/agentify-issue.yml` handles authorized issue work.
- `.github/workflows/agentify-learn.yml` handles accepted-merge learning.
- `.github/agentify-task-policy.json` is repository-identity-bound and fails
  closed when incomplete.
- `.github/agentify/*.mjs` are trusted bundled runtimes.
- `.agentify/` is versioned external memory plus ignored operational state.

Agentify never merges application changes, enables auto-merge, deploys,
force-pushes an application branch, or lets learned output modify application
source, dependencies, workflow permissions, policy, or executable runtime code.
