# Webhook HTTP security

Agentify's webhook server accepts externally supplied HTTP requests and converts
verified requests into queued, model-backed tasks. The server treats the HTTP
boundary, trigger registry, queue, and worker sandbox as separate trust layers.

## Request processing order

A configured trigger request is processed in this order:

1. route lookup;
2. coarse remote-address rate limit;
3. bounded body read;
4. HMAC verification;
5. replay lookup;
6. authenticated per-trigger rate limit;
7. replay identity recording;
8. payload parsing and match evaluation;
9. prompt resolution and queue append.

Invalid signatures never consume the authenticated trigger quota. Replayed valid
requests are rejected before that quota is consumed. The coarse pre-authentication
limit is intentionally separate and limits unauthenticated traffic by remote
address rather than by trigger identity.

## Authentication responses

The server logs signature-rejection details for operators, but clients receive
only:

```json
{ "error": "unauthorized" }
```

This prevents the endpoint from disclosing whether a signature was missing,
malformed, stale, or computed with the wrong secret.

## Replay protection

Every accepted signature receives an in-memory replay identity with a TTL.

When `delivery_id_header` is configured, its value and the trigger ID define the
identity. Otherwise Agentify hashes the trigger ID, signature-header value, and
configured timestamp-header value. Raw signatures and delivery IDs are not stored
in the cache.

The TTL is selected in this order:

1. `replay_window_seconds`;
2. `timestamp_max_age_seconds`;
3. 300 seconds.

A repeated identity returns HTTP `409` with `replay_detected`. Different delivery
IDs may carry identical payload bytes without being considered duplicates.

The cache is process-local. Deployments with multiple webhook-server instances
should place replay identities in a shared store before treating the subsystem as
horizontally scalable.

## Rate limits

The default pre-authentication limit is 120 requests per 60 seconds per remote
address. Operators can supply another limit or disable it through the server API.

The trigger registry's `rate_limit` remains the authenticated workload quota. It
is evaluated only after signature verification and replay rejection.

Both limiters are in-memory and reset when the server restarts.

## Reload endpoint

`POST /__reload__` is absent by default and returns `404`.

Enabling it requires both:

- a loopback bind address (`127.0.0.1`, `::1`, or `localhost`); and
- a non-empty administrator token.

The token may be supplied as `Authorization: Bearer <token>` or through
`X-Agentify-Admin-Token`. Comparison is constant-time. Failed attempts return a
generic `401` and are logged without the token value.

External management should use an authenticated local proxy or a process signal,
not expose the reload route directly.

## Task status

`GET /tasks/<id>` returns only public lifecycle fields:

- task ID;
- status;
- received, claimed, started, and ended timestamps.

It never returns trigger IDs, request metadata, repository paths, prompt
arguments, model selection, tool lists, result details, or internal error text.

## Worker boundary

A successfully queued request still does not grant repository mutation. Ordinary
webhook sessions use the `review-readonly` execution policy and reject shell or
write tools before the model runtime is called. See `SECURITY.md` for execution
policy details.

## Implementation references

- HTTP server: `src/core/webhook/server.ts`
- HTTP security helpers: `src/core/webhook/http-security.ts`
- Signature verification: `src/core/webhook/signature.ts`
- Trigger schema and replay options: `src/core/webhook/state.ts`
- Worker sandbox: `src/core/webhook/worker.ts`
- Black-box security tests: `tests/webhook/http-hardening.test.ts`
