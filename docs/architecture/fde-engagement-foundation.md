# FDE engagement foundation

## Purpose

The engagement domain is a private internal foundation for recording a typed
Forward Deployed Engineering charter and moving it through a controlled delivery
lifecycle. It does not add a CLI or model-backed behavior.

## Storage and ownership

The caller supplies Agentify's resolved provider-scoped state directory. Each
charter is stored at `engagements/<engagementId>/charter.json` beneath that
directory. `src/core/engagement/schema/` owns the charter and status TypeBox
contracts; `state.ts` owns validated persistence and optimistic concurrency;
`transitions.ts` owns lifecycle rules.

## Lifecycle

The forward path is draft, qualified, auditing, mapped, prioritized, designing,
building, evaluating, shadow, draft pilot, pilot, measuring, and completed.
Evaluation and later rollout phases may return to the documented build or pilot
stage. Every active stage may stop, with a required reason. Completed and stopped
are terminal.

## Concurrency and persistence

Creation starts at revision 1. Updates and transitions require the expected
revision, increment it, and update the timestamp using an injectable clock.
Charters are schema-validated before writes and after reads. Persistence writes a
durable same-directory temporary file and atomically renames it, preserving the
previous charter if preparation fails. Malformed data is reported and never
silently repaired.

## Security boundaries

Engagement IDs use a narrow ASCII allowlist and reject absolute, separator,
traversal, and encoded forms. Resolved paths are checked to remain under the
supplied state directory. The domain performs no network access, model calls, or
writes outside established Agentify state. It is not exported by the package or
reachable through the public CLI and does not depend on experimental runtimes.

## Non-goals and follow-up

This milestone does not implement workflow maps, opportunity scoring, evaluation,
GitHub integration, scaffold behavior, or a UI. A follow-up milestone can add the
workflow-map domain and consume charters through an explicitly reviewed internal
composition root while retaining the same state and concurrency boundaries.
