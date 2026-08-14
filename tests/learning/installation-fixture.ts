import {
  acceptMemoryCandidate,
  proposeMemoryCandidate,
} from "../../src/core/memory/index.ts";
import { buildSpecialistEvidenceReference } from "../../src/core/specialists/index.ts";

export function installSelfUpdatePolicy(input: {
  cwd: string;
  supportingCommit: string;
  observedAt: string;
}): void {
  const evidence = buildSpecialistEvidenceReference({
    cwd: input.cwd,
    supportingCommit: input.supportingCommit,
    repositoryPath: "package.json",
    sourceType: "maintainer_instruction",
    observedAt: input.observedAt,
    actor: "test-installer",
  });
  const candidate = proposeMemoryCandidate({
    schema_version: "1",
    candidate_id: "installer-self-update-policy-v1",
    memory_id: "self-update-allowlist",
    kind: "policy",
    proposed_by_agent_id: "knowledge-maintainer",
    owning_agent_id: "knowledge-maintainer",
    statement: "Automatic learning is confined to versioned Agentify knowledge paths.",
    source_type: "maintainer_instruction",
    supporting_commit: input.supportingCommit,
    evidence: [evidence],
    confidence: "verified",
    dependent_paths: [".agentify/manifest.json"],
    invalidation_conditions: ["trusted installer upgrade changes the self-update boundary"],
    contradicts: [],
    human_attribution: {
      actor: "test-installer",
      source_ref: `installer:${input.supportingCommit}`,
      accepted_at: input.observedAt,
    },
    tags: ["policy", "self-update", "allowlist"],
    proposed_at: input.observedAt,
    payload: {
      policy_key: "self-update-allowlist",
      rule: "Automatic learning may update only the explicit knowledge allowlist.",
      protected_paths: [
        ".agentify/policies",
        ".agentify/runtime",
        ".agentify/state-transactions",
        ".github",
      ],
      allowed_tools: ["knowledge_memory_store"],
      forbidden_actions: [
        "modify application source",
        "modify dependencies",
        "modify workflows",
        "modify permissions",
        "modify protected policy",
        "modify executable runtime code",
      ],
      approval_required: true,
      numeric_limit: null,
      unit: null,
    },
  });
  acceptMemoryCandidate(
    input.cwd,
    candidate,
    "knowledge-maintainer",
    "install self-update policy fixture",
    { now: () => new Date(input.observedAt) },
  );
}
