/**
 * Command fields across the audit map, the specialist portfolio, and installer
 * discovery are free-form strings, so model output can put prose such as
 * `(none — pure JS ESM library, no build step)` where an argv line belongs.
 * Nothing downstream can execute prose, so it is rejected at every boundary
 * that persists a command.
 */
const NON_EXECUTABLE_COMMAND_PATTERN =
  /^(?:\(?\s*(?:none|n\/a|not applicable|no (?:build|test|lint|typecheck|validation)(?: step| command)?)\b)/i;

export function isExecutableCommandText(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0
    && !trimmed.includes("\0")
    && !/[\r\n]/.test(trimmed)
    && !NON_EXECUTABLE_COMMAND_PATTERN.test(trimmed);
}
