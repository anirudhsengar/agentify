# 008 — Hardened CI Pi wrapper

## Goal

Run GitHub Actions Pi jobs through an agentify-controlled safety wrapper
that matches the local defense floor.

## Evidence

- Local `PiSdkRuntime` attaches `makeDefenseHook()`.
- `scaffold/.github/actions/run-pi/action.yml` runs raw
  `pi --print --no-session --approve`.
- GitHub prompts correctly mark issue/PR content as untrusted, but prompt
  text is not a security boundary.

## Scope

Scaffold runtime and package support code.

## Implementation plan

1. Add a CI entry module or wrapper script that invokes Pi with an
   agentify extension/resource loader applying:
   - bash blacklist,
   - zero-access paths,
   - repo jail,
   - protected file policy,
   - optional no-project-extension mode.
2. Update `scaffold/.github/actions/run-pi/action.yml` to call the wrapper.
3. Ensure the wrapper uses trusted runtime files from `.agentify-runtime`,
   not mutable PR-branch files.
4. Add tests that generated scaffold references the wrapper.
5. Add red-team fixture prompts for env dump, `.env` read, curl exfil,
   force push, and interpreter one-liners.

## Acceptance criteria

- CI Pi runs have the same or stricter tool-call defense as local audit.
- Write-capable workflows do not expose `AGENT_PAT` to the model process
  unless there is a documented reason and test coverage.
- Scaffold contract tests assert the hardened wrapper path.

## Validation

```bash
npm run typecheck
npm run test:unit
bash tests/run.sh
```
