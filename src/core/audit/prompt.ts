// Loads the focused builder system prompt from disk. Cached after first read.
// The path is resolved relative to this module so source and npm installs both work.
//
// State-dir templating: the on-disk `builder.md` uses `<stateDir>` only for
// canonical audit-state and recovery-evidence paths. `loadBuilderPrompt(stateDir)`
// substitutes the caller-owned location at runtime; focused production passes
// `.agentify/runtime/audit` explicitly.

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "prompts", "builder.md");

let cachedRaw: string | null = null;

function readRaw(): string {
  if (cachedRaw !== null) return cachedRaw;
  try {
    cachedRaw = fs.readFileSync(PROMPT_PATH, "utf-8");
    return cachedRaw;
  } catch (err) {
    throw new Error(
      `Failed to read builder prompt at ${PROMPT_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Load the builder prompt and substitute the explicitly supplied audit state directory. */
export function loadBuilderPrompt(stateDir: string): string {
  return readRaw().replace(/<stateDir>/g, stateDir);
}

/** Test seam: clear the cached raw text so subsequent loads re-read from disk. */
export function clearBuilderPromptCache(): void {
  cachedRaw = null;
}
