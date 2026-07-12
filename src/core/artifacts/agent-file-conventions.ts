export const RESERVED_AGENT_NAMES = [
  "scout",
  "review",
  "implement",
  "test",
  "fix",
  "document",
] as const;

export const RESERVED_AGENT_FILENAMES: readonly string[] = RESERVED_AGENT_NAMES.map(
  (name) => `${name}.md`,
);

const RESERVED_AGENT_FILENAME_SET = new Set<string>(RESERVED_AGENT_FILENAMES);

export function isReservedAgentFilename(filename: string): boolean {
  return RESERVED_AGENT_FILENAME_SET.has(filename);
}

export function isFeatureAgentFilename(filename: string): boolean {
  return filename.endsWith(".md") && !isReservedAgentFilename(filename);
}
