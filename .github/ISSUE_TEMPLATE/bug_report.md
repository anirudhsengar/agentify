---
name: Bug report
about: Report incorrect behavior, crashes, or regressions in agentify
title: "[bug] "
labels: ["bug", "needs-triage"]
assignees: []
---

## Summary

<!-- One or two sentences describing the bug. -->

## Reproduction

<!-- Minimal steps to reproduce. agentify is invoked from a repo root; include
the working directory, the agent or CLI flags used, and the exact command
line. -->

```bash
agentify --mode brownfield
```

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What actually happened. Paste the relevant console output, the last
lines of `<stateDir>/agentify.log` (typically `~/.agentify/agentify.log`,
`~/.claude/agentify/agentify.log`, or `~/.agents/agentify/agentify.log`
— provider-scoped based on the user's selected coding agent), and
any stack traces. -->

## Environment

- agentify version: `agentify --version`
- Node version: `node --version` (must be `>=22.19.0`)
- OS / shell:
- Target coding agent (claude-code, codex, pi, etc.):
- Operating mode (`brownfield` / `greenfield` / unset):
- Repository kind (private / public, monorepo / single-package, language):

## Logs and artifacts

<!-- Attach or inline the contents of:
  - <stateDir>/agentify.log (last ~200 lines)
  - <stateDir>/greenfield-state.json (only for greenfield sessions)
  - <stateDir>/audit/coverage.json (only if the failure is in the audit/coverage gate)
If the log contains API keys, redact them first. -->

## Possible cause

<!-- Optional. If you have a hunch or already isolated the issue to a file
under `src/`, drop it here. Otherwise leave blank. -->

## Checklist

- [ ] I reproduced on the latest `main` (`git rev-parse HEAD`).
- [ ] I checked existing issues (`https://github.com/anirudhsengar/agentify/issues`).
- [ ] I redacted any API keys, OAuth tokens, or `.pem`/`.key` material from the log.