/**
 * Leaf predicates about repository facts, shared by the per-dimension coverage
 * gate and whole-map validation. Kept free of schema imports so neither side
 * creates an import cycle through the coverage dimension list.
 */
const BARE_GIT_REF = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._\/-]+(?<!\/)(?<!\.lock)$/;

/** True when the value is a git ref name and nothing else - no prose, no explanation. */
export function isBareGitRef(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 255 && BARE_GIT_REF.test(trimmed);
}

/** Directories that are never repository source, whatever the language. */
export const NEVER_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".tox",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".gradle", ".nx",
  "vendor/bundle", ".pnpm-store", ".yarn/cache", ".turbo",
]);

/** Environment variables that change how an interpreter loads or executes code. */
export const EXECUTION_ALTERING_ENV: ReadonlySet<string> = new Set([
  "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONSTARTUP", "PYTHONPATH",
  "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "BASH_ENV",
]);
