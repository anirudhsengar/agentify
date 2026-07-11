# Security Policy

agentify is a Node CLI that reads a target repository, calls an LLM
provider, and writes harness-shaped artifacts (`.claude/`, `.codex/`,
`.pi/`, `.agents/`) plus architecture docs (`AGENTS.md`, `specs/`,
`ai_docs/`) into that repo. It also ships a `scaffold/` directory that
`agentify` stamps into target repos on bootstrap. Any bug in these
surfaces can allow unintended repository mutation or credential access,
so security reports receive priority.

## Supported versions

| Version | Supported        |
| ------- | ---------------- |
| 0.1.x   | Yes (active dev) |
| < 0.1.0 | No (pre-release) |

Until 1.0.0 the API and CLI surface are subject to change without strict
semver. Security fixes may ship in a patch release.

## Runtime security model

Every model-backed runtime session must receive an explicit
`AgentExecutionPolicy`. The policy is the primary capability boundary and
defines:

- the SDK built-in tools the session may receive;
- repository roots the session may read;
- repository roots the session may write;
- paths that remain protected even inside a writable root;
- whether shell execution is denied or permitted for a development phase;
- the session's network posture.

`PiSdkRuntime` validates the requested built-in tool list before creating
the model session. Trusted custom tools are registered separately and do
not widen access to SDK built-ins. The defense hook then enforces policy
roots after symlink resolution and applies orchestrator domain locks as an
additional narrowing constraint.

### Read-only sessions

Brownfield builders, explorer sub-agents, review phases, and ordinary
webhook-dispatched sessions are read-only:

- built-ins are limited to `read`, `grep`, `find`, and `ls`;
- shell execution is denied;
- structured writes are denied;
- reads resolving outside the repository are denied;
- `~/.agentify/auth.json` and other zero-access paths remain inaccessible.

The audit can still write validated structured state through trusted custom
tools such as `write_map`; those tools are implemented by Agentify code and
are not general filesystem capabilities.

### Write-capable sessions

Greenfield implementation and explicitly designated build/fix phases may
receive a repository-write policy. Writes remain confined to the declared
roots, protected files remain immutable, and orchestrated sub-agent domain
globs can only narrow access. Shell-enabled development sessions still pass
through the command blacklist and script-content scanner as defense in
depth.

The blacklist is not the primary sandbox. A missing or inactive global
audit-session flag must never disable a supplied execution policy.

## Reporting a vulnerability

**Do not file a public issue for security bugs.**

Use GitHub's private vulnerability reporting:

> https://github.com/anirudhsengar/agentify/security/advisories/new

If the GHSA flow is unavailable, email `anirudhsengar@gmail.com` with the
subject `[agentify security]` and include:

- a description of the vulnerability and its impact;
- the affected version (`agentify --version`) and Node version
  (`node --version`);
- a minimal reproduction with the target repository shape and command;
- relevant log excerpts with secrets redacted.

You should receive an acknowledgement within **3 business days**.

## What to expect

- Triage within 7 days of acknowledgement.
- A fix or mitigation timeline discussed in the private advisory.
- Critical issues such as arbitrary writes outside the repository,
  command injection, or credential disclosure handled as top priority.
- A coordinated disclosure date before any public advisory.

## In-scope issues

- Execution-policy bypass, including path traversal, symlink escape,
  forbidden tool admission, or shell access in a read-only session.
- Defense-hook bypass or a global-state path that disables an explicit
  execution policy.
- Webhook signature, queue, sandbox, replay, or management-endpoint issues.
- Prompt injection that crosses deterministic schema, filesystem, command,
  or credential boundaries.
- Credential permissions, accidental secret logging, or environment leakage.
- Supply-chain compromise affecting Agentify's runtime dependencies.

## Out of scope

- Upstream runtime issues without an Agentify-specific reproducer. Report
  those upstream and link the advisory.
- Social-engineering reports that do not cross a documented technical
  boundary.
- Third-party model-provider rate limits or account quotas.

## Hardening notes for users

- Run `agentify` from the repository root you intend to process.
- Keep `~/.agentify/auth.json` mode `0600`; the login path enforces this.
- Pin Agentify and its provider SDKs in CI for reproducible execution.
- Treat write-capable automation as privileged and keep its configured
  repository roots and domain globs narrow.

## Recognition

We follow a `with-credit` policy. Reporters are credited in the advisory
unless they ask to remain anonymous.
