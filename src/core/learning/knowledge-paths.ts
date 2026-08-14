import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
import { AGENTIFY_INSTALLED_CONTROL_PATHS } from "../artifacts/managed-installation-paths.ts";
import type { AcceptedMergeChange } from "./contracts.ts";

export function isLearningManagedPath(relativePath: string): boolean {
  const normalized = normalizeMemoryRepositoryPath(relativePath, "learning update path");
  if (
    normalized === ".agentify/.gitignore"
    || normalized === ".agentify/manifest.json"
  ) {
    return true;
  }
  if (normalized.startsWith(".agentify/policies/")) return false;
  return normalized.startsWith(".agentify/agents/")
    || normalized.startsWith(".agentify/knowledge/")
    || normalized.startsWith(".agentify/history/");
}

export function isAgentifyManagedPath(relativePath: string): boolean {
  const normalized = normalizeMemoryRepositoryPath(relativePath, "Agentify managed path");
  return normalized.startsWith(".agentify/")
    || normalized.startsWith(".github/agentify/")
    || AGENTIFY_INSTALLED_CONTROL_PATHS.has(normalized);
}

function relevantChange(change: AcceptedMergeChange): AcceptedMergeChange | null {
  const currentManaged = isAgentifyManagedPath(change.path);
  const previousManaged = change.previous_path === null
    ? false
    : isAgentifyManagedPath(change.previous_path);
  if (currentManaged && (change.previous_path === null || previousManaged)) return null;
  if (!currentManaged && !previousManaged) return change;
  if (change.status === "copied" && currentManaged) return null;
  if (currentManaged && change.previous_path !== null && !previousManaged) {
    return {
      status: "deleted",
      path: change.previous_path,
      previous_path: null,
    };
  }
  return {
    status: "added",
    path: change.path,
    previous_path: null,
  };
}

export function applicationLearningChanges(
  changes: ReadonlyArray<AcceptedMergeChange>,
): AcceptedMergeChange[] {
  return changes
    .map(relevantChange)
    .filter((change): change is AcceptedMergeChange => change !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function isKnowledgeOnlyChange(changes: ReadonlyArray<AcceptedMergeChange>): boolean {
  return changes.length > 0 && changes.every((change) =>
    isLearningManagedPath(change.path)
    && (change.previous_path === null || isLearningManagedPath(change.previous_path))
  );
}
