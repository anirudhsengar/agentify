# ADR 0001: In-process Pi session, no subprocess

Status: Accepted

## Context

agentify drives an LLM coding agent to audit a repository. The agent
harness is Pi (`@earendil-works/pi-coding-agent`). Pi can be invoked
two ways: as a subprocess (`pi -p ...`) or in-process via
`createAgentSession`.

A subprocess would require forwarding auth, streaming stdout/stderr,
parsing a text protocol, and managing a temp prompt file. It also
loses structured access to session events.

## Decision

The builder runs Pi **in-process** via `createAgentSession` from
`src/core/pi-sdk-runtime.ts`. No subprocess, no shim, no temp prompt
file, no auth forwarding. Session options are assembled in
`src/core/run-agentify.ts`; the system prompt is
`src/core/audit/prompts/builder.md`.

## Consequences

- We get structured `AgentSessionEvent` streams for logging and
  coverage tracking.
- Auth is reused directly through `AuthStorage`; keys never touch a
  child process argv.
- The runtime is abstracted behind the `AgentRuntime` interface
  (`src/core/types.ts`) so tests can inject a fake.
- Sub-agents (`spawn_explorer`) are also in-process for the same
  reasons.
