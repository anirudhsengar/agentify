# Authorized issue lifecycle

This document is the authoritative contract for work initiated through GitHub
issues after Agentify installation.

## Intake

Trusted workflow code constructs a typed issue event. A task is analyzable only
when repository identity, issue state, actor, and event payload validate. It is
executable only when:

- the issue is open and explicitly queued;
- the actor is authorized by repository policy;
- acceptance criteria are concrete and testable;
- the expected base commit matches the current default-branch head;
- candidate paths do not violate protected-path policy;
- deterministic validation commands are available;
- no conflicting active task or pull request exists;
- the cost and retry budgets are sufficient.

The state machine persists every transition and rejects invalid, repeated, or
out-of-order mutations.

## Planning

Planning is a deterministic function of repository identity, issue criteria,
the structured map, current policies, selected specialists, relevant
procedures, and fresh memory, run twice around one model-backed refinement:

1. A first deterministic pass produces a draft plan from the issue's
   regex-parsed acceptance criteria. This draft is never recorded as the
   task's plan; it exists only to give the planner a reproducible digest to
   key its model call against.
2. A read-only planner session receives the draft plan and decomposes
   ambiguous or compound acceptance criteria into concrete, independently
   verifiable implementation steps, flagging scope conflicts the deterministic
   parser cannot detect. It cannot mutate task state, approve the plan, or
   veto deterministic readiness; its output is advisory input to the next
   pass.
3. A second deterministic pass recomputes the plan with the planner's refined
   steps. This is the only plan that is ever recorded, and the only one whose
   digest binds approval, the builder request, validation, and publication.

Because the planner's model call is keyed off the first pass's reproducible
digest, retrying a crashed or interrupted planning phase recovers the same
durable result instead of creating a duplicate model call. Trusted code
validates the final plan before approving implementation.

## Role authority

| Role | Application source | Agentify knowledge | GitHub mutation |
| --- | --- | --- | --- |
| Orchestrator | read-only | read-only | none |
| Planner | read-only | read-only | none |
| Specialist | read-only | read-only | none |
| Builder | approved paths only | none | none |
| Reviewer | read-only | read-only | none |
| Knowledge maintainer | read-only | allowlisted paths only | none |
| Trusted workflow | validated repository operations | validated operations | bounded operations |

Exactly one builder is writable for a task. Its branch, roots, tools, commands,
protected paths, deadline, output cap, retries, budget, and lack of network
isolation are explicit. No model process receives GitHub write credentials.

## Implementation and validation

The builder receives bounded file context and structured tools: it may
inspect, write, replace text in, and delete files within the approved scope,
and run an admitted validation command as an advisory self-check, across
multiple turns up to a bounded turn budget. Its terminal action is always one
typed submission; trusted code applies nothing until that submission, and
mutations made through the live tools during the session are what the
terminal submission may declare it has already handled rather than
redeclaring. Trusted code captures the repository snapshot before and after
implementation, verifies the branch and expected base, rejects changes
outside approved paths, and records the diff digest.

The builder's in-session self-check is advisory only. The authoritative
pass/fail verdict always comes from a separate, later validation phase that
reruns the approved commands against the committed and pushed result, outside
the model session entirely.

Validation is selected from the maintainer-approved installed repository policy.
The controller rechecks the npm manifest, command-set, and lockfile hashes before
readiness and immediately before execution. It launches a fixed argv vector with
no direct shell option, but npm scripts may invoke shells and indirect programs.
Common credentials are removed from the child environment, and repository
mutation, output, runtime, and exit status are observed. OS sandboxing and
network isolation are not provided.

## Role-separated automated review

The reviewer receives the approved plan, acceptance criteria, diff, and validation
evidence. It has no application-source write tools and returns a strict verdict
with findings tied to paths, criteria, and severity.

A rejected result may return to the same builder only within the original path,
retry, cost, and time bounds. Scope expansion requires a new trusted plan and
authorization.

## Publication

Trusted code confirms the final state, branch ownership, current base, diff,
validation, and reviewer acceptance before publishing. It pushes the isolated
branch and creates or updates one draft pull request. Publication is idempotent.

The pull request remains unmerged. Agentify does not deploy and does not modify
the default branch. Human maintainers retain the final code-review and merge
decision.

## Recovery

Task state records reserve model calls and external mutations before execution.
After interruption, recovery reconciles repository and GitHub evidence with the
durable state machine. It never repeats a mutation merely because local output is
missing, and it never assumes success without verifiable external evidence.
