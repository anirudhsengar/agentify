# Security Policy

agentify is a Node CLI that reads a target repository, calls an LLM
provider, and writes harness-shaped artifacts (`.claude/`, `.codex/`,
`.pi/`, `.agents/`) plus architecture docs (`AGENTS.md`, `specs/`,
`ai_docs/`) into that repo. It also ships a `scaffold/` directory that
`agentify` stamps into target repos on bootstrap. The defense hook
(`src/core/audit/defense/`) constrains the explorer sub-agent's file
access at runtime. Any bug in those surfaces can let agentify write
outside its intended boundaries, so we treat security reports with
priority.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes (active dev)   |
| < 0.1.0 | No (pre-release)   |

Until 1.0.0 the API and CLI surface are subject to change without
following strict semver. Security fixes may ship in a 0.0.x patch.

## Reporting a vulnerability

**Please do not file a public issue for security bugs.**

Use GitHub's private vulnerability reporting:

> https://github.com/anirudhsengar/agentify/security/advisories/new

If you cannot use the GHSA flow, email `anirudhsengar@gmail.com`
with the subject `[agentify security]` and:

- a description of the vulnerability and its impact,
- the affected version (`agentify --version`) and Node version
  (`node --version`),
- a minimal reproduction (target repo shape, command line, env vars),
- the relevant excerpt of `<stateDir>/agentify.log` with any API keys
  redacted (state dir is `~/.agentify/`, `~/.claude/agentify/`,
  `~/.agents/agentify/`, or `~/.pi/agentify/` per ADR 0020).

You should receive an acknowledgement within **3 business days**.

## What to expect

- **Triage** within 7 days of acknowledgement.
- A fix or mitigation timeline will be discussed in the GHSA thread.
  Critical issues (arbitrary file write outside the target repo,
  command injection, credential disclosure) are worked on as the top
  priority.
- A coordinated disclosure date is agreed before any public advisory.
  We aim for a CVE via GHSA where the report warrants one.

## Scope of in-scope issues

- **Defense hook bypass** (path traversal, repo-jail escape, write
  outside the target working directory).
- **Sandbox / coverage gate** subversion that lets the audit declare a
  repo "covered" without validating it.
- **Webhook server** signature verification, queue poisoning,
  unauthenticated trigger activation, or SSRF in webhook fetchers.
- **Prompt injection** that causes the builder or orchestrator to write
  outside the strict TypeBox schemas, or to exfiltrate `auth.json`
  contents from `~/.agentify/`.
- **Credential handling**: weak file permissions on `~/.agentify/auth.json`,
  accidental logging of API keys, env-var leakage in error paths.
- **Supply chain**: malicious or compromised versions of
  `@earendil-works/pi-coding-agent` or `@earendil-works/pi-ai`.

## Out of scope

- Issues in the upstream `@earendil-works/pi-coding-agent` /
  `@earendil-works/pi-ai` runtime that do not have an agentify-specific
  reproducer. Please report those upstream and link us.
- Findings that depend on a user pasting attacker-controlled text into
  a prompt without sandboxing — the defense hook is best-effort by
  design.
- Rate-limit or quota issues against third-party LLM providers.

## Hardening notes for users

- Run `agentify` from the repo root you intend to modify. It does not
  prompt before writing harness-shaped files into that repo.
- Keep `~/.agentify/auth.json` mode `0600`. The `agentify login` path
  enforces this; do not move the file into a shared location.
- Pin agentify in CI: `npm ci` against an exact version, and prefer
  `npx -y agentify@<version>` over `latest` for reproducible runs.
- Pin your LLM provider SDKs on the same lockfile.

## Recognition

We follow a `with-credit` policy. Reporters are credited in the
advisory unless they ask to remain anonymous.