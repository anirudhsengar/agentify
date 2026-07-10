// Loads the builder system prompt from disk. Cached after first read.
// The path is resolved relative to this module so source and npm
// installs both work.
//
// State-dir templating: the on-disk `builder.md` uses the literal
// placeholder `<stateDir>` in every path reference (audit state,
// feature-agent scratch, prompts, workflows, skills, etc.).
// `loadBuilderPrompt(stateDir)` substitutes the resolved state dir
// at call time so the LLM sees the actual destination rather than
// the legacy `.pi/agentify/` literal.

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

/**
 * Load the builder prompt and substitute the resolved state dir.
 * Pass `stateDir = ".pi/agentify"` for the legacy-pi behavior
 * (preserved for tests / fallback paths); production callers pass
 * the resolved state dir from `state-dir.ts::resolveCanonicalStateDir`.
 */
export function loadBuilderPrompt(stateDir: string = ".pi/agentify"): string {
  return readRaw().replace(/<stateDir>/g, stateDir);
}

/** Test seam: clear the cached raw text so subsequent loads re-read
 *  from disk (rarely useful; kept for symmetry with the original
 *  caching model). */
export function clearBuilderPromptCache(): void {
  cachedRaw = null;
}
