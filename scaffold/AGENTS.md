<!-- agentify:managed -->
# Agentify repository team

Use GitHub issues with the `agentify:queue` label to request implementation.
Agentify plans with a read-only planner and repository-specific read-only
specialists, grants exactly one builder bounded write authority, validates
deterministically, obtains an role-separated automated read-only review, and
stops at an unmerged draft pull request.

Do not weaken `.github/agentify-task-policy.json`. Learned output is restricted
to Agentify-owned knowledge paths and may not modify application source,
dependencies, workflows, policy, or executable runtime code.
