import type { ThinkingLevel } from "../types.ts";

let currentThinkingLevel: ThinkingLevel | "unknown" = "unknown";

export function setThinkingLevel(level: ThinkingLevel | "unknown"): void {
  currentThinkingLevel = level;
}

export function getThinkingLevel(): ThinkingLevel | "unknown" {
  return currentThinkingLevel;
}
