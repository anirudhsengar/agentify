# Agentify

Agentify installs a persistent, repository-specific engineering team into an
existing GitHub repository. After installation, authorized GitHub issues are the
normal work interface.

For each task, Agentify uses one orchestrator, evidence-backed read-only
specialists, exactly one writable builder, a role-separated automated read-only
reviewer, and a path-restricted knowledge maintainer. Application changes stop at an
unmerged draft pull request; a human retains merge authority.

## Project status and limits

Agentify is an early `0.1.x` project. Its published evidence comes from
maintainer-controlled qualification repositories and exact-artifact tests; it
does not claim independent customer adoption or long-running production use.

The supported installer currently targets GitHub repositories whose validation
is exposed through a root npm manifest and committed lockfile. Repository
validation is maintainer-approved application code: Agentify removes common
credentials from the child environment and rejects repository mutation, but it
does not provide OS-level sandboxing or network isolation. Automated review is
role-separated and read-only; it is not a substitute for human peer review.

## Five-minute evaluation

1. Read the [product contract](docs/architecture/install-once-repository-team.md)
   and [security boundary](SECURITY.md).
2. Inspect the [exact installed-artifact qualification](https://github.com/anirudhsengar/agentify/blob/main/tests/package/exact-artifact-qualification.mjs),
   which tests the tarball rather than raw source.
3. Follow one maintainer-controlled run from
   [queued issue](https://github.com/anirudhsengar/agentify-e2e-octokit-graphql-1785911154/issues/2)
   to [unmerged draft pull request](https://github.com/anirudhsengar/agentify-e2e-octokit-graphql-1785911154/pull/3).

The live run demonstrates controlled end-to-end behavior, not third-party
adoption.

## Requirements

- Node.js 22.19.0 or newer
- Git
- GitHub CLI (`gh`), authenticated to the target repository
- maintainer access to an existing GitHub repository
- credentials for a supported model provider

## Install

```bash
npm install --global @anirudhsengar/agentify
cd /path/to/repository
agentify login --provider anthropic
agentify models set anthropic/claude-sonnet-4-5
agentify
```

Credentials are read from provider environment variables or a masked
interactive prompt. They are never accepted as command-line values or written
to the repository.

During installation, Agentify can also configure an `AGENT_PAT` Actions secret
with explicit consent. A dedicated token lets Agentify-created draft pull
requests trigger the repository's normal pull-request workflows; without it,
GitHub's built-in workflow token may suppress those recursive workflow events.
Agentify uses that token only for branch push and draft PR publication; issue
authorization and state mutations retain the repository-scoped workflow token.
For a fine-grained token, grant access to the target repository with
**Contents: read and write** and **Pull requests: read and write**. Neither
credential is exposed to model processes.

The installer verifies repository identity, maintainer authority, deterministic
validation commands, provider readiness, protected paths, and the installed
runtime. A successful installation creates:

```text
.agentify/
  manifest.json
  agents/
  knowledge/
  policies/
  runtime/
.github/
  agentify-task-policy.json
  agentify/
  scripts/
  workflows/agentify-issue.yml
  workflows/agentify-learn.yml
```

Agentify preserves user-owned files. If a required path is occupied, the
installer leaves the existing file untouched and reports the conflict.
Before executing repository validation for the first time, the interactive
installer displays the exact commands and requires explicit maintainer
approval. Non-interactive first installation remains analyzable-only.

## Use

Create a GitHub issue with explicit acceptance criteria and add the
`agentify:queue` label. The installed workflow then:

1. verifies the issue, actor, repository, and base commit;
2. builds an evidence-backed plan;
3. grants one builder bounded write authority on an isolated branch;
4. runs the approved repository validation outside the model process;
5. obtains a role-separated automated read-only review;
6. applies only bounded corrections;
7. opens an unmerged draft pull request.

After an accepted merge, the learning workflow verifies the exact default-branch
commit and refreshes path-restricted repository knowledge. Learning cannot edit
application source, dependencies, workflows, runtime code, permissions, or
protected policy.

## Commands

```text
agentify
agentify --help
agentify --version
agentify login [--provider <name>]
agentify logout [--provider <name> | --all] [--yes]
agentify models list [--provider <name>]
agentify models show [--resolved]
agentify models set <provider>/<model>
agentify models set <primary|explorer|lite> <provider>/<model>
agentify models unset [primary|explorer|lite]
```

`primary` is the default model. `explorer` and `lite` inherit `primary` when
they are not assigned explicitly.

## Trust model

- Model sessions receive explicit readable and writable roots, tool allowlists,
  protected paths, command posture, deadlines, output caps, retries, and budget.
  Network-capable model tools are not admitted by the current role policies,
  but model processes are not network-isolated.
- Audit and specialist sessions are read-only.
- Exactly one builder may edit application source for a task.
- Model processes never receive GitHub write credentials.
- Repository validation is approved and observed, but not OS- or network-isolated.
- Trusted workflow code validates typed model output before repository or GitHub
  mutations.
- Deployment and automatic application merge are disabled.
- Persistent knowledge includes provenance, a supporting commit, confidence,
  freshness, and deterministic invalidation rules.

See [Security](SECURITY.md) for the complete security boundary.

## Development

```bash
npm ci
npm run typecheck
npm run test:all
npm run verify:release
```

Node 22.19.0 is the minimum supported runtime. The complete release gate builds
the three executable bundles, runs all source and scaffold tests, installs and
exercises the exact npm artifact, and audits production dependencies.

Architecture and maintainer documentation starts at
[docs/README.md](docs/README.md). Contributions follow
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
