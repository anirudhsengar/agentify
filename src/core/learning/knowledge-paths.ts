import { normalizeMemoryRepositoryPath } from "../memory/paths.ts";
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

export function isKnowledgeOnlyChange(changes: ReadonlyArray<AcceptedMergeChange>): boolean {
  return changes.length > 0 && changes.every((change) =>
    isLearningManagedPath(change.path)
    && (change.previous_path === null || isLearningManagedPath(change.previous_path))
  );
}
