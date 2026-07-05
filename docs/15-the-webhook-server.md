# The webhook server (internal, parked)

Status: internal library code, not a public command. See
[ADR 0013](adr/0013-webhook-server.md). The **shipped** async loop is
the GitHub Actions scaffold ([ADR 0007](adr/0007-pi-as-the-ci-coding-harness.md)),
not this server. This document describes the webhook server as it
exists in the source for contributors and future maintainers.

## What it is

`src/core/webhook/` implements a local daemon that accepts signed HTTP
events and dispatches Pi work. One process owns three things
(`src/core/webhook/index.ts`):

- the HTTP listener (`server.ts`), default `127.0.0.1:8787`,
- a persistent JSONL task queue (`queue.ts`),
- a background worker loop (`worker.ts`), plus an AIW worker that shares
  the same queue.

`startDaemon()` writes a pid file under the config dir and handles
`SIGINT`/`SIGTERM` for graceful shutdown.

## Authentication

`signature.ts` verifies an HMAC (SHA-1 or SHA-256) over the raw body
using `crypto.timingSafeEqual`, tolerating the GitHub `sha256=` prefix.
Optional timestamp replay protection is available via
`timestamp_header` + `timestamp_max_age_seconds`. The secret is read
from the env var named in the trigger config. Requests failing
verification are rejected with `401`.

## Triggers

Triggers are loaded from `<cwd>/.agentify/webhooks.json` and
`~/.agentify/webhooks.json` (`trigger-registry.ts`). Each trigger maps
an HTTP path + event match to either a single-prompt Pi task or an AIW
workflow. See `.agentify/webhooks.example.json` in this repo for the
shape.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | trigger paths | Signed event ingress → queue |
| GET | `/healthz` | Liveness |
| GET | `/tasks/:id` | Task status |
| POST | `/__reload__` | Reload trigger registry |

## Why it is parked

There is no supported deployment story (tunnel, reverse proxy,
GitHub webhook registration) and the public `agentify` command never
starts the daemon. The scaffold reacts to the same GitHub events via
native Actions, which needs no always-on host. The webhook server is
kept as foundation code for a possible future unified control plane.

## Known gaps (if promoted)

- `/tasks/:id` and `/__reload__` are unauthenticated; they would need
  the same HMAC or a localhost token before exposure.
- No first-class deployment/supervisor.

These would be addressed by a superseding ADR before the server becomes
a supported entry point.
