# Security policy

## Supported version

| Version | Supported |
| --- | --- |
| 1.0.0 | Yes |

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/anirudhsengar/agentify/security/advisories/new)
or email `anirudhsengar@gmail.com` with the subject `[agentify security]`.
Do not open a public issue for an undisclosed vulnerability.

## Security model

Agentify separates model reasoning from trusted authority. Prompts are not a
sandbox. Every model session receives an explicit execution policy defining
allowed tools, readable and writable roots, protected paths, command posture,
deadlines, inactivity limits, output caps, retries, cost budget, and the explicit
absence of process-level network isolation.

Audit and specialist sessions are read-only. The orchestrator and reviewer cannot
edit application source. Exactly one builder receives bounded write authority for
an active task. The knowledge maintainer can write only validated Agentify
knowledge paths.

Model processes never receive GitHub write credentials. Trusted local or workflow
code validates typed output, repository identity, expected commits, branches,
paths, state transitions, and evidence before performing bounded mutations.

| Assurance | Agentify provides |
| --- | --- |
| Enforced | Model tool allowlists, path and branch boundaries, typed state transitions, and GitHub credential separation |
| Detected and rejected | Repository mutation during validation, validation-policy hash drift, and covered audit claims that lack verifiable repository-path evidence |
| Mitigated | Common credential variables are removed from validation child environments |
| Not provided | OS-level sandboxing or network isolation for repository validation |

## Repository and filesystem safety

All repository paths are normalized and must remain inside the physical
repository root. Writable operations reject absolute paths, traversal, protected
paths, unsafe symlinks, and roots that cannot be verified. Managed files require
recognized ownership markers and expected bytes. User-owned files are preserved.

The repository audit coverage gate requires every `covered` dimension to cite
real repository paths. Positive citations must point at existing repository paths
under the root; absence citations must point at a checked nonexistent path. The
trusted gate rejects covered claims that cannot be grounded in repository evidence.

Persistent state has one root, `.agentify`. Initialization fails closed on
unrecognized content. Durable records carry supporting commits and real-byte
hashes. Multi-file changes use deterministic transaction journals and validate
current bytes before recovery.

Builder output is accepted only on the isolated task branch and within the
approved path set. Trusted code snapshots the repository before and after the
model session and rejects scope violations. Application merge and deployment are
never automatic.

## Command execution

Repository validation uses fixed argv vectors without a shell at the controller
boundary, but package managers may invoke their own shell or indirect programs.
The installer scans visible root script text for obvious production credentials
and deployment, publication, release, cloud, or infrastructure mutation. This
is a guardrail, not proof that indirect code is safe. Running `agentify` in the
target repository records installer attestation for unsandboxed validation of
the screened command set. The complete npm manifest, command set, and lockfile
are hashed; drift disables issue intake until `agentify` is rerun. Common
credential variables are removed from validation child environments, but
validation is not an OS sandbox and its network is not isolated.

Audit explorers do not receive unrestricted shell, write, or edit tools. Builder
shell access, when policy permits it, is guarded by command classification,
protected-path enforcement, timeout, output limits, and the approved repository
roots. Withholding network-capable tools and rejecting known network executables
reduces model-initiated access; it does not isolate the process or indirect
repository code from the network.

## Credentials

Provider credentials stay outside repository state. The CLI accepts them through
provider environment variables, OAuth instructions, or a masked interactive
prompt; credentials are never accepted in command-line arguments.

Authentication files are written with restrictive permissions where the
platform supports them. Secrets are not included in logs, model prompts, durable
memory, manifests, or generated repository files. Durable values are scanned for
common token, private-key, and credential forms before persistence.

The installer copies a resolved local provider API key to the `PI_API_KEY`
GitHub Actions secret when one is already present and no stored credential
exists, or prompts interactively when a TTY is available and no local key is
resolved. When `agentify login` has stored credentials — API keys or OAuth
subscription tokens — the installer offers, only after interactive consent, to
upload the credential store as the `PI_AUTH_JSON` Actions secret. `AGENT_PAT`
is set only after interactive consent. Secret values are passed to
`gh secret set` through stdin and are never placed in argv or output.

Inside the workflow, `PI_AUTH_JSON` is materialized once per run into a
`0600` file under the runner temp directory that only the trusted runtime
reads; the secret itself is scrubbed from every model and validation process
environment. When a provider rotates an OAuth refresh token during a run, the
trusted controller writes the updated credential store back to the
`PI_AUTH_JSON` secret at exit using `AGENT_PAT` (best-effort, never failing
the run), because the previously stored refresh token is invalidated by
rotation.

## GitHub workflow authority

Installed workflows use least-privilege permissions. Untrusted model sessions
emit strict typed results; trusted scripts independently verify the issue,
authorized actor, repository, default-branch head, task state, branch, diff,
validation, and review before labels, comments, pushes, or draft pull-request
publication.

Accepted-merge learning binds to the canonical repository, exact accepted commit,
first parent, and expected default-branch head. Its write allowlist excludes
application source, dependencies, workflows, permissions, operational state,
runtime code, and protected policy.

Scheduled learning excludes pre-install history and Agentify-owned files from
application evidence. A pending knowledge proposal is resumed only when its
same-repository open pull request, single-commit shape, repository and base
trailers, first-parent ancestry, allowlisted regular-file diff, publication
limits, manifest, and immutable memory history all validate. Branch replacement
uses the proposal SHA captured at preflight as an exact force-with-lease value;
concurrent or unrecognized maintenance-branch changes fail closed.

## Supply chain

The npm artifact exposes only the `agentify` executable and `package.json`, omits
raw source, blocks deep imports, and includes explicit bundled runtimes and
scaffold assets. Release publication is tag-only, verifies the exact tarball, and
publishes the same bytes used by package qualification.

Production dependencies use npm-registry semver specifications and are audited
at release time. Agentify consumes the official `0.84.0` Pi coding-agent and AI
packages together; tests reject personal GitHub, raw-file, or tarball dependency
specifications. Runtime, provider, exact-artifact, reproducibility, and
`npm audit --omit=dev --audit-level=high` qualification must all pass before a
release may be published.

## Out of scope for model authority

Models cannot merge application pull requests, deploy, expand workflow
permissions, modify protected policy, change executable Agentify runtime code,
write outside approved roots, or silently adopt unrecognized state. These actions
require explicit maintainer-controlled changes through the normal repository and
release process.
