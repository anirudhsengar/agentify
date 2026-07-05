// Loads the builder system prompt from disk. Cached after first read.
// The path is resolved relative to this module so source and npm
// installs both work.

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "prompts", "builder.md");

let cached: string | null = null;

export function loadBuilderPrompt(): string {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(PROMPT_PATH, "utf-8");
    return cached;
  } catch (err) {
    throw new Error(
      `Failed to read builder prompt at ${PROMPT_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
