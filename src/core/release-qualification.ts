import {
  loadExpertOutcomeEvidenceFile,
  type ExpertOutcomeEvidenceReport,
  type ExpertOutcomeMode,
} from "./expert-outcome.ts";
import {
  loadSmokeEvidenceFiles,
  type SmokeEvidenceReport,
} from "./smoke-evidence.ts";

export interface ReleaseEvidenceInput {
  expectedRepo?: string;
  expectedCommit?: string;
  evidenceSince?: string;
  smokeEvidenceFiles: string[];
  expertOutcomeManifestPath?: string;
}

export interface ReleaseQualificationReport {
  passed: boolean;
  failures: string[];
  smoke: SmokeEvidenceReport;
  expertOutcome: ExpertOutcomeEvidenceReport | null;
}

const REQUIRED_EXPERT_OUTCOME_MODES: ExpertOutcomeMode[] = ["plan", "review", "refresh"];
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function qualifyReleaseEvidence(input: ReleaseEvidenceInput): ReleaseQualificationReport {
  const smoke = loadSmokeEvidenceFiles(input.smokeEvidenceFiles);
  const failures = [...smoke.failures];
  const expectedRepo = input.expectedRepo?.trim() ?? "";
  const expectedCommit = input.expectedCommit?.trim() ?? "";
  const evidenceSince = input.evidenceSince?.trim() ?? "";

  if (expectedRepo.length === 0) {
    failures.push("missing expected staged repository");
  } else if (!REPO_PATTERN.test(expectedRepo)) {
    failures.push(`expected staged repository must be owner/name: ${expectedRepo}`);
  } else if (smoke.repos.length === 1 && smoke.repos[0] !== expectedRepo) {
    failures.push(`smoke evidence repository ${smoke.repos[0]} does not match expected staged repository ${expectedRepo}`);
  }
  if (expectedCommit.length === 0) {
    failures.push("missing expected candidate commit");
  } else if (!COMMIT_SHA_PATTERN.test(expectedCommit)) {
    failures.push(`expected candidate commit must be a 40-character git SHA: ${expectedCommit}`);
  } else if (smoke.commitShas.length === 1 && smoke.commitShas[0]?.toLowerCase() !== expectedCommit.toLowerCase()) {
    failures.push(`smoke evidence commit ${smoke.commitShas[0]} does not match expected candidate commit ${expectedCommit}`);
  }
  const evidenceSinceMs = Date.parse(evidenceSince);
  if (evidenceSince.length === 0) {
    failures.push("missing evidence window");
  } else if (Number.isNaN(evidenceSinceMs)) {
    failures.push(`evidence window must be an ISO timestamp: ${evidenceSince}`);
  } else {
    for (const entry of smoke.evidence) {
      const completedAtMs = Date.parse(entry.completed_at);
      if (!Number.isNaN(completedAtMs) && completedAtMs < evidenceSinceMs) {
        failures.push(`${entry.gate} completed_at ${entry.completed_at} is before evidence window ${evidenceSince}`);
      }
    }
  }

  let expertOutcome: ExpertOutcomeEvidenceReport | null = null;
  if (input.expertOutcomeManifestPath === undefined || input.expertOutcomeManifestPath.trim().length === 0) {
    failures.push("missing expert outcome manifest");
  } else {
    expertOutcome = loadExpertOutcomeEvidenceFile(input.expertOutcomeManifestPath);
    const metadata = expertOutcome.metadata;
    if (metadata === null) {
      failures.push("missing expert outcome metadata");
    } else {
      if (REPO_PATTERN.test(expectedRepo) && metadata.repo !== expectedRepo) {
        failures.push(
          `expert outcome repository ${metadata.repo} does not match expected staged repository ${expectedRepo}`,
        );
      }
      if (COMMIT_SHA_PATTERN.test(expectedCommit) && metadata.commitSha.toLowerCase() !== expectedCommit.toLowerCase()) {
        failures.push(
          `expert outcome commit ${metadata.commitSha} does not match expected candidate commit ${expectedCommit}`,
        );
      }
      if (!Number.isNaN(evidenceSinceMs)) {
        const capturedAtMs = Date.parse(metadata.capturedAt);
        if (!Number.isNaN(capturedAtMs) && capturedAtMs < evidenceSinceMs) {
          failures.push(`expert outcome captured_at ${metadata.capturedAt} is before evidence window ${evidenceSince}`);
        }
      }
    }
    for (const result of expertOutcome.cases) {
      if (!result.passed) {
        failures.push(`expert outcome ${result.id} failed: ${result.reasons.join("; ")}`);
      }
    }
    const modes = new Set(expertOutcome.cases.map((result) => result.mode));
    for (const mode of REQUIRED_EXPERT_OUTCOME_MODES) {
      if (!modes.has(mode)) {
        failures.push(`missing expert outcome ${mode} case`);
      }
    }
    if (!expertOutcome.passed) {
      failures.push("expert outcome evidence did not pass");
    }
  }

  return {
    passed: smoke.passed && expertOutcome?.passed === true && failures.length === 0,
    failures,
    smoke,
    expertOutcome,
  };
}
