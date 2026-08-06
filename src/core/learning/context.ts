import {
  listMemoryRecords,
  type EvidenceReference,
  type MemoryRecord,
} from "../memory/index.ts";
import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import { recordPaths, sortedUniqueStrings } from "../memory/serialization.ts";
import { pathMatchesScope } from "../specialists/discovery.ts";
import type {
  LearningContextRequest,
  LearningContextResult,
} from "./contracts.ts";
import { TeamMemoryError } from "../memory/contracts.ts";

function boundedMax(value: number | undefined): number {
  const resolved = value ?? 64;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 256) {
    throw new TeamMemoryError(
      "invalid_input",
      "learning context max_records must be an integer between 1 and 256",
    );
  }
  return resolved;
}

function pathRelevant(record: MemoryRecord, requestedPaths: ReadonlyArray<string>): boolean {
  if (requestedPaths.length === 0) return true;
  const paths = recordPaths(record);
  return requestedPaths.some((requested) =>
    paths.some((candidate) =>
      pathMatchesScope(requested, candidate) || pathMatchesScope(candidate, requested)
    )
  );
}

function specialistRelevant(
  record: MemoryRecord,
  specialistIds: ReadonlySet<string>,
): boolean {
  if (specialistIds.size === 0) return true;
  if (specialistIds.has(record.owning_agent_id)) return true;
  return record.tags.some((tag) =>
    tag.startsWith("specialist-")
    && specialistIds.has(tag.slice("specialist-".length))
  );
}

function priority(record: MemoryRecord): number {
  switch (record.kind) {
    case "policy": return 100;
    case "procedure": return 90;
    case "specialist": return 80;
    case "episode": return 70;
    case "codebase": return 60;
    case "orchestrator": return 50;
  }
}

export function buildLearningContext(
  cwd: string,
  request: LearningContextRequest = {},
): LearningContextResult {
  const paths = sortedUniqueStrings((request.candidate_paths ?? []).map((value) =>
    normalizeMemoryRepositoryPath(value, "learning context path")
  ));
  const specialistIds = new Set(sortedUniqueStrings(request.specialist_ids ?? []));
  const maxRecords = boundedMax(request.max_records);
  const records = listMemoryRecords(cwd)
    .filter((record) => request.include_inactive === true || record.freshness === "current")
    .filter((record) => pathRelevant(record, paths))
    .filter((record) => specialistRelevant(record, specialistIds))
    .sort((left, right) => {
      const byPriority = priority(right) - priority(left);
      if (byPriority !== 0) return byPriority;
      const byTime = right.updated_at.localeCompare(left.updated_at);
      return byTime !== 0 ? byTime : left.memory_id.localeCompare(right.memory_id);
    })
    .slice(0, maxRecords);
  const evidence = new Map<string, EvidenceReference>();
  for (const record of records) {
    for (const entry of record.evidence) evidence.set(entry.evidence_id, entry);
  }
  return {
    records,
    evidence: [...evidence.values()].sort((left, right) =>
      left.evidence_id.localeCompare(right.evidence_id)
    ),
    selected_specialist_ids: [...specialistIds].sort((left, right) =>
      left.localeCompare(right)
    ),
  };
}
