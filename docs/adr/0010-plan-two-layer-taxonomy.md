# ADR 0010: Two-layer plan/spec taxonomy

Status: Accepted

## Context

"Plan" is overloaded. There is the greenfield planning ladder
(goals → PRDs → plans → issues) and there is the per-slice build spec
that precedes implementation. A single `/plan` command would collide
with the planning-ladder `/to-plan` step.

## Decision

Two distinct layers, two distinct commands:

- The **planning ladder** lives in `/to-goals`, `/to-prd`, `/to-plan`,
  `/to-issues` skills. It decomposes intent into executable issues.
- The **build spec** for a single slice is `/spec`. There is no
  `/plan` command; the build-spec command is `/spec`.

## Consequences

- The contract test asserts no `.agents/skills/plan` directory exists.
- `/spec` is a shipped skill; the audit does not regenerate it.
